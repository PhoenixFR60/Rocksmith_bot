// Rocksmith Live v0 — Soumission de request (pipeline complet)
// -----------------------------------------------------------------------
// Remplace la RPC submit_request_v0 pour les channels utilisant le
// Smart Song Matcher. Pipeline :
//
//   1. Valide le channel / l'état du live (comme submit_request_v0)
//   2. Appelle song-matcher (artiste/titre → candidats + score)
//   3. Compare le meilleur candidat à la bibliothèque (non bloquée) et
//      à l'instrument actuellement actif + disponible
//   4. Décide :
//      - score ≥ 85% ET compatible  → auto-accepté, glissé dans la file
//      - un ou plusieurs candidats trouvés, sinon → laissé en attente
//        pour choix manuel du streamer (candidats stockés sur la demande)
//      - aucun candidat du tout      → refusé automatiquement, avec une
//        raison claire (le morceau est peut-être simplement absent du
//        catalogue, pas forcément mal orthographié)
//
// verify_jwt = false → appelée par n'importe quel viewer (anon), comme
// submit_request_v0.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AUTO_ACCEPT_THRESHOLD = 85;

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`REST ${path} → ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function normalize(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const body = await req.json();
    const channelSlug = String(body.channel_slug || "").trim();
    const pseudo = String(body.pseudo || "").trim();
    const artist = String(body.artist || "").trim();
    const title = String(body.title || "").trim();
    const tuning = String(body.tuning || "").trim();
    const instrumentText = String(body.instrument || "").trim();
    const note = String(body.note || "").trim();

    if (!channelSlug || !pseudo || !artist || !title) {
      return json({ result: "rejected", message: "Pseudo, artiste et titre sont obligatoires." }, 400);
    }

    // 1. Channel + stream
    const channels = await rest(`channels?slug=eq.${encodeURIComponent(channelSlug)}&is_public=eq.true&select=id`);
    const channel = channels?.[0];
    if (!channel) return json({ result: "rejected", message: "Channel introuvable." });

    const streams = await rest(`streams?channel_id=eq.${channel.id}&status=eq.live&order=started_at.desc&limit=1`);
    const stream = streams?.[0];
    if (!stream || stream.request_state !== "open") {
      return json({ result: "rejected", message: "Les demandes ne sont pas ouvertes actuellement." });
    }

    // 2. Matcher
    let candidates: any[] = [];
    let best: any = null;
    try {
      const matchRes = await fetch(`${SUPABASE_URL}/functions/v1/song-matcher`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          apikey: SERVICE_ROLE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ artist, title }),
      });
      if (matchRes.ok) {
        const data = await matchRes.json();
        candidates = data.candidates || [];
        best = data.best || null;
      }
    } catch {
      // Le matcher est indisponible : on continue quand même, la demande
      // part en attente manuelle plutôt que de bloquer le viewer.
    }

    // 3. Bibliothèque + instrument actif
    const library = await rest(
      `song_library?channel_id=eq.${channel.id}&is_blocked=eq.false&select=id,artist,title,song_library_instruments(instrument_id)`
    );
    const activeInstruments = await rest(
      `instruments?channel_id=eq.${channel.id}&is_active=eq.true&is_available=eq.true&select=id&limit=1`
    );
    const activeInstrumentId = activeInstruments?.[0]?.id || null;

    const targetArtist = best?.artist || artist;
    const targetTitle = best?.title || title;
    const matchedSong = (library || []).find(
      (s: any) => normalize(s.artist) === normalize(targetArtist) && normalize(s.title) === normalize(targetTitle)
    );
    const compatible = Boolean(
      matchedSong &&
      activeInstrumentId &&
      (matchedSong.song_library_instruments || []).some((l: any) => l.instrument_id === activeInstrumentId)
    );

    // 4. Décision
    let status: string;
    let rejectionReason: string | null = null;
    let queuePosition: number | null = null;

    if (best && best.score >= AUTO_ACCEPT_THRESHOLD && compatible) {
      status = "queued";
      const maxRows = await rest(
        `requests?channel_id=eq.${channel.id}&status=eq.queued&select=queue_position&order=queue_position.desc&limit=1`
      );
      queuePosition = (maxRows?.[0]?.queue_position ?? 0) + 1;
    } else if (candidates.length > 0) {
      status = "pending"; // choix manuel du streamer (étape 4)
    } else {
      status = "rejected";
      rejectionReason = "Aucune correspondance trouvée — le morceau n'est peut-être pas encore disponible.";
    }

    const inserted = await rest("requests", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        channel_id: channel.id,
        stream_id: stream.id,
        pseudo,
        artist,
        title,
        tuning: tuning || null,
        instrument: instrumentText || null,
        note: note || null,
        status,
        source: "web",
        rejection_reason: rejectionReason,
        queue_position: queuePosition,
        matcher_score: best?.score ?? null,
        matcher_candidates: candidates.length ? candidates : null,
      }),
    });

    const messages: Record<string, string> = {
      queued: "Demande envoyée et ajoutée directement à la file !",
      pending: "Demande envoyée — le streamer va vérifier la correspondance.",
      rejected: rejectionReason || "Demande refusée.",
    };

    return json({
      result: status === "rejected" ? "rejected" : "accepted",
      message: messages[status],
      request_id: inserted?.[0]?.id || null,
      status,
    });
  } catch (err) {
    return json({ result: "rejected", message: `Erreur : ${String(err)}` }, 500);
  }
});
