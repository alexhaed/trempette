// Catalogue des lacs romands et de leurs plages (côté Node).
//
// Les DONNÉES vivent dans lakes.json (pures, faciles à éditer/valider). Ce
// module les charge depuis le disque et réexpose l'aplatissement partagé.
// Le Worker Cloudflare, lui, importe lakes.json directement (pas de fs).
//
// Notes sur les données (lakes.json) :
//  - Chaque lac a son modèle Alplakes (`model` + `lake`). Liste des modèles :
//    https://alplakes-api.eawag.ch/simulations/metadata
//  - Les coordonnées de plage pointent un point AU LARGE (dans l'eau), pas le
//    rivage, pour que le modèle hydrodynamique renvoie une température valide.
//  - Léman : plages regroupées par `regions` ; les autres lacs ont directement
//    une liste `beaches`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { flattenLakes } from "./build-data.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const LAKES = JSON.parse(readFileSync(join(__dirname, "lakes.json"), "utf8"));

export function flattenBeaches() {
  return flattenLakes(LAKES);
}
