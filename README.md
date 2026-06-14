# 🌊 Temp'Lac

App web (PWA) **mobile-first** de consultation des températures des plages des
lacs romands : **Léman, Neuchâtel, Bienne, Morat, Joux**.

Eau (Alplakes / Eawag) + air & vent (open-meteo), pour chaque plage, avec
tendance de réchauffement de l'eau. Tri « plage la plus chaude », recherche,
favoris, vue détail.

## Architecture (0 €, sans backend)

```
GitHub Action (cron ~45 min)
   └─ node scripts/fetch-data.mjs
        ├─ Alplakes  → température de l'eau (pas de CORS → appel côté Action)
        ├─ open-meteo → air + vent (un seul appel groupé)
        ├─ interpolation linéaire à l'instant présent (+ tendance °C/h)
        └─ écrit data.json dans le repo
                 └─ commit/push si changement
GitHub Pages sert l'app statique → l'app lit data.json (fichier statique)
```

- **Pas de proxy, pas de serveur.** L'app ne fait que lire `data.json`.
- **Alplakes n'expose pas de CORS** → impossible à appeler depuis le navigateur,
  d'où le pré-calcul côté Action.
- **open-meteo** accepte le CORS, mais on le récupère aussi côté Action pour
  n'avoir qu'un seul fichier à lire côté client.
- `.nojekyll` présent pour que Pages serve les fichiers tels quels.

## Détails techniques

- **Eau** : `GET /simulations/point/{model}/{lake}/{début}/{fin}/0/{lat}/{lng}?variables=temperature`
  (dates `YYYYmmddHHMM` UTC). Alplakes ne donne qu'un point toutes les ~3 h :
  on récupère une fenêtre ±4 h et on **interpole linéairement** à maintenant ;
  la pente donne la **tendance** (°C/h).
- **Modèles par lac** : Léman `delft3d-flow/geneva`, Neuchâtel `mitgcm/neuchatel`,
  Bienne `delft3d-flow/biel`, Morat `delft3d-flow/murten`, Joux `delft3d-flow/joux`.
  Liste complète : <https://alplakes-api.eawag.ch/simulations/metadata>.
- **Air & vent** : `current=temperature_2m,wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh`.
- **Plages** : coordonnées dans `scripts/lakes.mjs` (point dans l'eau).

## Développement

```bash
node scripts/fetch-data.mjs   # régénère data.json
python3 -m http.server 8080   # puis ouvrir http://localhost:8080
```

## Mise en service (une fois)

1. **Settings → Pages** : Source = *GitHub Actions*.
2. **Settings → Actions → General** : *Workflow permissions* = *Read and write*.
3. Les workflows (`update-data`, `pages`) tournent ensuite tout seuls.

## Fichiers

| Fichier | Rôle |
|---|---|
| `scripts/lakes.mjs` | Lacs & plages (coordonnées) |
| `scripts/fetch-data.mjs` | Récupération + interpolation → `data.json` |
| `data.json` | Snapshot servi à l'app (généré) |
| `index.html` / `css/` / `js/` | App web |
| `sw.js`, `manifest.webmanifest` | PWA (offline + installable) |
| `.github/workflows/` | Cron de données + déploiement Pages |

## Idées / suite

Carte interactive, mini-courbe historique (nécessite d'archiver les snapshots),
géolocalisation « plage la plus proche ».

---

Données : Alplakes (Eawag) · open-meteo.com
