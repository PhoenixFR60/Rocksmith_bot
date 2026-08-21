import { supabase, esc, toast } from "./db.js";

let user = null;
let channel = null;
let stream = null;

function slugify(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// ---- Presets d'accordages par type + nombre de cordes ----
const TUNING_PRESETS = {
  "basse-4": ["EADG (standard)", "DADG (drop D)"],
  "basse-5": ["BEADG (standard 5)", "CEADG (drop)"],
  "basse-6": ["BEADGC (standard 6)"],
  "guitare-6": ["EADGBE (standard)", "DADGBE (drop D)", "D#G#C#F#A#D# (standard Eb)", "DGCFAD (standard D)", "CGCFAD (drop C)"],
  "guitare-7": ["BEADGBE (standard 7)", "AEADGBE (drop A)"],
  "guitare-8": ["F#BEADGBE (standard 8)"],
};

function stringCountOptions(type) {
  return type === "guitare" ? [6, 7, 8] : [4, 5, 6];
}

function refreshInstrumentFormOptions() {
  const type = instType.value;
  const counts = stringCountOptions(type);
  instStrings.innerHTML = counts.map((c) => `<option value="${c}">${c} cordes</option>`).join("");
  refreshTuningOptions();
}

function refreshTuningOptions() {
  const key = `${instType.value}-${instStrings.value}`;
  const presets = TUNING_PRESETS[key] || [];
  instTuning.innerHTML = presets.map((t) => `<option value="${t}">${t}</option>`).join("")
    + '<option value="__custom__">Custom…</option>';
  instTuningCustom.style.display = "none";
  instTuningCustom.value = "";
}

instType.addEventListener("change", refreshInstrumentFormOptions);
instStrings.addEventListener("change", refreshTuningOptions);
instTuning.addEventListener("change", () => {
  instTuningCustom.style.display = instTuning.value === "__custom__" ? "block" : "none";
});
refreshInstrumentFormOptions();

instrumentForm.onsubmit = async (e) => {
  e.preventDefault();
  const tuning = instTuning.value === "__custom__" ? instTuningCustom.value.trim() : instTuning.value;
  if (!tuning) return toast("Précise un accordage.", true);

  const { data: existing } = await supabase.from("instruments").select("id").eq("channel_id", channel.id).limit(1);
  const { error } = await supabase.from("instruments").insert({
    channel_id: channel.id,
    name: instName.value.trim() || null,
    type: instType.value,
    string_count: Number(instStrings.value),
    tuning,
    is_active: !existing?.length, // le premier instrument créé devient actif automatiquement
  });
  if (error) return toast(error.message, true);
  e.target.reset();
  refreshInstrumentFormOptions();
  await refreshAll();
};

function renderInstruments(rows) {
  instrumentsList.innerHTML = rows.length ? `<div class="lib-list">${rows.map((x) => `
    <div class="lib-row">
      <div class="info">
        <div class="title">${esc(x.name || `${x.type === "basse" ? "Basse" : "Guitare"} ${x.string_count} cordes`)}${x.is_active ? " · <span style=\"color:var(--ember)\">Actif</span>" : ""}</div>
        <div class="sub">${esc(x.type === "basse" ? "Basse" : "Guitare")} · ${x.string_count} cordes · ${esc(x.tuning)}</div>
      </div>
      <span class="badge-state ${x.is_available ? "ok" : "blocked"}">
        ${x.is_available ? "✅ Disponible" : `🚫 ${esc(x.unavailable_reason || "Indisponible")}`}
      </span>
      ${!x.is_active ? `<button type="button" class="small primary" data-activate="${x.id}">Activer</button>` : ""}
      <button type="button" class="small" data-toggle-avail="${x.id}" data-available="${x.is_available}">${x.is_available ? "Marquer indisponible" : "Marquer disponible"}</button>
      <button type="button" class="small danger" data-delete-inst="${x.id}">Supprimer</button>
    </div>`).join("")}</div>` : '<div class="empty">Aucun instrument configuré. Ajoute ton premier instrument ci-dessus.</div>';

  instrumentsList.querySelectorAll("[data-activate]").forEach((b) => {
    b.onclick = async () => {
      await supabase.from("instruments").update({ is_active: false }).eq("channel_id", channel.id).eq("is_active", true);
      const { error } = await supabase.from("instruments").update({ is_active: true }).eq("id", b.dataset.activate);
      if (error) return toast(error.message, true);
      await refreshAll();
    };
  });

  instrumentsList.querySelectorAll("[data-toggle-avail]").forEach((b) => {
    b.onclick = () => {
      const isAvailable = b.dataset.available === "true";
      if (!isAvailable) return toggleInstrumentAvailability(b.dataset.toggleAvail, false, null);
      if (b.dataset.formOpen) return;
      b.dataset.formOpen = "1";
      const row = b.closest(".lib-row");
      const box = document.createElement("div");
      box.className = "inline-confirm";
      box.style.flexBasis = "100%";
      box.innerHTML = `
        <p>Raison (optionnel) :</p>
        <input type="text" maxlength="200" placeholder="Ex : en réparation">
        <div class="row">
          <button type="button" class="small danger" data-do-unavail>Confirmer</button>
          <button type="button" class="small ghost" data-cancel-unavail>Annuler</button>
        </div>`;
      row.appendChild(box);
      const input = box.querySelector("input");
      input.focus();
      box.querySelector("[data-cancel-unavail]").onclick = () => { box.remove(); delete b.dataset.formOpen; };
      box.querySelector("[data-do-unavail]").onclick = () => toggleInstrumentAvailability(b.dataset.toggleAvail, true, input.value.trim() || "Indisponible");
    };
  });

  instrumentsList.querySelectorAll("[data-delete-inst]").forEach((b) => {
    b.onclick = () => {
      if (b.dataset.formOpen) return;
      b.dataset.formOpen = "1";
      const row = b.closest(".lib-row");
      const box = document.createElement("div");
      box.className = "inline-confirm";
      box.style.flexBasis = "100%";
      box.innerHTML = `
        <p>Supprimer définitivement cet instrument ?</p>
        <div class="row">
          <button type="button" class="small danger" data-do-delete-inst>Oui, supprimer</button>
          <button type="button" class="small ghost" data-cancel-delete-inst>Annuler</button>
        </div>`;
      row.appendChild(box);
      box.querySelector("[data-cancel-delete-inst]").onclick = () => { box.remove(); delete b.dataset.formOpen; };
      box.querySelector("[data-do-delete-inst]").onclick = async () => {
        const { error } = await supabase.from("instruments").delete().eq("id", b.dataset.deleteInst);
        if (error) return toast(error.message, true);
        await refreshAll();
      };
    };
  });
}

async function toggleInstrumentAvailability(id, blocked, reason) {
  const { error } = await supabase.from("instruments")
    .update({ is_available: !blocked, unavailable_reason: blocked ? reason : null })
    .eq("id", id);
  if (error) return toast(error.message, true);
  await refreshAll();
}

function initTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`panel-${btn.dataset.tab}`).classList.add("active");
    };
  });
}

async function boot() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    loginWrap.style.display = "block";
    adminWrap.style.display = "none";
    return;
  }
  user = session.user;
  loginWrap.style.display = "none";
  adminWrap.style.display = "block";
  await loadChannel();
}

loginForm.onsubmit = async (e) => {
  e.preventDefault();
  const { error } = await supabase.auth.signInWithPassword({ email: email.value, password: password.value });
  if (error) { loginResult.innerHTML = `<div class="notice error">${esc(error.message)}</div>`; return; }
  await boot();
};

signupBtn.onclick = async () => {
  if (!email.value || password.value.length < 6) { toast("Email + mot de passe (6+ caractères) requis.", true); return; }
  const { error } = await supabase.auth.signUp({ email: email.value, password: password.value });
  if (error) { loginResult.innerHTML = `<div class="notice error">${esc(error.message)}</div>`; return; }
  loginResult.innerHTML = `<div class="notice success">Compte créé. Connecte-toi (vérifie ta boîte mail si une confirmation est requise).</div>`;
};

logoutBtn.onclick = async () => {
  await supabase.auth.signOut();
  location.reload();
};

async function loadChannel() {
  const { data } = await supabase.from("channels").select("*").eq("owner_user_id", user.id).maybeSingle();
  if (!data) {
    setupPanel.style.display = "block";
    mainPanels.style.display = "none";
    return;
  }
  channel = data;
  channelName.textContent = `🎸 ${channel.display_name}`;
  settingsSlug.value = channel.slug;
  setupPanel.style.display = "none";
  mainPanels.style.display = "block";
  initTabs();
  await refreshAll();
  subscribeRealtime();
}

setupSlug.addEventListener("input", () => { setupSlug.value = slugify(setupSlug.value); });
setupForm.onsubmit = async (e) => {
  e.preventDefault();
  const { error } = await supabase.from("channels").insert({
    slug: slugify(setupSlug.value),
    display_name: setupName.value.trim(),
    owner_user_id: user.id,
  });
  if (error) { setupResult.innerHTML = `<div class="notice error">${esc(error.message)}</div>`; return; }
  await loadChannel();
};

async function refreshAll() {
  const [streamRes, reqRes, libRes, instRes] = await Promise.all([
    supabase.from("streams").select("*").eq("channel_id", channel.id).order("started_at", { ascending: false }).limit(1),
    supabase.from("requests").select("*").eq("channel_id", channel.id).order("created_at"),
    supabase.from("song_library").select("*").eq("channel_id", channel.id).order("artist").order("title"),
    supabase.from("instruments").select("*").eq("channel_id", channel.id).order("created_at"),
  ]);
  stream = streamRes.data?.[0] || null;
  renderStreamControls();
  renderRequests(reqRes.data || []);
  renderLibrary(libRes.data || []);
  renderInstruments(instRes.data || []);
}

function subscribeRealtime() {
  supabase.channel(`admin-${channel.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "requests", filter: `channel_id=eq.${channel.id}` }, refreshAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "streams", filter: `channel_id=eq.${channel.id}` }, refreshAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "instruments", filter: `channel_id=eq.${channel.id}` }, refreshAll)
    .subscribe();
}

// ---- Stream control ----

function renderStreamControls() {
  const live = stream?.status === "live";
  statusPill.textContent = live ? "🟢 Live" : "⚫ Hors live";
  statusPill.className = `status-pill ${live ? "live" : "closed"}`;

  if (!live) {
    streamControls.innerHTML = `<button type="button" class="primary" id="startStreamBtn">Démarrer un live</button>`;
    document.getElementById("startStreamBtn").onclick = startStream;
    return;
  }

  const states = ["open", "paused", "closed"];
  streamControls.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      ${states.map((s) => `<button type="button" data-state="${s}" class="${stream.request_state === s ? "primary" : ""}">${
        { open: "Ouvrir demandes", paused: "Mettre en pause", closed: "Fermer demandes" }[s]
      }</button>`).join("")}
    </div>
    <button type="button" class="danger small" id="endStreamBtn">Terminer le live</button>
  `;
  streamControls.querySelectorAll("[data-state]").forEach((btn) => {
    btn.onclick = () => setRequestState(btn.dataset.state);
  });
  document.getElementById("endStreamBtn").onclick = endStream;
}

async function startStream() {
  const { error } = await supabase.from("streams").insert({ channel_id: channel.id, status: "live", request_state: "closed" });
  if (error) return toast(error.message, true);
  await refreshAll();
}

async function endStream() {
  const box = document.createElement("div");
  box.className = "inline-confirm";
  box.innerHTML = `
    <p>Terminer le live en cours ? Cette action ferme aussi les demandes.</p>
    <div class="row">
      <button type="button" class="small danger" id="confirmEndBtn">Oui, terminer</button>
      <button type="button" class="small ghost" id="cancelEndBtn">Annuler</button>
    </div>`;
  streamControls.appendChild(box);
  document.getElementById("cancelEndBtn").onclick = () => box.remove();
  document.getElementById("confirmEndBtn").onclick = async () => {
    const { error } = await supabase.from("streams").update({ status: "ended", ended_at: new Date().toISOString(), request_state: "closed" }).eq("id", stream.id);
    if (error) return toast(error.message, true);
    await refreshAll();
  };
}

async function setRequestState(s) {
  const { error } = await supabase.from("streams").update({ request_state: s }).eq("id", stream.id);
  if (error) return toast(error.message, true);
  await refreshAll();
}

// ---- Requests ----

function renderRequests(all) {
  const pending = all.filter((r) => r.status === "pending");
  const queued = all.filter((r) => (r.status === "queued" || r.status === "playing")).sort((a, b) => {
    if (a.status === "playing") return -1;
    if (b.status === "playing") return 1;
    return (a.queue_position ?? 0) - (b.queue_position ?? 0);
  });

  pendingBadge.style.display = pending.length ? "inline-block" : "none";
  pendingBadge.textContent = pending.length;

  pendingRequests.innerHTML = pending.length ? pending.map((r) => `
    <div class="ticket">
      <div class="body">
        <div class="song">${esc(r.artist)} - ${esc(r.title)}</div>
        <div class="meta">👤 ${esc(r.pseudo)}${r.tuning ? ` · ${esc(r.tuning)}` : ""}${r.note ? ` · "${esc(r.note)}"` : ""}</div>
      </div>
      <div class="actions-inline">
        <button type="button" class="small primary" data-accept="${r.id}">Accepter</button>
        <button type="button" class="small danger" data-reject="${r.id}">Refuser</button>
      </div>
    </div>`).join("") : '<div class="empty">Aucune demande en attente.</div>';

  queuedRequests.innerHTML = queued.length ? queued.map((r, i) => `
    <div class="ticket ${r.status === "playing" ? "playing" : ""}">
      <div class="pos">${r.status === "playing" ? "▶" : `#${i + (queued[0]?.status === "playing" ? 0 : 1)}`}</div>
      <div class="body">
        <div class="song">${esc(r.artist)} - ${esc(r.title)}</div>
        <div class="meta">👤 ${esc(r.pseudo)} · ${r.status === "playing" ? "en cours" : "en file"}</div>
      </div>
      ${r.status === "queued" ? `<button type="button" class="small primary" data-play="${r.id}">Lancer</button>` : `<button type="button" class="small" data-finish="${r.id}">Terminer</button>`}
    </div>`).join("") : '<div class="empty">File vide.</div>';

  pendingRequests.querySelectorAll("[data-accept]").forEach((b) => b.onclick = () => acceptRequest(b.dataset.accept));
  pendingRequests.querySelectorAll("[data-reject]").forEach((b) => b.onclick = () => showRejectForm(b));
  queuedRequests.querySelectorAll("[data-play]").forEach((b) => b.onclick = () => playRequest(b.dataset.play));
  queuedRequests.querySelectorAll("[data-finish]").forEach((b) => b.onclick = () => finishRequest(b.dataset.finish));
}

function showRejectForm(btn) {
  if (btn.dataset.formOpen) return;
  btn.dataset.formOpen = "1";
  const ticket = btn.closest(".ticket");
  const box = document.createElement("div");
  box.className = "inline-confirm";
  box.innerHTML = `
    <p>Raison du refus (optionnel) :</p>
    <input type="text" maxlength="200" placeholder="Ex : déjà joué récemment">
    <div class="row">
      <button type="button" class="small danger" data-do-reject>Confirmer le refus</button>
      <button type="button" class="small ghost" data-cancel-reject>Annuler</button>
    </div>`;
  ticket.appendChild(box);
  const input = box.querySelector("input");
  input.focus();
  box.querySelector("[data-cancel-reject]").onclick = () => { box.remove(); delete btn.dataset.formOpen; };
  box.querySelector("[data-do-reject]").onclick = () => rejectRequest(btn.dataset.reject, input.value.trim() || null);
}

async function acceptRequest(id) {
  const { data: maxRow } = await supabase.from("requests").select("queue_position")
    .eq("channel_id", channel.id).eq("status", "queued").order("queue_position", { ascending: false }).limit(1).maybeSingle();
  const nextPos = (maxRow?.queue_position ?? 0) + 1;
  const { error } = await supabase.from("requests").update({ status: "queued", queue_position: nextPos }).eq("id", id);
  if (error) return toast(error.message, true);
  await refreshAll();
}

async function rejectRequest(id, reason) {
  const { error } = await supabase.from("requests").update({ status: "rejected", rejection_reason: reason }).eq("id", id);
  if (error) return toast(error.message, true);
  await refreshAll();
}

async function playRequest(id) {
  const { data: current } = await supabase.from("requests").select("*").eq("id", id).single();
  if (!current) return;
  // Termine ce qui était en cours avant de lancer le nouveau morceau.
  await supabase.from("requests").update({ status: "played" }).eq("channel_id", channel.id).eq("status", "playing");
  await supabase.from("requests").update({ status: "playing" }).eq("id", id);
  await supabase.from("streams").update({
    current_artist: current.artist, current_title: current.title, current_requester: current.pseudo,
  }).eq("id", stream.id);
  await refreshAll();
}

async function finishRequest(id) {
  await supabase.from("requests").update({ status: "played" }).eq("id", id);
  await supabase.from("streams").update({ current_artist: null, current_title: null, current_requester: null }).eq("id", stream.id);
  await refreshAll();
}

// ---- Library ----

function renderLibrary(rows) {
  libraryList.innerHTML = rows.length ? `<div class="lib-list">${rows.map((x) => `
    <div class="lib-row">
      <div class="info">
        <div class="title">${esc(x.artist)} - ${esc(x.title)}</div>
        <div class="sub">${esc(x.tuning || "Accordage non précisé")}${x.instrument ? ` · ${esc(x.instrument)}` : ""}</div>
      </div>
      <span class="badge-state ${x.is_blocked ? "blocked" : "ok"}">
        ${x.is_blocked ? `🚫 ${esc(x.blocked_reason || "Indisponible")}` : "✅ Disponible"}
      </span>
      <button type="button" class="small" data-toggle="${x.id}" data-blocked="${x.is_blocked}">${x.is_blocked ? "Débloquer" : "Bloquer"}</button>
    </div>`).join("")}</div>` : '<div class="empty">Bibliothèque vide. Ajoute ton premier morceau ci-dessus.</div>';

  libraryList.querySelectorAll("[data-toggle]").forEach((b) => {
    b.onclick = () => {
      const isBlocked = b.dataset.blocked === "true";
      if (isBlocked) return toggleBlock(b.dataset.toggle, false, null);
      if (b.dataset.formOpen) return;
      b.dataset.formOpen = "1";
      const row = b.closest(".lib-row");
      const box = document.createElement("div");
      box.className = "inline-confirm";
      box.style.flexBasis = "100%";
      box.innerHTML = `
        <p>Raison du blocage (optionnel) :</p>
        <input type="text" maxlength="200" placeholder="Ex : trop difficile pour l'instant">
        <div class="row">
          <button type="button" class="small danger" data-do-block>Confirmer le blocage</button>
          <button type="button" class="small ghost" data-cancel-block>Annuler</button>
        </div>`;
      row.appendChild(box);
      const input = box.querySelector("input");
      input.focus();
      box.querySelector("[data-cancel-block]").onclick = () => { box.remove(); delete b.dataset.formOpen; };
      box.querySelector("[data-do-block]").onclick = () => toggleBlock(b.dataset.toggle, true, input.value.trim() || "Indisponible");
    };
  });
}

async function toggleBlock(id, blocked, reason) {
  const { error } = await supabase.from("song_library")
    .update({ is_blocked: blocked, blocked_reason: blocked ? reason : null })
    .eq("id", id);
  if (error) return toast(error.message, true);
  await refreshAll();
}

libForm.onsubmit = async (e) => {
  e.preventDefault();
  const { error } = await supabase.from("song_library").insert({
    channel_id: channel.id,
    artist: libArtist.value.trim(),
    title: libTitle.value.trim(),
    tuning: libTuning.value.trim() || null,
    instrument: libInstrument.value.trim() || null,
  });
  if (error) return toast(error.message, true);
  e.target.reset();
  await refreshAll();
};

// ---- Matcher (mode test / dry-run) ----

matcherForm.onsubmit = async (e) => {
  e.preventDefault();
  matcherBtn.disabled = true;
  matcherResult.innerHTML = '<div class="skeleton skeleton-card"></div>';

  const { data, error } = await supabase.functions.invoke("song-matcher", {
    body: { artist: matcherArtist.value.trim(), title: matcherTitle.value.trim() },
  });

  matcherBtn.disabled = false;

  if (error) {
    matcherResult.innerHTML = `<div class="notice error">${esc(error.message)}</div>`;
    return;
  }
  if (data?.error) {
    matcherResult.innerHTML = `<div class="notice error">${esc(data.error)}</div>`;
    return;
  }

  const candidates = data.candidates || [];
  matcherResult.innerHTML = `
    ${candidates.length ? candidates.map((c) => `
      <div class="ticket ${c.score >= 85 ? "playing" : ""}">
        <div class="pos">${c.score}%</div>
        <div class="body">
          <div class="song">${esc(c.artist)} - ${esc(c.title)}</div>
          <div class="meta">Sources : ${c.sources.map(esc).join(", ")}</div>
        </div>
      </div>`).join("") : '<div class="empty">Aucune correspondance trouvée.</div>'}
    <div class="small muted" style="margin-top:10px">
      Statut des sources : ${Object.entries(data.source_status || {}).map(([k, v]) => `${esc(k)} → ${esc(v)}`).join(" · ")}
    </div>
    <details style="margin-top:10px">
      <summary class="small muted" style="cursor:pointer">Détails techniques (candidats bruts par source)</summary>
      <pre class="small muted" style="white-space:pre-wrap; margin-top:8px">${esc(JSON.stringify(data.raw_candidates || [], null, 2))}</pre>
    </details>
  `;
};

boot();
