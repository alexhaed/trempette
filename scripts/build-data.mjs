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
