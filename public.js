import { supabase, esc, getChannelSlug, toast } from "./db.js";

const slug = getChannelSlug();
let channel = null;
let library = [];
let librarySearchIndex = [];
let refreshTimer = null;

function libraryFiltered() {
  const s = (librarySearch.value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  if (!s) return library;
  return librarySearchIndex.filter((x) => x.searchText.includes(s)).map((x) => x.song);
}

function renderLibrary() {
  const rows = libraryFiltered();
  publicLibrary.innerHTML = rows.length
    ? rows.map((x) => `
      <div class="request-card" style="${x.is_blocked ? "opacity:0.55" : ""}">
        <div>${x.is_blocked ? "🚫" : "🎵"}</div>
        <div style="flex:1">
          <div class="request-title">${esc(x.artist)} - ${esc(x.title)}</div>
          <div class="small muted">${esc(x.tuning || "")}${x.instrument ? ` · ${esc(x.instrument)}` : ""}</div>
          ${x.is_blocked ? `<div class="small" style="color:var(--danger)">Indisponible${x.blocked_reason ? ` — ${esc(x.blocked_reason)}` : ""}</div>` : ""}
        </div>
        ${x.is_blocked ? "" : `<button type="button" class="small" data-fill="${x.id}">Utiliser</button>`}
      </div>`).join("")
    : '<div class="empty">Aucun morceau trouvé.</div>';

  publicLibrary.querySelectorAll("[data-fill]").forEach((btn) => {
    btn.onclick = () => {
      const song = library.find((s) => s.id === btn.dataset.fill);
      if (!song) return;
      artist.value = song.artist;
      title.value = song.title;
      tuning.value = song.tuning || "";
      instrument.value = song.instrument || "";
      requestForm.scrollIntoView({ behavior: "smooth", block: "center" });
      pseudo.focus();
    };
  });
}

function renderStatus(stream) {
  const live = stream?.status === "live";
  statusPill.textContent = live
    ? (stream.request_state === "open" ? "🟢 Demandes ouvertes" : stream.request_state === "paused" ? "🟡 En pause" : "🔴 Demandes fermées")
    : "⚫ Hors live";
  statusPill.className = `status-pill ${live && stream.request_state === "open" ? "live" : "closed"}`;

  submitBtn.disabled = !(live && stream.request_state === "open");
  publicMessage.textContent = submitBtn.disabled
    ? "Les demandes ne sont pas ouvertes pour le moment."
    : "";

  currentBox.className = stream?.current_title ? "now-playing" : "";
  currentBox.innerHTML = stream?.current_title
    ? `<div class="label">En cours</div>
       <div class="song">${esc(stream.current_artist)} - ${esc(stream.current_title)}</div>
       ${stream.current_requester ? `<div class="who">👤 demandé par ${esc(stream.current_requester)}</div>` : ""}`
    : '<div class="empty">Aucun morceau en cours.</div>';
}

function renderQueue(rows) {
  const items = (rows || []).filter((r) => r.status === "queued");
  queue.innerHTML = items.length
    ? items.map((x, i) => `
      <div class="ticket">
        <div class="pos">#${i + 1}</div>
        <div class="body">
          <div class="song">${esc(x.artist)} - ${esc(x.title)}</div>
          <div class="meta">👤 ${esc(x.pseudo)}${x.tuning ? ` · ${esc(x.tuning)}` : ""}</div>
        </div>
      </div>`).join("")
    : '<div class="empty">File vide.</div>';
}

async function load() {
  if (!slug) {
    brand.textContent = "🎸 Rocksmith Live";
    statusPill.style.display = "none";
    publicMessage.textContent = "";
    currentBox.innerHTML = '<div class="empty">Aucun channel précisé. Ajoute <code>?channel=le-slug-du-streamer</code> à l\'URL pour voir sa page.</div>';
    queue.innerHTML = "";
    publicLibrary.innerHTML = "";
    requestForm.style.display = "none";
    return;
  }
  try {
    const { data: c, error: ce } = await supabase
      .from("channels").select("*").eq("slug", slug).single();
    if (ce || !c) {
      brand.textContent = "🎸 Rocksmith Live";
      currentBox.innerHTML = '<div class="empty">Ce channel n\'existe pas ou n\'est plus public.</div>';
      queue.innerHTML = "";
      publicLibrary.innerHTML = "";
      requestForm.style.display = "none";
      return;
    }
    channel = c;
    brand.textContent = `🎸 ${c.display_name}`;

    const [streamRes, queueRes, libRes] = await Promise.all([
      supabase.from("streams").select("*").eq("channel_id", c.id).order("started_at", { ascending: false }).limit(1),
      supabase.rpc("public_queue_v0", { p_channel_slug: slug }),
      supabase.from("song_library").select("*").eq("channel_id", c.id).order("artist").order("title"),
    ]);

    renderStatus(streamRes.data?.[0] || null);
    renderQueue(queueRes.data || []);

    library = libRes.data || [];
    librarySearchIndex = library.map((song) => ({
      song,
      searchText: `${song.artist} ${song.title} ${song.tuning || ""} ${song.instrument || ""}`
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(),
    }));
    renderLibrary();
  } catch (err) {
    console.error("Public load error", err);
  }
}

requestForm.onsubmit = async (e) => {
  e.preventDefault();
  submitBtn.disabled = true;

  const { data, error } = await supabase.functions.invoke("submit-request", {
    body: {
      channel_slug: slug,
      pseudo: pseudo.value.trim(),
      artist: artist.value.trim(),
      title: title.value.trim(),
      tuning: tuning.value.trim(),
      instrument: instrument.value.trim(),
      note: note.value.trim(),
    },
  });

  if (error) {
    toast(error.message, true);
    result.innerHTML = "";
  } else {
    const r = data;
    const ok = r?.result !== "rejected";
    result.innerHTML = `<div class="notice ${ok ? "success" : "error"}">${esc(r?.message || "")}</div>`;
    if (ok) e.target.reset();
  }

  await load();
};

librarySearch.addEventListener("input", renderLibrary);

const realtime = supabase.channel(`public-${slug}`)
  .on("postgres_changes", { event: "*", schema: "public", table: "streams" }, load)
  .on("postgres_changes", { event: "*", schema: "public", table: "song_library" }, load)
  .subscribe();

refreshTimer = setInterval(load, 5000);

window.addEventListener("beforeunload", () => {
  if (refreshTimer) clearInterval(refreshTimer);
  supabase.removeChannel(realtime);
});

load();
