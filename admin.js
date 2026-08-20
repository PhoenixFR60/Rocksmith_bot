import { supabase, esc, toast } from "./db.js";

let user = null;
let channel = null;
let stream = null;

function slugify(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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
  setupPanel.style.display = "none";
  mainPanels.style.display = "block";
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
  const [streamRes, reqRes, libRes] = await Promise.all([
    supabase.from("streams").select("*").eq("channel_id", channel.id).order("started_at", { ascending: false }).limit(1),
    supabase.from("requests").select("*").eq("channel_id", channel.id).order("created_at"),
    supabase.from("song_library").select("*").eq("channel_id", channel.id).order("artist").order("title"),
  ]);
  stream = streamRes.data?.[0] || null;
  renderStreamControls();
  renderRequests(reqRes.data || []);
  renderLibrary(libRes.data || []);
}

function subscribeRealtime() {
  supabase.channel(`admin-${channel.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "requests", filter: `channel_id=eq.${channel.id}` }, refreshAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "streams", filter: `channel_id=eq.${channel.id}` }, refreshAll)
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
  if (!confirm("Terminer le live en cours ?")) return;
  const { error } = await supabase.from("streams").update({ status: "ended", ended_at: new Date().toISOString(), request_state: "closed" }).eq("id", stream.id);
  if (error) return toast(error.message, true);
  await refreshAll();
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

  pendingRequests.innerHTML = pending.length ? pending.map((r) => `
    <div class="ticket">
      <div class="body">
        <div class="song">${esc(r.artist)} - ${esc(r.title)}</div>
        <div class="meta">👤 ${esc(r.pseudo)}${r.tuning ? ` · ${esc(r.tuning)}` : ""}${r.note ? ` · "${esc(r.note)}"` : ""}</div>
      </div>
      <button type="button" class="small primary" data-accept="${r.id}">Accepter</button>
      <button type="button" class="small danger" data-reject="${r.id}">Refuser</button>
    </div>`).join("") : '<div class="empty">Aucune demande en attente.</div>';

  queuedRequests.innerHTML = queued.length ? queued.map((r, i) => `
    <div class="ticket">
      <div class="pos">${r.status === "playing" ? "▶" : `#${i + (queued[0]?.status === "playing" ? 0 : 1)}`}</div>
      <div class="body">
        <div class="song">${esc(r.artist)} - ${esc(r.title)}</div>
        <div class="meta">👤 ${esc(r.pseudo)} · ${r.status === "playing" ? "en cours" : "en file"}</div>
      </div>
      ${r.status === "queued" ? `<button type="button" class="small primary" data-play="${r.id}">Lancer</button>` : `<button type="button" class="small" data-finish="${r.id}">Terminer</button>`}
    </div>`).join("") : '<div class="empty">File vide.</div>';

  pendingRequests.querySelectorAll("[data-accept]").forEach((b) => b.onclick = () => acceptRequest(b.dataset.accept));
  pendingRequests.querySelectorAll("[data-reject]").forEach((b) => b.onclick = () => rejectRequest(b.dataset.reject));
  queuedRequests.querySelectorAll("[data-play]").forEach((b) => b.onclick = () => playRequest(b.dataset.play));
  queuedRequests.querySelectorAll("[data-finish]").forEach((b) => b.onclick = () => finishRequest(b.dataset.finish));
}

async function acceptRequest(id) {
  const { data: maxRow } = await supabase.from("requests").select("queue_position")
    .eq("channel_id", channel.id).eq("status", "queued").order("queue_position", { ascending: false }).limit(1).maybeSingle();
  const nextPos = (maxRow?.queue_position ?? 0) + 1;
  const { error } = await supabase.from("requests").update({ status: "queued", queue_position: nextPos }).eq("id", id);
  if (error) return toast(error.message, true);
  await refreshAll();
}

async function rejectRequest(id) {
  const reason = prompt("Raison du refus (optionnel) :") || null;
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
  libraryTable.innerHTML = rows.length ? `
    <table>
      <thead><tr><th>Morceau</th><th>Accordage</th><th>Statut</th><th></th></tr></thead>
      <tbody>
        ${rows.map((x) => `
          <tr>
            <td>${esc(x.artist)} - ${esc(x.title)}</td>
            <td class="muted">${esc(x.tuning || "—")}</td>
            <td>${x.is_blocked ? `<span class="muted">🚫 ${esc(x.blocked_reason || "Indisponible")}</span>` : "✅ Disponible"}</td>
            <td><button type="button" class="small" data-toggle="${x.id}" data-blocked="${x.is_blocked}">${x.is_blocked ? "Débloquer" : "Bloquer"}</button></td>
          </tr>`).join("")}
      </tbody>
    </table>` : '<div class="empty">Bibliothèque vide.</div>';

  libraryTable.querySelectorAll("[data-toggle]").forEach((b) => {
    b.onclick = async () => {
      const isBlocked = b.dataset.blocked === "true";
      let reason = null;
      if (!isBlocked) reason = prompt("Raison (optionnel) :") || "Indisponible";
      const { error } = await supabase.from("song_library")
        .update({ is_blocked: !isBlocked, blocked_reason: !isBlocked ? reason : null })
        .eq("id", b.dataset.toggle);
      if (error) return toast(error.message, true);
      await refreshAll();
    };
  });
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

boot();
