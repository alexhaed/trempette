// Catalogue des lacs romands et de leurs plages.
//
// Les DONNÉES vivent dans lakes.json (pures, faciles à éditer/valider). Ce
// module les charge et expose la logique d'aplatissement.
//
// Notes sur les données (lakes.json) :
//  - Chaque lac a son modèle Alplakes (`model` + `lake`). Liste des modèles :
//    https://alplakes-api.eawag.ch/simulations/metadata
//  - Les coordonnées de plage pointent un point AU LARGE (dans l'eau), pas le
//    rivage, pour que le modèle hydrodynamique renvoie une température valide.
//  - Léman : plages regroupées par `regions` (groupe régional) ; les autres
//    lacs ont directement une liste `beaches`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const LAKES = JSON.parse(readFileSync(join(__dirname, "lakes.json"), "utf8"));

// Aplatit la structure en une liste de plages, chacune portant les infos de
// son lac (et son groupe régional pour le Léman). id stable = lake+slug.
export function flattenBeaches() {
  const out = [];
  for (const lk of LAKES) {
    const groups = lk.regions
      ? lk.regions.map((r) => ({ group: r.group, beaches: r.beaches }))
      : [{ group: null, beaches: lk.beaches }];
    for (const g of groups) {
      for (const b of g.beaches) {
        const slug = b.name
          .toLowerCase()
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "");
        out.push({
          id: `${lk.lake}-${slug}`,
          name: b.name,
          lat: b.lat,
          lng: b.lng,
          lakeName: lk.name,
          model: lk.model,
          lake: lk.lake,
          group: g.group,
        });
      }
    }
  }
  return out;
}
