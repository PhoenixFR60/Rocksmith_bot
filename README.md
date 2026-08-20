# 🎸 Rocksmith Live — v0 (socle)

Reprise du projet sur une base saine. Ce socle couvre uniquement le
strict nécessaire pour qu'un live tourne :

- Channel + authentification admin (Supabase Auth)
- Bibliothèque de morceaux (CRUD simple, blocage avec raison)
- Requests PLAY via le site public (pas encore de TikTok, pas de LISTEN)
- Queue avec accepter / refuser / lancer / terminer
- Admin panel basique

Tout ce qui suit (Control Center repensé, LISTEN/MIXTE, Companion,
Performance Tracking, Mode Entraînement, Overlay, TikTok bot…) viendra
par itérations successives, en gardant ce socle stable comme fondation.

Le board Trello existant reste la mémoire/référence historique du
produit, sans obligation de s'y astreindre à la lettre pendant cette
reprise.

## Architecture

- Frontend : HTML / CSS / JS vanilla, hébergé sur GitHub Pages
- Backend : Supabase (Postgres, Row Level Security, RPC)
- Aucune donnée sensible dans `config.js` — seulement l'URL du projet
  et la clé publique (publishable key), protégées par RLS côté base.

## Pages

- `index.html` — vue publique (viewer) : bibliothèque, formulaire de
  request, file d'attente, morceau en cours. Accessible via
  `?channel=<slug>`.
- `admin.html` — panneau streamer : connexion, création du channel,
  contrôle du live (ouvrir/pause/fermer les demandes, démarrer/terminer
  le live), gestion des demandes, gestion de la bibliothèque.

## Base de données

4 tables : `channels`, `song_library`, `streams`, `requests`.
2 RPC publiques (`security definer`, exécutées par `anon`) pour ne
jamais exposer la table `requests` en lecture/écriture directe au
public : `submit_request_v0` et `public_queue_v0`.
