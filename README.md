# 🌊 Trempette

App web (PWA) **mobile-first** de consultation des températures des plages des
lacs romands : **Léman, Neuchâtel, Bienne, Morat, Joux**.

Eau (Alplakes / Eawag) + air & vent (open-meteo), pour chaque plage, avec
tendance de réchauffement de l'eau. Tri par lac / « plage la plus chaude » /
favoris, recherche, géolocalisation « plages les plus proches », vue détail.

## Architecture (0 €, sans serveur à maintenir)

Un **unique Worker Cloudflare** fait tout :

```
Worker Cloudflare « trempette »
   ├─ sert le site statique (public/, binding ASSETS)
   ├─ Cron Trigger toutes les 30 min  → régénère les données → KV
   │     ├─ Alplakes   → température de l'eau (pas de CORS → appel côté serveur)
   │     ├─ open-meteo → air + vent (un seul appel groupé)
   │     └─ interpolation linéaire à l'instant présent (+ tendance °C/h)
   └─ GET /data.json → renvoyé depuis KV (run_worker_first)
```

- **Pas de proxy, pas de backend.** L'app ne fait que lire `/data.json`.
- **Alplakes n'expose pas de CORS** → impossible à appeler depuis le navigateur,
  d'où le pré-calcul côté Worker (cron) stocké dans KV.
- **open-meteo** accepte le CORS, mais on le récupère aussi côté Worker pour
  n'avoir qu'un seul fichier à lire côté client.
- **Déploiement** : intégration Git Cloudflare (Workers Builds) — `git push` sur
  `main` → build + déploiement automatiques. Voir `CLOUDFLARE.md`.

## Détails techniques

- **Eau** : `GET /simulations/point/{model}/{lake}/{début}/{fin}/0.2/{lat}/{lng}?variables=temperature`
  (dates `YYYYmmddHHMM` UTC, profondeur ~0,2 m). Alplakes ne donne qu'un point
  toutes les ~3 h : on récupère une fenêtre ±4 h et on **interpole linéairement**
  à maintenant ; la pente donne la **tendance** (°C/h).
- **Modèles par lac** : Léman `delft3d-flow/geneva`, Neuchâtel `mitgcm/neuchatel`,
  Bienne `delft3d-flow/biel`, Morat `delft3d-flow/murten`, Joux `delft3d-flow/joux`.
  Liste complète : <https://alplakes-api.eawag.ch/simulations/metadata>.
- **Air & vent** : `current=temperature_2m,wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh`.
- **Plages** : catalogue dans `scripts/lakes.json` (points dans l'eau, au large).
- **Plan gratuit** : Alplakes throttle les appels parallèles → récupération
  séquentielle ; `TRIES=1` côté Worker pour rester sous la limite de 50
  sous-requêtes (passer à `TRIES=3` sur Workers Paid).

## Développement

```bash
npx wrangler dev              # Worker + site en local (http://localhost:8787)
npx wrangler dev --test-scheduled   # puis visiter /__scheduled pour tester le cron
node scripts/fetch-data.mjs   # (optionnel) régénère un data.json local
```

## Fichiers

| Fichier | Rôle |
|---|---|
| `public/` | App web (index.html, css/, js/, icons/, img/, sw.js, manifest) |
| `worker/index.js` | Worker : assets + cron + /data.json depuis KV |
| `wrangler.toml` | Config Worker (assets, KV, cron) |
| `scripts/lakes.json` | Catalogue lacs & plages (coordonnées) |
| `scripts/build-data.mjs` | Récupération + interpolation (partagé Node/Worker) |
| `scripts/fetch-data.mjs` | Régénération locale d'un `data.json` (utilitaire) |
| `CLOUDFLARE.md` | Guide de déploiement Cloudflare |

---

Données : Alplakes (Eawag) · open-meteo.com
