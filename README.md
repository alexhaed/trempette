# 🌊 Trempette

**→ <https://trempette.alexhaederli.workers.dev/>**

App web (PWA) **mobile-first** de consultation des températures des plages des
lacs romands : **Léman, Neuchâtel, Bienne, Morat, Joux**.

Eau (Alplakes / Eawag) + air & vent (open-meteo), pour chaque plage, avec
tendance de réchauffement de l'eau. Tri par lac / « plage la plus chaude » /
favoris, recherche, géolocalisation « plages les plus proches », vue détail.

Sur le **Léman**, la température du modèle est **recalée en temps réel** par les
mesures in-situ des bouées LéXPLORE et Buchillon (voir « Correction de biais »).

## Architecture

Un **unique Worker Cloudflare** fait tout :

```
Worker Cloudflare « trempette »
   ├─ sert le site statique (public/, binding ASSETS)
   ├─ Cron Trigger toutes les 30 min  → régénère les données → KV
   │     ├─ Alplakes   → température de l'eau (pas de CORS → appel côté serveur)
   │     ├─ open-meteo → air + vent (un seul appel groupé)
   │     ├─ interpolation linéaire à l'instant présent (+ tendance °C/h)
   │     ├─ Léman : correction de biais via 2 bouées in-situ live (Datalakes)
   │     └─ historique du biais → KV (clé "history", pour le moniteur)
   ├─ GET /data.json → renvoyé depuis KV (run_worker_first)
   └─ /admin → back-office protégé (moniteur du biais + éditeur des plages)
```

- **Pas de proxy, pas de backend.** L'app ne fait que lire `/data.json`.
- **Alplakes n'expose pas de CORS** → impossible à appeler depuis le navigateur,
  d'où le pré-calcul côté Worker (cron) stocké dans KV.
- **open-meteo** accepte le CORS, mais on le récupère aussi côté Worker pour
  n'avoir qu'un seul fichier à lire côté client.
- **Déploiement** : intégration Git Cloudflare (Workers Builds) — `git push` sur
  `main` → build + déploiement automatiques.

## Détails techniques

- **Eau** : `GET /simulations/point/{model}/{lake}/{début}/{fin}/0.2/{lat}/{lng}?variables=temperature`
  (dates `YYYYmmddHHMM` UTC, profondeur ~0,2 m). Alplakes ne donne qu'un point
  toutes les ~3 h : on récupère une fenêtre (−6 h à +30 h) et on **interpole
  linéairement** à maintenant ; la pente donne la **tendance** (°C/h). Les
  simulations n'étant mises à jour qu'**1×/jour**, la fenêtre brute est mise en
  cache (KV `windows`) et n'est re-téléchargée qu'au nouveau run quotidien.
- **Modèles par lac** : Léman `delft3d-flow/geneva`, Neuchâtel `mitgcm/neuchatel`,
  Bienne `delft3d-flow/biel`, Morat `delft3d-flow/murten`, Joux `delft3d-flow/joux`.
  Liste complète : <https://alplakes-api.eawag.ch/simulations/metadata>.
- **Air & vent** : `current=temperature_2m,wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh`.
- **Plages** : catalogue dans `scripts/lakes.json` (points dans l'eau, au large).
- **Plan gratuit** : Alplakes throttle les appels parallèles → récupération
  séquentielle ; `TRIES=1` côté Worker pour rester sous la limite de 50
  sous-requêtes (passer à `TRIES=3` sur Workers Paid).

## Correction de biais (Léman)

Le modèle Alplakes a un biais qui **n'est pas constant** : il dérive selon la
saison et l'heure plutôt que de rester un décalage fixe — d'où l'intérêt de le
mesurer en direct. Nos observations 2026 au Léman (indicatives, sur 1 à 2 stations
et une seule saison) vont dans ce sens : modèle plutôt **trop froid au printemps**
(de l'ordre de +1 à +2 °C), tendant vers ~0 voire **légèrement trop chaud en début
d'été**, avec un **cycle jour/nuit** de l'ordre de 0,5 °C. Sur le Léman, on le
recale en temps réel à partir des **2 seules stations in-situ live du lac**, via
l'API **Datalakes** (Eawag — comme Alplakes, sans CORS → appel côté Worker) :

- **LéXPLORE** (au large de Pully) — chaîne de température, surface ~0,25 m ;
- **Buchillon** (Petit Lac) — série `wt1`, eau à 1 m.

Principe, à chaque cycle de cron :

1. à chaque bouée : `biais = mesure_in-situ − modèle Alplakes au même point`, le
   modèle étant interpolé à **l'heure de la mesure** (comparaison à temps égal) ;
2. chaque plage du Léman reçoit une correction par **pondération inverse de la
   distance** (IDW) des 2 biais :

   ```
   correction(plage) = Σᵢ (biaisᵢ / dᵢ²) ∕ Σᵢ (1 / dᵢ²)
   ```

   où `dᵢ` = distance plage ↔ bouée *i*. Le poids en `1/dᵢ²` fait que la bouée la
   plus proche domine : à mi-chemin ~50/50, deux fois plus proche d'une bouée
   ~80/20, et une plage éloignée des deux tend vers leur moyenne ;
3. `eau_corrigée = modèle + correction` (le **prochain point** de prévision est
   décalé du même offset ; la tendance, elle, est inchangée).

**Garde-fous** : une bouée est ignorée si sa mesure est périmée (>6 h), absente
(panne) ou donne un biais aberrant (>5 °C) ; si aucune bouée n'est exploitable, on
sert le modèle brut. La valeur modèle d'origine est conservée (`waterModel`).

**Limites** : 2 points au large → correction quasi-locale près d'une bouée, sinon
~moyenne du lac ; ne corrige **pas** le sur-réchauffement des hauts-fonds au bord
(aucune bouée ne le voit). Les autres lacs (Neuchâtel, Bienne, Morat, Joux) n'ont
pas de bouée → modèle brut.

## Back-office `/admin`

Protégé par un secret (`ADMIN_TOKEN`), `noindex`. Deux pages avec nav commune :

- **`/admin`** (= `/admin/correction`) — **Correction biais** : moniteur de
  l'historique (mesure vs modèle, biais et correction appliquée heure par heure).
  Source : clé KV `history`, un point compact par cycle, rétention 90 j.
- **`/admin/plages`** — éditeur du catalogue des plages (écrit dans KV
  `catalogue` → le run suivant rebâtit `data.json`).

## Développement

```bash
npx wrangler dev                    # Worker + site en local (http://localhost:8787)
npx wrangler dev --test-scheduled   # puis visiter /__scheduled pour tester le cron
```

## Fichiers

| Fichier | Rôle |
|---|---|
| `public/` | App web (index.html, css/, js/, icons/, img/, sw.js, manifest) |
| `worker/index.js` | Worker : assets + cron + /data.json + /admin, orchestration KV |
| `worker/correction.html` | Back-office : moniteur de la correction de biais (`/admin`) |
| `worker/plages.html` | Back-office : éditeur des plages (`/admin/plages`) |
| `wrangler.toml` | Config Worker (assets, KV, cron) |
| `scripts/lakes.json` | Catalogue lacs & plages (coordonnées) |
| `scripts/build-data.mjs` | Récupération Alplakes/open-meteo/Datalakes, interpolation, correction de biais IDW, historique |

---

Données : Alplakes (Eawag) · Datalakes (Eawag) · open-meteo.com
