// Primitives portables de récupération des données (sans état, sans API Node).
// Utilisées par worker/index.js, qui orchestre le cache KV.
//
// Rappel : Alplakes (eau) n'envoie pas de CORS → fetch impossible côté
// navigateur, d'où ce pré-calcul côté serveur. open-meteo (air/vent) y est aussi
// récupéré pour que l'app n'ait qu'un seul fichier à lire.
//
// Les simulations Alplakes ne sont mises à jour qu'UNE fois par jour (confirmé
// par l'Eawag). Le Worker met donc en cache la fenêtre brute par plage et ne la
// re-télécharge que lorsqu'un nouveau run paraît (end_date avancé) ou que la
// fenêtre ne couvre plus l'instant présent ; entre-temps il réinterpole en local.

// Aplatit la structure des lacs en une liste de plages, chacune portant les
// infos de son lac (et son groupe régional pour le Léman).
// id STABLE : on prend `b.id` explicite (catalogue), pour que les favoris des
// utilisateurs survivent à un renommage ou changement de lac. Repli sur
// `lake+slug` pour les anciens catalogues sans id (rétro-compat).
export function flattenLakes(lakes) {
  const out = [];
  for (const lk of lakes) {
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
          id: b.id || `${lk.lake}-${slug}`,
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

const pad = (n) => String(n).padStart(2, "0");
const ymdhm = (d) =>
  d.getUTCFullYear() +
  pad(d.getUTCMonth() + 1) +
  pad(d.getUTCDate()) +
  pad(d.getUTCHours()) +
  pad(d.getUTCMinutes());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

async function fetchJSON(fetchFn, url, tries) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchFn(url, {
        headers: {
          "User-Agent": "trempette (https://github.com/alexhaed/trempette; alexhaederli@gmail.com)",
        },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

const BASE = "https://alplakes-api.eawag.ch";

// Profondeur cible : ~20 cm sous la surface (température de baignade ressentie).
// Le modèle est stratifié : l'API renvoie le point de grille le plus proche.
// La couche la plus haute varie selon le lac (~10–25 cm), et 0.2 retombe sur
// cette couche de surface pour les 5 lacs (identique à 0, mais intention claire).
const DEPTH = 0.2;

// Fenêtre large : assez de points (passé + futur) pour interpoler « maintenant »
// pendant ~24 h, jusqu'au prochain run quotidien, sans re-télécharger.
const WINDOW_BEFORE_H = 6;
const WINDOW_AFTER_H = 30;

// Récupère la fenêtre brute de température d'eau d'une plage (points 3 h UTC).
// Renvoie des tableaux parallèles { times:[ms], temps:[°C] }, valeurs finies.
export async function fetchWindow(fetchFn, beach, now, tries = 1) {
  const start = new Date(now - WINDOW_BEFORE_H * 3600e3);
  const end = new Date(now + WINDOW_AFTER_H * 3600e3);
  const url =
    `${BASE}/simulations/point/${beach.model}/${beach.lake}/` +
    `${ymdhm(start)}/${ymdhm(end)}/${DEPTH}/${beach.lat}/${beach.lng}?variables=temperature`;
  const r = await fetchJSON(fetchFn, url, tries);
  const temps = r?.variables?.temperature?.data ?? [];
  const times = (r?.time ?? []).map((t) => new Date(t).getTime());
  const T = [];
  const V = [];
  for (let i = 0; i < temps.length; i++) {
    if (Number.isFinite(temps[i])) {
      T.push(times[i]);
      V.push(temps[i]);
    }
  }
  return { times: T, temps: V };
}

// Interpole la température d'eau à `now` depuis une fenêtre en cache. Renvoie
// aussi la tendance (°C/h) et le prochain point de prévision (marque 3 h UTC).
export function interpolate(win, now) {
  const times = win?.times ?? [];
  const temps = win?.temps ?? [];
  const n = times.length;
  const nextIdx = times.findIndex((t) => t > now);
  const next =
    nextIdx >= 0 ? { at: new Date(times[nextIdx]).toISOString(), temp: round1(temps[nextIdx]) } : null;

  if (n === 0) return { water: null, trend: null, next: null };
  if (n === 1) return { water: round1(temps[0]), trend: null, next };

  for (let i = 0; i < n - 1; i++) {
    const at = times[i];
    const bt = times[i + 1];
    if (now >= at && now <= bt) {
      const av = temps[i];
      const bv = temps[i + 1];
      const water = av + ((bv - av) * (now - at)) / (bt - at);
      const trend = (bv - av) / ((bt - at) / 3600000);
      return { water: round1(water), trend: round2(trend), next };
    }
  }
  // Hors fenêtre encadrante : point le plus proche, sans tendance fiable.
  const v = now < times[0] ? temps[0] : temps[n - 1];
  return { water: round1(v), trend: null, next };
}

// Fin de prévision (end_date) par clé "model/lake" — avance à chaque nouveau run
// quotidien, ce qui permet de détecter quand re-télécharger les fenêtres.
export async function fetchLakeEndDates(fetchFn, tries = 1) {
  const j = await fetchJSON(fetchFn, `${BASE}/simulations/metadata`, tries);
  const map = {};
  for (const m of Array.isArray(j) ? j : []) {
    for (const lk of m.lakes ?? []) map[`${m.model}/${lk.name}`] = lk.end_date;
  }
  return map;
}

// Air + vent pour toutes les plages en un seul appel open-meteo
// (coordonnées séparées par des virgules → réponse = tableau ordonné).
export async function fetchWeatherAll(fetchFn, beaches, tries = 1) {
  const lat = beaches.map((b) => b.lat).join(",");
  const lng = beaches.map((b) => b.lng).join(",");
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh`;
  const r = await fetchJSON(fetchFn, url, tries);
  const arr = Array.isArray(r) ? r : [r];
  return arr.map((x) => ({
    air: x?.current?.temperature_2m ?? null,
    wind: x?.current?.wind_speed_10m ?? null,
    windDir: x?.current?.wind_direction_10m ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Correction de biais du Léman par mesures in-situ live (LéXPLORE + Buchillon).
//
// Le modèle Alplakes a un biais systématique qui dérive selon la saison et
// l'heure (mesuré : ~+2 °C au printemps, ~−1.5 °C en été, ±0.5 °C sur la
// journée). On le corrige en ajoutant à chaque plage du Léman l'écart
// « mesure réelle − modèle » constaté aux 2 seules bouées in-situ live du lac,
// pondéré par 1/distance² (IDW). Avec 2 points au large : correction quasi
// locale près d'une bouée, sinon ~moyenne du lac. NE corrige PAS le sur-
// réchauffement des hauts-fonds au bord (aucune bouée ne le voit).
//
// Source mesures : Datalakes (Eawag), pas de CORS non plus → côté Worker.
// ---------------------------------------------------------------------------

const DATALAKES = "https://api.datalakes-eawag.ch";

// Distance en mètres (Haversine) — pour la pondération IDW.
function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLng = (bLng - aLng) * r;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Les 2 bouées du Léman. `lake/model` = mêmes que les plages (delft3d/geneva),
// donc le modèle au point de la bouée passe par le même cache de fenêtres.
// `parse` extrait la dernière mesure de surface valide du fichier Datalakes.
export const LEMAN_BUOYS = [
  {
    id: "_buoy_lexplore",
    name: "LéXPLORE",
    lat: 46.5,
    lng: 6.67,
    model: "delft3d-flow",
    lake: "geneva",
    dataset: 448, // chaîne de température, grille z[profondeur][temps], surface ~0.25 m
    parse: (g) => {
      const { x, y, z } = g || {};
      if (!Array.isArray(x) || !Array.isArray(y) || !Array.isArray(z)) return null;
      let di = 0,
        best = Infinity;
      for (let i = 0; i < y.length; i++) {
        const d = Math.abs(y[i] - 0.25);
        if (d < best) {
          best = d;
          di = i;
        }
      }
      return latestValid(x, z[di]);
    },
  },
  {
    id: "_buoy_buchillon",
    name: "Buchillon",
    lat: 46.459,
    lng: 6.399,
    model: "delft3d-flow",
    lake: "geneva",
    dataset: 597, // station Buchillon, axe `y` = wt1 (température eau à 1 m)
    parse: (g) => latestValid(g?.x, g?.y),
  },
];

// Dernière valeur finie et plausible (°C) d'une série, avec son horodatage.
// `x` = secondes depuis 1970 (convention Datalakes).
function latestValid(x, series) {
  if (!Array.isArray(x) || !Array.isArray(series)) return null;
  for (let k = x.length - 1; k >= 0; k--) {
    const v = series[k];
    if (Number.isFinite(v) && v > -2 && v < 40) return { time: x[k] * 1000, temp: v };
  }
  return null;
}

// Une fenêtre modèle en cache encadre-t-elle encore `t` (besoin d'un point après) ?
function windowUsable(win, t) {
  const a = win?.times;
  return Array.isArray(a) && a.length >= 2 && t >= a[0] && t < a[a.length - 1];
}

// Télécharge la dernière mesure in-situ d'une bouée (liste des fichiers → fichier
// JSON le plus récent → parse). 2 sous-requêtes par bouée.
async function fetchBuoyInsitu(fetchFn, buoy, tries) {
  const files = await fetchJSON(fetchFn, `${DATALAKES}/files?datasets_id=${buoy.dataset}`, tries);
  const js = (Array.isArray(files) ? files : []).filter((f) => f.filetype === "json" && f.maxdatetime);
  if (!js.length) return null;
  js.sort((a, b) => (a.maxdatetime < b.maxdatetime ? 1 : -1));
  const g = await fetchJSON(fetchFn, `${DATALAKES}/download/${js[0].id}`, tries);
  return buoy.parse(g);
}

// Calcule le biais (mesure − modèle) à chaque bouée du Léman, à l'instant de la
// mesure (comparaison à profil égal dans le temps). Réutilise le cache de
// fenêtres `cache` (clés `_buoy_*`) et la détection de run quotidien `endDates`.
//
// Renvoie un résultat par bouée avec une `reason` explicite (pour le moniteur) :
//   ok          → biais calculé (bias renseigné)
//   reseau      → l'API Datalakes a échoué (réseau/HTTP)         [écartée]
//   pas-mesure  → API OK mais aucune mesure récente valide        [écartée]
//   pas-modele  → fenêtre modèle Alplakes indisponible            [écartée]
//   fige        → flux gelé : horodatage figé >2 h (capteur muet) [écartée]
//   perime      → dernière mesure trop ancienne (>6 h)            [écartée]
//   aberrant    → biais > 5 °C (probable défaut capteur)          [écartée]
//
// Flux « gelé » : l'API répond OK mais l'horodatage de la mesure n'avance plus.
// Seuil à 2 h pour ne pas faire de faux positif sur Buchillon (point horaire,
// ≤ ~1,5 h entre points). État inter-cycles stocké dans `cache._buoyState`.
const FROZEN_MS = 2 * 3600e3;

export async function computeLemanBiases(fetchFn, now, cache, endDates, tries = 1) {
  const results = [];
  const state = cache._buoyState || (cache._buoyState = {});
  for (const buoy of LEMAN_BUOYS) {
    const base = { name: buoy.name, lat: buoy.lat, lng: buoy.lng, bias: null, insitu: null, model: null };
    // Écarte la bouée : journalise la cause (niveau warning, filtrable « [bias] »
    // dans les logs Cloudflare) puis enregistre le résultat avec sa raison.
    const drop = (reason, detail) => {
      console.warn(`[bias] ${buoy.name} écartée: ${reason}${detail ? " — " + detail : ""}`);
      results.push({ ...base, reason });
    };

    // 1. Fenêtre modèle (cache réutilisé, re-téléchargée si périmée).
    let c = cache[buoy.id];
    const runEnd = endDates[`${buoy.model}/${buoy.lake}`];
    if (!c || (runEnd && c.runEnd !== runEnd) || !windowUsable(c, now)) {
      try {
        const win = await fetchWindow(fetchFn, buoy, now, tries);
        if (win.times.length) {
          win.runEnd = runEnd ?? null;
          win.lat = buoy.lat;
          win.lng = buoy.lng;
          cache[buoy.id] = win;
          c = win;
        }
      } catch (e) {
        console.warn(`[bias] ${buoy.name} modèle Alplakes KO — ${e?.message || e}`);
      }
    }

    // 2. Mesure in-situ (Datalakes).
    let insitu = null;
    let fetchErr = null;
    try {
      insitu = await fetchBuoyInsitu(fetchFn, buoy, tries);
    } catch (e) {
      fetchErr = e;
    }

    // 3. Diagnostic dans l'ordre le plus informatif.
    if (fetchErr) { drop("reseau", `Datalakes ${fetchErr?.message || fetchErr}`); continue; }
    if (!insitu) { drop("pas-mesure", "aucune valeur récente valide"); continue; }
    base.insitu = insitu.temp;

    // Suivi du flux : on note quand cet horodatage de mesure est apparu pour la
    // première fois ; s'il ne bouge plus depuis >FROZEN_MS, le capteur est muet.
    const st = state[buoy.id];
    if (!st || st.seen !== insitu.time) state[buoy.id] = { seen: insitu.time, since: now };
    const frozenFor = now - state[buoy.id].since;

    if (!c) { drop("pas-modele", "fenêtre modèle indisponible"); continue; }
    if (frozenFor >= FROZEN_MS) { drop("fige", `horodatage figé depuis ${(frozenFor / 3600e3).toFixed(1)} h`); continue; }
    if (now - insitu.time > 6 * 3600e3) { drop("perime", `dernière mesure il y a ${((now - insitu.time) / 3600e3).toFixed(1)} h`); continue; }
    const modelAtObs = interpolate(c, insitu.time).water; // modèle à l'heure de la mesure
    if (modelAtObs == null) { drop("pas-modele", "interpolation hors fenêtre"); continue; }
    base.model = modelAtObs;
    const bias = insitu.temp - modelAtObs;
    if (Math.abs(bias) > 5) { drop("aberrant", `biais ${bias.toFixed(1)} °C`); continue; }
    results.push({ ...base, bias, reason: "ok" });
  }
  return results;
}

// Applique la correction IDW (in place) aux plages du Léman uniquement.
// Renseigne `water` corrigé, `waterModel` (valeur brute, transparence) et `bias`.
// Décale aussi `next.temp` du même offset pour rester cohérent.
// `results` = sortie de computeLemanBiases ; on ne garde que les bouées exploitables.
export function applyLemanBias(beaches, out, results) {
  const biases = (results || []).filter((b) => b && b.bias != null);
  if (!biases.length) return;
  for (let i = 0; i < beaches.length; i++) {
    const b = beaches[i];
    if (b.lake !== "geneva") continue;
    const o = out[i];
    if (!o || o.water == null) continue;
    let num = 0,
      den = 0;
    for (const bp of biases) {
      const w = 1 / Math.max(haversine(b.lat, b.lng, bp.lat, bp.lng), 1) ** 2;
      num += w * bp.bias;
      den += w;
    }
    const corr = num / den;
    o.waterModel = o.water;
    o.water = round1(o.water + corr);
    o.bias = round2(corr);
    if (o.next && o.next.temp != null) o.next.temp = round1(o.next.temp + corr);
  }
}

// Rétention de l'historique de monitoring (clé KV "history").
const HISTORY_RETENTION_MS = 90 * 24 * 3600e3;
// Anti-doublon : si le dernier point date de < 10 min, on le remplace plutôt
// que d'empiler (une sauvegarde admin peut déclencher un regen hors cron).
const HISTORY_MIN_GAP_MS = 10 * 60e3;

// Ajoute un point compact à l'historique et élague au-delà de la rétention.
// Niveau bouées + agrégat (pas par plage). Renvoie le tableau (à ré-écrire en KV).
// Un point est TOUJOURS écrit, même sans bouée exploitable (n=0) → on trace les pannes.
// `results` = sortie de computeLemanBiases (avec `reason`). Pour une bouée écartée,
// on stocke sa raison dans `drop` (ex. { buch: "perime" }) → moniteur auto-explicite.
export function pushHistory(history, now, results, out) {
  const arr = Array.isArray(history) ? history : [];
  const by = Object.fromEntries((results || []).map((b) => [b.name, b]));
  const buoy = (b) => (b && b.bias != null ? { i: round1(b.insitu), m: round1(b.model), b: round2(b.bias) } : null);
  const corrected = (out || []).filter((o) => o && o.bias != null);
  const meanCorr = corrected.length
    ? corrected.reduce((s, o) => s + o.bias, 0) / corrected.length
    : null;
  const drop = {};
  if (by["LéXPLORE"] && by["LéXPLORE"].bias == null) drop.lex = by["LéXPLORE"].reason;
  if (by["Buchillon"] && by["Buchillon"].bias == null) drop.buch = by["Buchillon"].reason;
  const point = {
    t: now,
    lex: buoy(by["LéXPLORE"]),
    buch: buoy(by["Buchillon"]),
    n: corrected.length,
    c: round2(meanCorr),
  };
  if (Object.keys(drop).length) point.drop = drop;
  if (arr.length && now - arr[arr.length - 1].t < HISTORY_MIN_GAP_MS) arr.pop();
  arr.push(point);
  const cutoff = now - HISTORY_RETENTION_MS;
  return arr.filter((p) => p.t >= cutoff);
}

// Exécute des tâches async avec une concurrence limitée (courtois envers les
// API publiques, et compatible avec la limite de sous-requêtes d'un Worker).
export async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}
