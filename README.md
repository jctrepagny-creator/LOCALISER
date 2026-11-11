# Localiser

Suivi familial de la position des enfants, en temps réel quand un parent regarde la carte.

- **Enfants (iPhone)** : l'app gratuite [OwnTracks](https://owntracks.org) envoie leur position, configurée en scannant un QR code. Un widget SOS est créé avec l'app Raccourcis d'Apple. Aucun compte Apple développeur n'est nécessaire.
- **Parents et proches** : une app web installable (PWA), sur Android ou iPhone. On y trouve la carte en direct, l'historique sur 7 jours, les zones avec alertes d'arrivée et de départ, la batterie, le SOS et l'alerte « plus de nouvelles ».
- **Serveur** : Supabase (PostgreSQL, Realtime, Edge Functions), déployé automatiquement par GitHub Actions.

👉 **Pour installer : [docs/INSTALLATION.md](docs/INSTALLATION.md)**

## Architecture

```
iPhone enfant (OwnTracks, HTTP)
   │  POST position (auth Basic)         ◄── réponse : commandes (mode direct/éco, zones)
   ▼
Edge function `owntracks` ──► RPC svc_ingest_owntracks (PostgreSQL)
                                   │ positions, batterie, zones, alertes
                                   ▼
                         tables `children`, `locations`, `events`
                                   │ Supabase Realtime          │ déclencheur → pg_net
                                   ▼                            ▼
                     App parents (web/, carte Leaflet)    Edge function `notify` → Web Push
                     rpc `watch` toutes les 15 s  ──► « un parent regarde » ⇒ mode direct
```

- `supabase/migrations/` : schéma, sécurité (RLS), logique métier en SQL, tâches planifiées (pg_cron).
- `supabase/functions/` : `owntracks` (réception), `sos` (widget SOS), `notify` (notifications push), `push-key` (clés VAPID).
- `web/` : l'app des parents, sans étape de build. Les bibliothèques sont copiées dans `web/vendor/` : supabase-js 2.118.0, Leaflet 1.9.4, qrcode-generator 1.4.4.
- `supabase/tests/run_local.sh` : teste la migration et les scénarios (sécurité, zones, mode direct, SOS…) sur un PostgreSQL local.

## Mode direct

Quand un parent a l'app ouverte, celle-ci signale toutes les 15 s qu'il regarde. À chaque envoi d'un iPhone, le serveur répond avec une commande OwnTracks `setConfiguration` :

- mode déplacement, avec une position toutes les 5 s ou tous les 5 m, si un parent regarde ;
- sinon, le mode choisi pour l'enfant (économie ou réactif).

Le serveur ne peut pas réveiller un iPhone immobile : le passage en direct se fait au prochain envoi du téléphone (voir la documentation).
