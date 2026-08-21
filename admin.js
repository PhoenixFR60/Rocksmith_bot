import { supabase, esc, toast } from "./db.js";

let user = null;
let channel = null;
let stream = null;
let currentInstruments = []; // liste des instruments du channel, réutilisée par les formulaires bibliothèque
let allStreamsCache = [];

function slugify(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeTitle(s) {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[-_/]+/g, " ").replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

async function logEvent(eventType, description) {
  if (!channel) return;
  await supabase.from("activity_log").insert({
    channel_id: channel.id,
    stream_id: stream?.id || null,
    event_type: eventType,
    description,
  });
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
  const noneActive = rows.length > 0 && !rows.some((x) => x.is_active);
  instrumentsList.innerHTML = (noneActive ? '<div class="notice warn" style="margin-bottom:12px">⚠️ Aucun instrument actif — active-en un pour que le Matcher puisse vérifier la compatibilité des demandes.</div>' : "")
    + (rows.length ? `<div class="lib-list">${rows.map((x) => `
    <div class="lib-row">
      <div class="info">
        <div class="title">${esc(x.name || `${x.type === "basse" ? "Basse" : "Guitare"} ${x.string_count} cordes`)}${x.is_active ? " · <span style=\"color:var(--ember)\">Actif</span>" : ""}</div>
        <div class="sub">${esc(x.type === "basse" ? "Basse" : "Guitare")} · ${x.string_count} cordes · ${esc(x.tuning)}</div>
      </div>
      <span class="badge-state ${x.is_available ? "ok" : "blocked"}">
        ${x.is_available ? "✅ Disponible" : `🚫 ${esc(x.unavailable_reason || "Indisponible")}`}
      </span>
      ${!x.is_active && x.is_available ? `<button type="button" class="small primary" data-activate="${x.id}">Activer</button>` : ""}
      <button type="button" class="small" data-toggle-avail="${x.id}" data-available="${x.is_available}">${x.is_available ? "Marquer indisponible" : "Marquer disponible"}</button>
      <button type="button" class="small danger" data-delete-inst="${x.id}">Supprimer</button>
    </div>`).join("")}</div>` : '<div class="empty">Aucun instrument configuré. Ajoute ton premier instrument ci-dessus.</div>');

  instrumentsList.querySelectorAll("[data-activate]").forEach((b) => {
    b.onclick = async () => {
      await supabase.from("instruments").update({ is_active: false }).eq("channel_id", channel.id).eq("is_active", true);
      const { error } = await supabase.from("instruments").update({ is_active: true }).eq("id", b.dataset.activate).eq("is_available", true);
      if (error) return toast(error.message, true);
      const inst = currentInstruments.find((i) => i.id === b.dataset.activate);
      await refreshAll();
      await logEvent("instrument_activated", `Instrument activé : ${inst ? instrumentLabel(inst) : b.dataset.activate}`);
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
  // Marquer un instrument indisponible le désactive aussi automatiquement :
  // "actif + indisponible" en même temps bloquerait silencieusement
  // l'auto-acceptation du matcher sans que ce soit visible pour le streamer.
  const inst = currentInstruments.find((i) => i.id === id);
  const update = { is_available: !blocked, unavailable_reason: blocked ? reason : null };
  if (blocked) update.is_active = false;
  const { error } = await supabase.from("instruments").update(update).eq("id", id);
  if (error) return toast(error.message, true);
  await refreshAll();
  await logEvent("instrument_availability", `${inst ? instrumentLabel(inst) : id} : ${blocked ? `marqué indisponible${reason ? ` (${reason})` : ""}` : "marqué disponible"}`);
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
  const [streamRes, reqRes, libRes, instRes, allStreamsRes, logsRes] = await Promise.all([
    supabase.from("streams").select("*").eq("channel_id", channel.id).order("started_at", { ascending: false }).limit(1),
    supabase.from("requests").select("*").eq("channel_id", channel.id).order("created_at"),
    supabase.from("song_library").select("*, song_library_instruments(instrument_id)").eq("channel_id", channel.id).order("artist").order("title"),
    supabase.from("instruments").select("*").eq("channel_id", channel.id).order("created_at"),
    supabase.from("streams").select("id,started_at").eq("channel_id", channel.id).order("started_at", { ascending: false }),
    supabase.from("activity_log").select("*").eq("channel_id", channel.id).order("created_at", { ascending: false }),
  ]);
  stream = streamRes.data?.[0] || null;
  currentInstruments = instRes.data || [];
  allStreamsCache = allStreamsRes.data || [];
  renderStreamControls();
  renderRequests(reqRes.data || []);
  renderLibrary(libRes.data || []);
  renderInstruments(currentInstruments);
  renderLibraryInstrumentCheckboxes();
  renderLogs(logsRes.data || []);
}

function subscribeRealtime() {
  supabase.channel(`admin-${channel.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "requests", filter: `channel_id=eq.${channel.id}` }, refreshAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "streams", filter: `channel_id=eq.${channel.id}` }, refreshAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "instruments", filter: `channel_id=eq.${channel.id}` }, refreshAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "activity_log", filter: `channel_id=eq.${channel.id}` }, refreshAll)
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
  await logEvent("stream_start", "Live démarré");
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
    const endedStreamId = stream.id;
    const { error } = await supabase.from("streams").update({ status: "ended", ended_at: new Date().toISOString(), request_state: "closed" }).eq("id", stream.id);
    if (error) return toast(error.message, true);
    await refreshAll();
    await supabase.from("activity_log").insert({ channel_id: channel.id, stream_id: endedStreamId, event_type: "stream_end", description: "Live terminé" });
  };
}

async function setRequestState(s) {
  const { error } = await supabase.from("streams").update({ request_state: s }).eq("id", stream.id);
  if (error) return toast(error.message, true);
  await refreshAll();
  await logEvent("request_state", `Demandes : ${{ open: "ouvertes", paused: "en pause", closed: "fermées" }[s]}`);
}

// ---- Requests ----

let allRequestsCache = [];

function renderRequests(all) {
  allRequestsCache = all;
  const pending = all.filter((r) => r.status === "pending");
  const missing = all.filter((r) => r.status === "missing");
  const queued = all.filter((r) => (r.status === "queued" || r.status === "playing")).sort((a, b) => {
    if (a.status === "playing") return -1;
    if (b.status === "playing") return 1;
    return (a.queue_position ?? 0) - (b.queue_position ?? 0);
  });

  missingSongsWrap.style.display = missing.length ? "block" : "none";
  missingSongs.innerHTML = missing.map((r) => `
    <div class="ticket">
      <div class="body">
        <div class="song">${esc(r.artist)} - ${esc(r.title)}</div>
        <div class="meta">👤 ${esc(r.pseudo)} · confirmé, morceau à ajouter à la bibliothèque</div>
      </div>
      <button type="button" class="small danger" data-clear-missing="${r.id}">Retirer</button>
    </div>`).join("");
  missingSongs.querySelectorAll("[data-clear-missing]").forEach((b) => {
    b.onclick = async () => {
      const { error } = await supabase.from("requests").update({ status: "rejected", rejection_reason: "Morceau non ajouté à la bibliothèque" }).eq("id", b.dataset.clearMissing);
      if (error) return toast(error.message, true);
      await refreshAll();
    };
  });

  pendingBadge.style.display = pending.length ? "inline-block" : "none";
  pendingBadge.textContent = pending.length;

  pendingRequests.innerHTML = pending.length ? pending.map((r) => `
    <div class="ticket">
      <div class="body" style="flex-direction:column; align-items:stretch">
        <div style="display:flex; align-items:center; gap:12px">
          <div style="flex:1">
            <div class="song">${esc(r.artist)} - ${esc(r.title)}</div>
            <div class="meta">👤 ${esc(r.pseudo)}${r.tuning ? ` · ${esc(r.tuning)}` : ""}${r.note ? ` · "${esc(r.note)}"` : ""}</div>
          </div>
          <div class="actions-inline">
            <button type="button" class="small primary" data-accept="${r.id}">Accepter tel quel</button>
            <button type="button" class="small danger" data-reject="${r.id}">Refuser</button>
          </div>
        </div>
        ${(r.matcher_candidates || []).length ? `
          <div class="small muted" style="margin-top:8px">🎯 Correspondances trouvées par le Matcher :</div>
          <div style="display:flex; flex-direction:column; gap:6px; margin-top:4px">
            ${r.matcher_candidates.map((c, i) => `
              <div class="lib-row" style="padding:8px 10px">
                <div class="info">
                  <div class="title small">${esc(c.artist)} - ${esc(c.title)}</div>
                  <div class="sub small">${c.score}% · ${(c.sources || []).map(esc).join(", ")}</div>
                </div>
                <button type="button" class="small primary" data-choose-candidate="${r.id}" data-candidate-index="${i}">Choisir</button>
              </div>`).join("")}
          </div>` : ""}
      </div>
    </div>`).join("") : '<div class="empty">Aucune demande en attente.</div>';

  const queuedOnly = queued.filter((r) => r.status === "queued");
  queuedRequests.innerHTML = queued.length ? queued.map((r, i) => {
    const qIndex = queuedOnly.findIndex((q) => q.id === r.id);
    const canMoveUp = r.status === "queued" && qIndex > 0;
    const canMoveDown = r.status === "queued" && qIndex < queuedOnly.length - 1 && qIndex !== -1;
    return `
    <div class="ticket ${r.status === "playing" ? "playing" : ""}">
      <div class="pos">${r.status === "playing" ? "▶" : `#${i + (queued[0]?.status === "playing" ? 0 : 1)}`}</div>
      <div class="body">
        <div class="song">${esc(r.artist)} - ${esc(r.title)}${r.hype_count > 1 ? ` <span style="color:var(--ember)">🔥${r.hype_count}</span>` : ""}</div>
        <div class="meta">👤 ${esc(r.pseudo)} · ${r.status === "playing" ? "en cours" : "en file"}</div>
      </div>
      <div class="actions-inline">
        ${r.status === "queued" ? `
          <button type="button" class="small icon ghost" data-move-up="${r.id}" ${canMoveUp ? "" : "disabled"} title="Monter">↑</button>
          <button type="button" class="small icon ghost" data-move-down="${r.id}" ${canMoveDown ? "" : "disabled"} title="Descendre">↓</button>
          <button type="button" class="small primary" data-play="${r.id}">Lancer</button>
          <button type="button" class="small danger" data-cancel-queue="${r.id}">Annuler</button>
        ` : `<button type="button" class="small" data-finish="${r.id}">Terminer</button>`}
      </div>
    </div>`;
  }).join("") : '<div class="empty">File vide.</div>';

  pendingRequests.querySelectorAll("[data-accept]").forEach((b) => b.onclick = () => acceptRequest(b.dataset.accept));
  pendingRequests.querySelectorAll("[data-reject]").forEach((b) => b.onclick = () => showRejectForm(b));
  pendingRequests.querySelectorAll("[data-choose-candidate]").forEach((b) => {
    b.onclick = () => {
      const request = pending.find((r) => r.id === b.dataset.chooseCandidate);
      const candidate = request?.matcher_candidates?.[Number(b.dataset.candidateIndex)];
      if (!candidate) return;
      acceptRequest(b.dataset.chooseCandidate, candidate);
    };
  });
  queuedRequests.querySelectorAll("[data-play]").forEach((b) => b.onclick = () => playRequest(b.dataset.play));
  queuedRequests.querySelectorAll("[data-finish]").forEach((b) => b.onclick = () => finishRequest(b.dataset.finish));
  queuedRequests.querySelectorAll("[data-cancel-queue]").forEach((b) => {
    b.onclick = async () => {
      const target = queued.find((r) => r.id === b.dataset.cancelQueue);
      const { error } = await supabase.from("requests")
        .update({ status: "rejected", rejection_reason: "Retiré de la file par le streamer" })
        .eq("id", b.dataset.cancelQueue);
      if (error) return toast(error.message, true);
      await refreshAll();
      if (target) await logEvent("queue_removed", `Retiré de la file : ${target.artist} - ${target.title}`);
    };
  });
  queuedRequests.querySelectorAll("[data-move-up]").forEach((b) => {
    if (b.disabled) return;
    b.onclick = () => swapQueuePosition(b.dataset.moveUp, queuedOnly, -1);
  });
  queuedRequests.querySelectorAll("[data-move-down]").forEach((b) => {
    if (b.disabled) return;
    b.onclick = () => swapQueuePosition(b.dataset.moveDown, queuedOnly, 1);
  });

  renderHistory();
}

function renderHistory() {
  const filter = historyFilter.value;
  const history = allRequestsCache
    .filter((r) => ["played", "rejected", "merged"].includes(r.status))
    .filter((r) => !filter || r.status === filter)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const statusLabel = { played: "✅ Jouée", rejected: "🚫 Refusée", merged: "🔥 Fusionnée" };

  historyList.innerHTML = history.length ? history.map((r) => `
    <div class="request-card">
      <div style="flex:1">
        <div class="request-title">${esc(r.artist)} - ${esc(r.title)}</div>
        <div class="small muted">👤 ${esc(r.pseudo)} · ${statusLabel[r.status] || r.status}${r.rejection_reason ? ` — ${esc(r.rejection_reason)}` : ""} · ${new Date(r.created_at).toLocaleString("fr-FR")}</div>
      </div>
      <button type="button" class="small danger" data-delete-history="${r.id}">Supprimer</button>
    </div>`).join("") : '<div class="empty">Aucun historique.</div>';

  historyList.querySelectorAll("[data-delete-history]").forEach((b) => {
    b.onclick = async () => {
      const { error } = await supabase.from("requests").delete().eq("id", b.dataset.deleteHistory);
      if (error) return toast(error.message, true);
      await refreshAll();
    };
  });
}

historyFilter.addEventListener("change", renderHistory);

// ---- Logs (journal d'activité) ----

function renderLogs(logs) {
  if (!logs.length) {
    logsList.innerHTML = '<div class="empty">Aucun log.</div>';
    return;
  }
  const byStream = new Map();
  for (const l of logs) {
    const key = l.stream_id || "none";
    if (!byStream.has(key)) byStream.set(key, []);
    byStream.get(key).push(l);
  }
  // Ordonne les groupes par date du stream (plus récent en premier).
  const streamOrder = allStreamsCache.map((s) => s.id);
  const keys = [...byStream.keys()].sort((a, b) => {
    if (a === "none") return 1;
    if (b === "none") return -1;
    return streamOrder.indexOf(a) - streamOrder.indexOf(b);
  });

  logsList.innerHTML = keys.map((key) => {
    const entries = byStream.get(key);
    const s = allStreamsCache.find((st) => st.id === key);
    const label = s ? `Live du ${new Date(s.started_at).toLocaleString("fr-FR")}` : "Hors session";
    return `
      <div class="lib-row" style="flex-direction:column; align-items:stretch; margin-bottom:10px">
        <div style="display:flex; justify-content:space-between; align-items:center">
          <div class="title small">${esc(label)} <span class="muted">(${entries.length})</span></div>
          <button type="button" class="small danger" data-delete-stream-logs="${key}">Supprimer ce groupe</button>
        </div>
        <div style="margin-top:8px; display:flex; flex-direction:column; gap:4px">
          ${entries.map((l) => `
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px">
              <div class="small">${esc(l.description)} <span class="muted">— ${new Date(l.created_at).toLocaleString("fr-FR")}</span></div>
              <button type="button" class="small ghost icon" data-delete-log="${l.id}" title="Supprimer">✕</button>
            </div>`).join("")}
        </div>
      </div>`;
  }).join("");

  logsList.querySelectorAll("[data-delete-log]").forEach((b) => {
    b.onclick = async () => {
      await supabase.from("activity_log").delete().eq("id", b.dataset.deleteLog);
      await refreshAll();
    };
  });
  logsList.querySelectorAll("[data-delete-stream-logs]").forEach((b) => {
    b.onclick = async () => {
      const key = b.dataset.deleteStreamLogs;
      if (key === "none") {
        await supabase.from("activity_log").delete().eq("channel_id", channel.id).is("stream_id", null);
      } else {
        await supabase.from("activity_log").delete().eq("stream_id", key);
      }
      await refreshAll();
    };
  });
}

exportLogsBtn.onclick = async () => {
  const { data: logs } = await supabase.from("activity_log").select("*, streams(started_at)").eq("channel_id", channel.id).order("created_at", { ascending: false });
  const rows = (logs || []).map((l) => [
    l.streams?.started_at ? new Date(l.streams.started_at).toLocaleString("fr-FR") : "Hors session",
    new Date(l.created_at).toLocaleString("fr-FR"),
    l.event_type,
    l.description.replace(/"/g, '""'),
  ]);
  const csv = ["Stream,Date,Type,Description", ...rows.map((r) => r.map((v) => `"${v}"`).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rocksmith-logs-${channel.slug}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

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

async function acceptRequest(id, chosenCandidate) {
  let targetArtist, targetTitle;
  if (chosenCandidate) {
    targetArtist = chosenCandidate.artist;
    targetTitle = chosenCandidate.title;

    // Un candidat choisi ne va en file QUE s'il est réellement dans la
    // bibliothèque et compatible avec l'instrument actif+disponible —
    // sinon on le garde de côté (morceau probablement à télécharger).
    const [{ data: library }, { data: activeInst }] = await Promise.all([
      supabase.from("song_library").select("id,artist,title,song_library_instruments(instrument_id)").eq("channel_id", channel.id).eq("is_blocked", false),
      supabase.from("instruments").select("id").eq("channel_id", channel.id).eq("is_active", true).eq("is_available", true).limit(1),
    ]);
    const activeId = activeInst?.[0]?.id;
    const matched = (library || []).find((s) => normalizeTitle(s.artist) === normalizeTitle(targetArtist) && normalizeTitle(s.title) === normalizeTitle(targetTitle));
    const compatible = Boolean(matched && activeId && (matched.song_library_instruments || []).some((l) => l.instrument_id === activeId));

    if (!compatible) {
      const { error } = await supabase.from("requests")
        .update({ status: "missing", artist: targetArtist, title: targetTitle, matcher_score: chosenCandidate.score })
        .eq("id", id);
      if (error) return toast(error.message, true);
      toast("Morceau confirmé mais absent de la bibliothèque — conservé de côté.");
      await refreshAll();
      await logEvent("song_missing", `Confirmé mais absent de la bibliothèque : ${targetArtist} - ${targetTitle}`);
      return;
    }
  } else {
    const { data: current } = await supabase.from("requests").select("artist,title").eq("id", id).single();
    targetArtist = current?.artist;
    targetTitle = current?.title;
  }

  // Fusion "hype" : si le même morceau est déjà en file/en cours, on
  // n'ajoute pas une seconde entrée — on compte juste un vote de plus.
  const { data: dupes } = await supabase.from("requests").select("id,artist,title,hype_count")
    .eq("channel_id", channel.id).in("status", ["queued", "playing"]);
  const dup = (dupes || []).find((d) => normalizeTitle(d.artist) === normalizeTitle(targetArtist) && normalizeTitle(d.title) === normalizeTitle(targetTitle));

  if (dup) {
    await supabase.from("requests").update({ hype_count: (dup.hype_count || 1) + 1 }).eq("id", dup.id);
    const mergeUpdate = { status: "merged", merged_into: dup.id };
    if (chosenCandidate) { mergeUpdate.artist = targetArtist; mergeUpdate.title = targetTitle; }
    const { error } = await supabase.from("requests").update(mergeUpdate).eq("id", id);
    if (error) return toast(error.message, true);
    toast("Déjà en file — fusionné avec un vote 🔥 en plus.");
    await refreshAll();
    await logEvent("hype_merged", `Vote 🔥 ajouté : ${targetArtist} - ${targetTitle}`);
    return;
  }

  const { data: maxRow } = await supabase.from("requests").select("queue_position")
    .eq("channel_id", channel.id).eq("status", "queued").order("queue_position", { ascending: false }).limit(1).maybeSingle();
  const nextPos = (maxRow?.queue_position ?? 0) + 1;
  const update = { status: "queued", queue_position: nextPos };
  if (chosenCandidate) {
    update.artist = chosenCandidate.artist;
    update.title = chosenCandidate.title;
    update.matcher_score = chosenCandidate.score;
  }
  const { error } = await supabase.from("requests").update(update).eq("id", id);
  if (error) return toast(error.message, true);
  await refreshAll();
  await logEvent("queue_added", `Ajouté à la file : ${targetArtist} - ${targetTitle}`);
}

async function rejectRequest(id, reason) {
  const { data: current } = await supabase.from("requests").select("artist,title").eq("id", id).single();
  const { error } = await supabase.from("requests").update({ status: "rejected", rejection_reason: reason }).eq("id", id);
  if (error) return toast(error.message, true);
  await refreshAll();
  if (current) await logEvent("request_rejected", `Demande refusée : ${current.artist} - ${current.title}${reason ? ` (${reason})` : ""}`);
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
  await logEvent("song_started", `Morceau lancé : ${current.artist} - ${current.title}`);
}

async function finishRequest(id) {
  const { data: current } = await supabase.from("requests").select("artist,title").eq("id", id).single();
  await supabase.from("requests").update({ status: "played" }).eq("id", id);
  await supabase.from("streams").update({ current_artist: null, current_title: null, current_requester: null }).eq("id", stream.id);
  await refreshAll();
  if (current) await logEvent("song_finished", `Morceau terminé : ${current.artist} - ${current.title}`);
}

async function swapQueuePosition(id, queuedOnly, direction) {
  const idx = queuedOnly.findIndex((q) => q.id === id);
  const neighbor = queuedOnly[idx + direction];
  if (!neighbor) return;
  const current = queuedOnly[idx];
  await Promise.all([
    supabase.from("requests").update({ queue_position: neighbor.queue_position }).eq("id", current.id),
    supabase.from("requests").update({ queue_position: current.queue_position }).eq("id", neighbor.id),
  ]);
  await refreshAll();
}

addToQueueForm.onsubmit = async (e) => {
  e.preventDefault();
  const artistVal = queueArtist.value.trim();
  const titleVal = queueTitle.value.trim();
  if (!artistVal || !titleVal) return;
  const { data: maxRow } = await supabase.from("requests").select("queue_position")
    .eq("channel_id", channel.id).eq("status", "queued").order("queue_position", { ascending: false }).limit(1).maybeSingle();
  const nextPos = (maxRow?.queue_position ?? 0) + 1;
  const { error } = await supabase.from("requests").insert({
    channel_id: channel.id,
    stream_id: stream?.id || null,
    pseudo: "Streamer",
    artist: artistVal,
    title: titleVal,
    status: "queued",
    source: "web",
    queue_position: nextPos,
  });
  if (error) return toast(error.message, true);
  e.target.reset();
  await refreshAll();
  await logEvent("queue_added_manual", `Ajouté manuellement à la file : ${artistVal} - ${titleVal}`);
};

// ---- Library ----

function instrumentLabel(i) {
  return `${i.name || `${i.type === "basse" ? "Basse" : "Guitare"} ${i.string_count} cordes`} — ${i.tuning}`;
}

function renderLibrary(rows) {
  libraryList.innerHTML = rows.length ? `<div class="lib-list">${rows.map((x) => {
    const linkedIds = (x.song_library_instruments || []).map((l) => l.instrument_id);
    const linkedNames = currentInstruments.filter((i) => linkedIds.includes(i.id)).map((i) => i.name || `${i.type === "basse" ? "Basse" : "Guitare"} ${i.string_count} cordes`);
    return `
    <div class="lib-row" data-row="${x.id}">
      <div class="info">
        <div class="title">${esc(x.artist)} - ${esc(x.title)}</div>
        <div class="sub">${esc(x.tuning || "Accordage non précisé")}${linkedNames.length ? ` · ${linkedNames.map(esc).join(", ")}` : ""}</div>
      </div>
      <span class="badge-state ${x.is_blocked ? "blocked" : "ok"}">
        ${x.is_blocked ? `🚫 ${esc(x.blocked_reason || "Indisponible")}` : "✅ Disponible"}
      </span>
      <button type="button" class="small" data-edit="${x.id}" data-artist="${esc(x.artist)}" data-title="${esc(x.title)}" data-tuning="${esc(x.tuning || "")}" data-linked="${linkedIds.join(",")}">Éditer</button>
      <button type="button" class="small" data-toggle="${x.id}" data-blocked="${x.is_blocked}">${x.is_blocked ? "Débloquer" : "Bloquer"}</button>
    </div>`;
  }).join("")}</div>` : '<div class="empty">Bibliothèque vide. Ajoute ton premier morceau ci-dessus.</div>';

  libraryList.querySelectorAll("[data-edit]").forEach((b) => {
    b.onclick = () => {
      if (b.dataset.formOpen) return;
      b.dataset.formOpen = "1";
      const row = b.closest(".lib-row");
      const linked = b.dataset.linked ? b.dataset.linked.split(",") : [];
      const box = document.createElement("div");
      box.className = "inline-confirm";
      box.style.flexBasis = "100%";
      box.innerHTML = `
        <div class="row">
          <input type="text" data-f-artist placeholder="Artiste" value="${b.dataset.artist}">
          <input type="text" data-f-title placeholder="Titre" value="${b.dataset.title}">
        </div>
        <input type="text" data-f-tuning placeholder="Accordage" value="${b.dataset.tuning}">
        <p style="margin-top:10px">Instruments compatibles :</p>
        <div class="checkbox-list" data-f-instruments>
          ${currentInstruments.length ? currentInstruments.map((i) => `
            <label>
              <input type="checkbox" value="${i.id}" ${linked.includes(i.id) ? "checked" : ""}>
              ${esc(instrumentLabel(i))}
            </label>`).join("") : '<div class="empty">Aucun instrument configuré.</div>'}
        </div>
        <div class="row" style="margin-top:10px">
          <button type="button" class="small primary" data-do-edit>Enregistrer</button>
          <button type="button" class="small ghost" data-cancel-edit>Annuler</button>
        </div>`;
      row.appendChild(box);
      box.querySelector("[data-f-artist]").focus();
      box.querySelector("[data-cancel-edit]").onclick = () => { box.remove(); delete b.dataset.formOpen; };
      box.querySelector("[data-do-edit]").onclick = async () => {
        const artist = box.querySelector("[data-f-artist]").value.trim();
        const title = box.querySelector("[data-f-title]").value.trim();
        const tuning = box.querySelector("[data-f-tuning]").value.trim();
        const selectedIds = [...box.querySelectorAll("[data-f-instruments] input:checked")].map((c) => c.value);
        if (!artist || !title) return toast("Artiste et titre sont obligatoires.", true);
        const { error } = await supabase.from("song_library")
          .update({ artist, title, tuning: tuning || null })
          .eq("id", b.dataset.edit);
        if (error) return toast(error.message, true);
        await supabase.from("song_library_instruments").delete().eq("song_id", b.dataset.edit);
        if (selectedIds.length) {
          const { error: linkError } = await supabase.from("song_library_instruments")
            .insert(selectedIds.map((instrument_id) => ({ song_id: b.dataset.edit, instrument_id })));
          if (linkError) return toast(linkError.message, true);
        }
        await refreshAll();
      };
    };
  });

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
  const { data: song } = await supabase.from("song_library").select("artist,title").eq("id", id).single();
  const { error } = await supabase.from("song_library")
    .update({ is_blocked: blocked, blocked_reason: blocked ? reason : null })
    .eq("id", id);
  if (error) return toast(error.message, true);
  await refreshAll();
  if (song) await logEvent("library_block", `${song.artist} - ${song.title} : ${blocked ? `bloqué${reason ? ` (${reason})` : ""}` : "débloqué"}`);
}

function renderLibraryInstrumentCheckboxes() {
  libInstrumentsCheckboxes.innerHTML = currentInstruments.length
    ? currentInstruments.map((i) => `
        <label>
          <input type="checkbox" value="${i.id}">
          ${esc(i.name || `${i.type === "basse" ? "Basse" : "Guitare"} ${i.string_count} cordes`)} — ${esc(i.tuning)}
        </label>`).join("")
    : '<div class="empty">Aucun instrument configuré (onglet Instruments).</div>';
}

libForm.onsubmit = async (e) => {
  e.preventDefault();
  const selectedIds = [...libInstrumentsCheckboxes.querySelectorAll("input:checked")].map((c) => c.value);
  const { data: inserted, error } = await supabase.from("song_library").insert({
    channel_id: channel.id,
    artist: libArtist.value.trim(),
    title: libTitle.value.trim(),
    tuning: libTuning.value.trim() || null,
  }).select().single();
  if (error) return toast(error.message, true);
  if (selectedIds.length) {
    const { error: linkError } = await supabase.from("song_library_instruments")
      .insert(selectedIds.map((instrument_id) => ({ song_id: inserted.id, instrument_id })));
    if (linkError) return toast(linkError.message, true);
  }
  e.target.reset();
  await refreshAll();
  await logEvent("library_added", `Ajouté à la bibliothèque : ${inserted.artist} - ${inserted.title}`);
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
