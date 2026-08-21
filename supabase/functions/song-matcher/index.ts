// Rocksmith Live v0 — Smart Song Matcher
// -----------------------------------------------------------------------
// Recherche un morceau (artiste/titre, potentiellement mal orthographié)
// à travers 5 sources musicales (MusicBrainz, iTunes, Deezer, Last.fm,
// Spotify), calcule un score de confiance en % par candidat, et renvoie
// les meilleures correspondances triées.
//
// Appel : POST { artist, title, dry_run? }
// verify_jwt = true → réservé aux utilisateurs authentifiés (admin) pour
// l'instant. Le déclenchement automatique depuis une vraie request
// publique sera branché dans une étape ultérieure (pipeline complet).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function restGet(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`REST ${path} → ${res.status}`);
  return res.json();
}

async function getCredentials(): Promise<Record<string, string>> {
  const rows = await restGet("api_credentials?select=key,value");
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

// ---------------------------------------------------------------------
// Normalisation & scoring
// ---------------------------------------------------------------------

function normalize(s: string): string {
  let t = (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bfeat\.?\b.*$/i, "");

  // Substitutions stylistiques courantes dans les titres (leetspeak) —
  // ex: "S!CK" utilise "!" à la place du "i", pas comme ponctuation à
  // supprimer. Uniquement entre deux lettres pour éviter les faux positifs.
  t = t.replace(/(?<=[a-z])!(?=[a-z])/gi, "i");
  t = t.replace(/(?<=[a-z])1(?=[a-z])/gi, "i");
  t = t.replace(/(?<=[a-z])0(?=[a-z])/gi, "o");
  t = t.replace(/(?<=[a-z])3(?=[a-z])/gi, "e");
  t = t.replace(/(?<=[a-z])\$(?=[a-z])/gi, "s");
  t = t.replace(/(?<=[a-z])@(?=[a-z])/gi, "a");

  // Tags de format de sortie ajoutés différemment selon les sources
  // (ex: iTunes ajoute souvent "- Single"/"(Radio Edit)" à un titre que
  // Deezer renvoie tel quel) — à supprimer pour que le regroupement
  // reconnaisse bien le même morceau entre sources.
  const tag = "(?:single|ep|album|radio edit|remaster(?:ed)?|bonus track|explicit|clean|official (?:audio|video|music video)|lyric video|mono|stereo|deluxe(?: edition)?|extended(?: mix)?)";
  t = t.replace(new RegExp(`\\s*[-–—]\\s*${tag}\\b.*$`, "i"), "");
  t = t.replace(new RegExp(`\\s*[([]${tag}[)\\]]`, "ig"), "");

  return t
    .replace(/[-_/]+/g, " ")       // vrais séparateurs de mots
    .replace(/[^a-z0-9\s]/g, "")   // ponctuation stylistique supprimée SANS espace (ex: "S!CK" → "sck", pas "s ck")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(s: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2));
  return grams;
}

// Coefficient de Dice sur bigrammes — tolérant aux fautes de frappe,
// simple et rapide, sans dépendance externe.
function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  if (!ga.length || !gb.length) return na === nb ? 1 : 0;
  const counts = new Map<string, number>();
  for (const g of ga) counts.set(g, (counts.get(g) || 0) + 1);
  let matches = 0;
  for (const g of gb) {
    const c = counts.get(g) || 0;
    if (c > 0) {
      matches++;
      counts.set(g, c - 1);
    }
  }
  return (2 * matches) / (ga.length + gb.length);
}

interface Candidate {
  artist: string;
  title: string;
  source: string;
  rank: number; // position dans les résultats de CETTE source (0 = meilleur résultat selon son propre moteur)
}

// ---------------------------------------------------------------------
// Sources — chacune tolère l'échec individuellement (Promise.allSettled)
// ---------------------------------------------------------------------

async function searchMusicBrainz(artist: string, title: string): Promise<Candidate[]> {
  const q = encodeURIComponent(`artist:"${artist}" AND recording:"${title}"`);
  const res = await fetch(`https://musicbrainz.org/ws/2/recording/?query=${q}&fmt=json&limit=5`, {
    headers: { "User-Agent": "RocksmithLive/0.1 (contact: admin@rocksmithlive.local)" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.recordings || []).map((r: any, i: number) => ({
    artist: r["artist-credit"]?.[0]?.name || "",
    title: r.title || "",
    source: "musicbrainz",
    rank: i,
  })).filter((c: Candidate) => c.artist && c.title);
}

async function searchItunes(artist: string, title: string): Promise<Candidate[]> {
  const term = encodeURIComponent(`${artist} ${title}`);
  const res = await fetch(`https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=5`);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map((r: any, i: number) => ({
    artist: r.artistName || "",
    title: r.trackName || "",
    source: "itunes",
    rank: i,
  })).filter((c: Candidate) => c.artist && c.title);
}

async function searchDeezer(artist: string, title: string): Promise<Candidate[]> {
  const q = encodeURIComponent(`${artist} ${title}`);
  const res = await fetch(`https://api.deezer.com/search?q=${q}&limit=5`);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || []).map((r: any, i: number) => ({
    artist: r.artist?.name || "",
    title: r.title || "",
    source: "deezer",
    rank: i,
  })).filter((c: Candidate) => c.artist && c.title);
}

async function searchLastfm(artist: string, title: string, apiKey?: string): Promise<Candidate[]> {
  if (!apiKey) return [];
  const url = `http://ws.audioscrobbler.com/2.0/?method=track.search&track=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&api_key=${apiKey}&format=json&limit=5`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  const tracks = data.results?.trackmatches?.track;
  const list = Array.isArray(tracks) ? tracks : tracks ? [tracks] : [];
  return list.map((r: any, i: number) => ({
    artist: r.artist || "",
    title: r.name || "",
    source: "lastfm",
    rank: i,
  })).filter((c: Candidate) => c.artist && c.title);
}

let spotifyTokenCache: { token: string; expires: number } | null = null;

async function getSpotifyToken(clientId?: string, clientSecret?: string): Promise<string | null> {
  if (!clientId || !clientSecret) return null;
  if (spotifyTokenCache && spotifyTokenCache.expires > Date.now()) return spotifyTokenCache.token;
  const basic = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) return null;
  const data = await res.json();
  spotifyTokenCache = { token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return spotifyTokenCache.token;
}

async function searchSpotify(artist: string, title: string, clientId?: string, clientSecret?: string): Promise<Candidate[]> {
  const token = await getSpotifyToken(clientId, clientSecret);
  if (!token) return [];
  const q = encodeURIComponent(`track:${title} artist:${artist}`);
  const res = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=5`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.tracks?.items || []).map((r: any, i: number) => ({
    artist: r.artists?.[0]?.name || "",
    title: r.name || "",
    source: "spotify",
    rank: i,
  })).filter((c: Candidate) => c.artist && c.title);
}

// ---------------------------------------------------------------------
// Fusion + consensus
// ---------------------------------------------------------------------

function groupKey(c: Candidate): string {
  return `${normalize(c.artist)}|||${normalize(c.title)}`;
}

// Barème directement inspiré de l'ancien Smart Song Matcher (V22.x) :
// 3+ sources indépendantes d'accord = consensus plein ; 2 = fort ; 1 = faible.
function consensusFactor(sourceCount: number): number {
  if (sourceCount >= 3) return 1;
  if (sourceCount === 2) return 0.86;
  if (sourceCount === 1) return 0.55;
  return 0;
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = await req.json();
    const artist = String(body.artist || "").trim();
    const title = String(body.title || "").trim();
    if (!artist || !title) {
      return new Response(JSON.stringify({ error: "artist et title sont requis." }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const creds = await getCredentials();

    const results = await Promise.allSettled([
      searchMusicBrainz(artist, title),
      searchItunes(artist, title),
      searchDeezer(artist, title),
      searchLastfm(artist, title, creds.LASTFM_API_KEY),
      searchSpotify(artist, title, creds.SPOTIFY_CLIENT_ID, creds.SPOTIFY_CLIENT_SECRET),
    ]);

    const sourceStatus: Record<string, string> = {};
    const names = ["musicbrainz", "itunes", "deezer", "lastfm", "spotify"];
    const allCandidates: Candidate[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        sourceStatus[names[i]] = `ok (${r.value.length})`;
        allCandidates.push(...r.value);
      } else {
        sourceStatus[names[i]] = `erreur: ${r.reason?.message || r.reason}`;
      }
    });

    // Regroupe les candidats identiques (même artiste/titre normalisés)
    // pour calculer un bonus de consensus multi-source.
    const groups = new Map<string, { artist: string; title: string; ranksBySource: Map<string, number> }>();
    for (const c of allCandidates) {
      const key = groupKey(c);
      if (!groups.has(key)) groups.set(key, { artist: c.artist, title: c.title, ranksBySource: new Map() });
      const g = groups.get(key)!;
      const prevRank = g.ranksBySource.get(c.source);
      if (prevRank === undefined || c.rank < prevRank) g.ranksBySource.set(c.source, c.rank);
    }

    const input = { artist, title };
    const shortTitle = normalize(title).length <= 6;

    const scored = [...groups.values()].map((g) => {
      const titleSim = similarity(input.title, g.title);
      const artistSim = similarity(input.artist, g.artist);
      const stringScore = titleSim * 0.6 + artistSim * 0.4;

      // Qualité du classement propre de chaque source (rang 0 = son meilleur
      // résultat, souvent plus fiable que notre comparaison de texte locale
      // pour un titre court/tronqué), pondérée par le nombre de sources
      // indépendantes qui s'accordent sur ce même candidat.
      const ranks = [...g.ranksBySource.values()];
      const rankQuality = ranks.reduce((s, r) => s + 1 / (1 + r), 0) / ranks.length;
      const rankScore = rankQuality * consensusFactor(g.ranksBySource.size);

      // Sur un titre court, le consensus/classement inter-API pèse beaucoup
      // plus que la similarité de texte locale, structurellement faible sur
      // peu de caractères (équivalent du "Short Title Rescue" historique).
      let base = shortTitle ? rankScore * 0.85 + stringScore * 0.15 : stringScore * 0.7 + rankScore * 0.3;

      // Garde-fou : un mauvais artiste ne doit jamais remonter haut, même avec
      // un bon score de titre/consensus.
      if (artistSim < 0.5) base *= 0.3;

      return {
        artist: g.artist,
        title: g.title,
        sources: [...g.ranksBySource.keys()],
        score: Math.round(Math.min(base, 1) * 100),
      };
    }).sort((a, b) => b.score - a.score);

    const top = scored.slice(0, 5);

    return new Response(JSON.stringify({
      input,
      candidates: top,
      best: top[0] || null,
      auto_accept: top[0] ? top[0].score >= 85 : false,
      source_status: sourceStatus,
      raw_candidates: allCandidates, // diagnostic : ce que chaque source a réellement renvoyé, avant fusion
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
