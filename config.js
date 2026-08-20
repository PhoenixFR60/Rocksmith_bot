/**
 * Configuration publique du frontend Rocksmith Live v0.
 *
 * IMPORTANT : ce fichier est chargé par le navigateur et publié sur GitHub.
 * Il ne doit donc contenir QUE des valeurs publiques.
 *
 * - SUPABASE_URL : publique
 * - SUPABASE_ANON_KEY : publique (clé anon/publishable, protégée par RLS côté base)
 * - service role, secret key, mot de passe DB, tokens privés : INTERDITS ici
 */
window.ROCKSMITH_CONFIG = {
  SUPABASE_URL: "https://mctnkppscyldnyqwbjza.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_OR4mU-3mr9yRuclodGc4zw_1N_U-n4k",
  SITE_NAME: "Rocksmith Live",
};
