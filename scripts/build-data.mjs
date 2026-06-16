// Logique portable de construction de data.json.
//
// Sans API spécifique à Node : prend `fetch` et la liste des lacs en paramètres.
// Utilisé par worker/index.js (Cron Trigger Cloudflare).
//
// Rappel : Alplakes (eau) n'envoie pas de CORS → fetch impossible côté
// navigateur, d'où ce pré-calcul côté serveur. open-meteo (air/vent) est
// récupéré ici aussi pour que l'app n'ait qu'un seul fichier à lire.

// Aplatit la structure des lacs en une liste de plages, chacune portant les
// infos de son lac (et son groupe régional pour le Léman). id stable = lake+slug.
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

// Profondeur cible : ~20 cm sous la surface (température de baignade ressentie).
// Le modèle est stratifié : l'API renvoie le point de grille le plus proche.
// La couche la plus haute varie selon le lac (~10–25 cm), et 0.2 retombe sur
// cette couche de surface pour les 5 lacs (identique à 0, mais intention claire).
const DEPTH = 0.2;

// Température de l'eau : Alplakes ne donne qu'un point toutes les ~3 h. On
// récupère une fenêtre ±4 h, on interpole linéairement à l'instant présent,
// et la pente (°C/h) donne la tendance.
async function getWater(fetchFn, beach, now, tries) {
  const start = new Date(now - 4 * 3600e3);
  const end = new Date(now + 4 * 3600e3);
  const url =
    `https://alplakes-api.eawag.ch/simulations/point/${beach.model}/${beach.lake}/` +
    `${ymdhm(start)}/${ymdhm(end)}/${DEPTH}/${beach.lat}/${beach.lng}?variables=temperature`;

  const r = await fetchJSON(fetchFn, url, tries);
  const temps = r?.variables?.temperature?.data ?? [];
  const times = (r?.time ?? []).map((t) => new Date(t).getTime());

  const pts = [];
  for (let i = 0; i < temps.length; i++) {
    if (temps[i] !== null && temps[i] !== undefined && Number.isFinite(temps[i])) {
      pts.push({ t: times[i], v: temps[i] });
    }
  }
  // Prochain point de prévision Alplakes après maintenant (marques fixes 3 h UTC).
  const nextPt = pts.find((p) => p.t > now);
  const next = nextPt ? { at: new Date(nextPt.t).toISOString(), temp: round1(nextPt.v) } : null;

  if (pts.length === 0) return { water: null, trend: null, next: null };
  if (pts.length === 1) return { water: round1(pts[0].v), trend: null, next };

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (now >= a.t && now <= b.t) {
      const water = a.v + ((b.v - a.v) * (now - a.t)) / (b.t - a.t);
      const trend = (b.v - a.v) / ((b.t - a.t) / 3600000);
      return { water: round1(water), trend: round2(trend), next };
    }
  }
  // Hors fenêtre encadrante : point le plus proche, sans tendance fiable.
  const v = now < pts[0].t ? pts[0].v : pts[pts.length - 1].v;
  return { water: round1(v), trend: null, next };
}

// Air + vent pour toutes les plages en un seul appel open-meteo
// (coordonnées séparées par des virgules → réponse = tableau ordonné).
async function getWeatherAll(fetchFn, beaches, tries) {
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
// API publiques, et compatible avec les limites de sous-requêtes d'un Worker).
async function pool(items, concurrency, worker) {
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

// Construit le payload data.json complet.
// `concurrency` et `tries` sont passés par l'appelant (le Worker : 1 et 1, pour
// rester sous la limite de 50 sous-requêtes du plan gratuit ; voir worker/index.js).
export async function buildPayload(lakes, fetchFn, now = Date.now(), opts = {}) {
  const { concurrency = 1, tries = 1 } = opts;
  const beaches = flattenLakes(lakes);

  let weather;
  try {
    weather = await getWeatherAll(fetchFn, beaches, tries);
  } catch (e) {
    weather = beaches.map(() => ({ air: null, wind: null, windDir: null }));
  }

  const out = await pool(beaches, concurrency, async (b, i) => {
    let water = { water: null, trend: null, next: null };
    try {
      water = await getWater(fetchFn, b, now, tries);
    } catch {
      // plage sans donnée ce cycle : restera null (corrigée au prochain passage)
    }
    const w = weather[i] ?? { air: null, wind: null, windDir: null };
    return {
      id: b.id,
      name: b.name,
      lat: b.lat,
      lng: b.lng,
      lakeName: b.lakeName,
      lake: b.lake,
      group: b.group,
      water: water.water,
      trend: water.trend,
      next: water.next,
      air: w.air,
      wind: w.wind,
      windDir: w.windDir,
    };
  });

  const okWater = out.filter((b) => b.water != null).length;
  return {
    updatedAt: new Date(now).toISOString(),
    counts: { total: out.length, water: okWater },
    beaches: out,
  };
}
