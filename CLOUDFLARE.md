# Déploiement sur Cloudflare (Worker unique)

Architecture retenue : **un seul Worker Cloudflare** qui
- sert le site statique depuis `public/` (binding `ASSETS`) ;
- régénère `data.json` toutes les 30 min (Cron Trigger) et le stocke dans **KV** ;
- sert `/data.json` depuis KV (`run_worker_first` → le Worker passe avant les assets).

Déploiement via l'**intégration Git de Cloudflare** (plus de GitHub Actions ;
chaque push redéploie). Tient sur le **plan gratuit**.

Fichiers concernés : `wrangler.toml`, `worker/index.js`, `scripts/build-data.mjs`
(logique partagée), `public/` (le site).

---

## 1. Prérequis
- Un compte Cloudflare (gratuit).
- Le repo sur GitHub (déjà le cas).
- Node installé en local (pour la création du namespace KV).

## 2. Installer les dépendances en local
```bash
npm install
```

## 3. Créer le namespace KV et coller son id
```bash
npx wrangler login                 # ouvre le navigateur pour autoriser
npx wrangler kv namespace create DATA
```
La commande affiche un `id`. Reportez-le dans `wrangler.toml` :
```toml
[[kv_namespaces]]
binding = "DATA"
id = "VOTRE_ID_ICI"
```
Committez ce changement (l'id KV n'est pas secret).

## 4. (Optionnel) Tester en local
```bash
npx wrangler dev
```
Puis ouvrez l'URL locale : le site doit s'afficher, et `…/data.json` renvoyer
le JSON (généré à la volée au premier appel si KV est vide).

## 5. Premier déploiement + intégration Git
Dans le dashboard Cloudflare : **Workers & Pages → Create → Workers →
Connect to Git** (« Import a repository »). Sélectionnez le repo `trempette`,
branche `main`. Cloudflare détecte `wrangler.toml` ; aucune commande de build
spécifique n'est nécessaire (il fait `npm install` puis `wrangler deploy`).

À chaque `git push` sur `main`, Cloudflare redéploie automatiquement.

> Alternative en ligne de commande : `npm run deploy` (= `wrangler deploy`).

## 6. Amorcer les données
KV est vide juste après le 1er déploiement. Deux options :
- attendre le prochain cron (≤ 30 min), **ou**
- ouvrir une fois `https://trempette.<votre-sous-domaine>.workers.dev/data.json`
  (le Worker génère et met en cache à la volée).

Le cron (`*/30 * * * *`) est actif dès le déploiement (déclaré dans `wrangler.toml`).

## 7. (Optionnel) Domaine personnalisé
Dans les réglages du Worker → **Custom Domains**, ajoutez p. ex. `trempette.ch`.
Sinon l'URL `…workers.dev` fonctionne très bien.

## 8. Bascule (couper GitHub) — une fois Cloudflare vérifié
Quand le site tourne bien sur Cloudflare :
1. Supprimer les workflows GitHub : `.github/workflows/update-data.yml` et
   `.github/workflows/pages.yml`.
2. Désactiver GitHub Pages (Settings → Pages → Source : None) — optionnel.
3. `public/data.json` n'est alors plus nécessaire dans le repo (KV fait foi) ;
   on peut le retirer du suivi git.

Tant que ce n'est pas fait, **les deux hébergements coexistent** : GitHub Pages
sert `public/` et Cloudflare sert le Worker — sans conflit.

---

## Limites du plan gratuit (à connaître)
Le Worker fait ~41 requêtes externes par cycle (1 open-meteo + 40 Alplakes, en
**séquentiel** car Alplakes throttle le parallèle). Le plan gratuit limite à
**50 sous-requêtes/invocation** et un **CPU court** ; on est donc en dessous,
mais sans marge pour des reprises (`TRIES = 1` dans `worker/index.js`). En cas
de cycle partiel occasionnel, la plage manquante est rattrapée au cycle suivant.

Pour une fiabilité maximale (reprises + grosse marge) : **Workers Paid (~5 $/mois)**
→ 1000 sous-requêtes, CPU étendu. Il suffit alors de passer `TRIES = 3` dans
`worker/index.js`.
