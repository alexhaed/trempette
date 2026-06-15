// Pré-calcul de data.json, exécuté par la GitHub Action (transition) — écrit le
// fichier à la racine du repo. La logique de récupération/interpolation vit dans
// build-data.mjs (partagée avec le Worker Cloudflare).

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LAKES } from "./lakes.mjs";
import { buildPayload } from "./build-data.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "public", "data.json");

const payload = await buildPayload(LAKES, fetch, Date.now(), {
  // Séquentiel : Alplakes throttle les appels parallèles (6 en // → ~27/40 ;
  // séquentiel → 40/40). L'Action n'a pas de contrainte de temps.
  concurrency: 1,
  tries: 3,
  onProgress: (i, total, b, water, w) =>
    process.stdout.write(
      `[${i + 1}/${total}] ${b.name}: eau=${water.water ?? "–"}° air=${w.air ?? "–"}°\n`
    ),
});

await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(
  `\n✓ data.json écrit — ${payload.counts.water}/${payload.counts.total} plages avec température d'eau.`
);
