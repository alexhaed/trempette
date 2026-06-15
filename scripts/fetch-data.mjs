// Pré-calcul des données, exécuté par la GitHub Action (pas dans le navigateur).
//
// Pourquoi côté Action et pas côté client ?
//  - Alplakes (température de l'eau) n'envoie pas d'en-tête CORS : un fetch
//    navigateur échoue. On l'appelle donc ici, côté serveur, sans CORS.
//  - open-meteo (air + vent) accepte le CORS, mais on le récupère ici aussi
//    pour que l'app n'ait qu'un seul fichier statique (data.json) à lire.
//
// Sortie : data.json à la racine du repo, consommé par l'app web.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { flattenBeaches } from "./lakes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "data.json");

const pad = (n) => String(n).padStart(2, "0");
const ymdhm = (d) =>
  d.getUTCFullYear() +
  pad(d.getUTCMonth() + 1) +
  pad(d.getUTCDate()) +
  pad(d.getUTCHours()) +
  pad(d.getUTCMinutes());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "app-temperature-lac" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

// Température de l'eau pour une plage : Alplakes ne donne qu'un point toutes
// les ~3 h. On récupère une fenêtre ±4 h, on interpole linéairement à
// l'instant présent, et la pente (°C/h) donne la tendance.
// Profondeur cible : ~20 cm sous la surface (température de baignade ressentie).
// Le modèle est stratifié : l'API renvoie le point de grille le plus proche.
// La couche la plus haute varie selon le lac (~10–25 cm), et 0.2 retombe sur
// cette couche de surface pour les 5 lacs (identique à 0, mais intention claire).
const DEPTH = 0.2;

async function getWater(beach, now) {
  const start = new Date(now - 4 * 3600e3);
  const end = new Date(now + 4 * 3600e3);
  const url =
    `https://alplakes-api.eawag.ch/simulations/point/${beach.model}/${beach.lake}/` +
    `${ymdhm(start)}/${ymdhm(end)}/${DEPTH}/${beach.lat}/${beach.lng}?variables=temperature`;

  const r = await fetchJSON(url);
  const temps = r?.variables?.temperature?.data ?? [];
  const times = (r?.time ?? []).map((t) => new Date(t).getTime());

  const pts = [];
  for (let i = 0; i < temps.length; i++) {
    if (temps[i] !== null && temps[i] !== undefined && Number.isFinite(temps[i])) {
      pts.push({ t: times[i], v: temps[i] });
    }
  }
  if (pts.length === 0) return { water: null, trend: null };
  if (pts.length === 1) return { water: round1(pts[0].v), trend: null };

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (now >= a.t && now <= b.t) {
      const water = a.v + ((b.v - a.v) * (now - a.t)) / (b.t - a.t);
      const trend = (b.v - a.v) / ((b.t - a.t) / 3600000);
      return { water: round1(water), trend: round2(trend) };
    }
  }
  // Hors fenêtre encadrante : point le plus proche, sans tendance fiable.
  const v = now < pts[0].t ? pts[0].v : pts[pts.length - 1].v;
  return { water: round1(v), trend: null };
}

// Air + vent pour toutes les plages en un seul appel open-meteo
// (coordonnées séparées par des virgules → réponse = tableau ordonné).
async function getWeatherAll(beaches) {
  const lat = beaches.map((b) => b.lat).join(",");
  const lng = beaches.map((b) => b.lng).join(",");
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh`;
  const r = await fetchJSON(url);
  const arr = Array.isArray(r) ? r : [r];
  return arr.map((x) => ({
    air: x?.current?.temperature_2m ?? null,
    wind: x?.current?.wind_speed_10m ?? null,
    windDir: x?.current?.wind_direction_10m ?? null,
  }));
}

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

async function main() {
  const now = Date.now();
  const beaches = flattenBeaches();

  // Météo : un seul appel groupé.
  let weather = [];
  try {
    weather = await getWeatherAll(beaches);
  } catch (e) {
    console.error("open-meteo a échoué:", e.message);
    weather = beaches.map(() => ({ air: null, wind: null, windDir: null }));
  }

  // Eau : un appel Alplakes par plage, en série avec une petite pause pour
  // rester courtois envers l'API publique.
  const out = [];
  for (let i = 0; i < beaches.length; i++) {
    const b = beaches[i];
    let water = { water: null, trend: null };
    try {
      water = await getWater(b, now);
    } catch (e) {
      console.error(`Alplakes a échoué pour ${b.id}:`, e.message);
    }
    const w = weather[i] ?? { air: null, wind: null, windDir: null };
    out.push({
      id: b.id,
      name: b.name,
      lat: b.lat,
      lng: b.lng,
      lakeName: b.lakeName,
      lake: b.lake,
      group: b.group,
      water: water.water,
      trend: water.trend,
      air: w.air,
      wind: w.wind,
      windDir: w.windDir,
    });
    process.stdout.write(
      `[${i + 1}/${beaches.length}] ${b.name}: eau=${water.water ?? "–"}° air=${w.air ?? "–"}°\n`
    );
    await sleep(250);
  }

  const okWater = out.filter((b) => b.water != null).length;
  const payload = {
    updatedAt: new Date(now).toISOString(),
    counts: { total: out.length, water: okWater },
    beaches: out,
  };

  await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`\n✓ data.json écrit — ${okWater}/${out.length} plages avec température d'eau.`);
}

main().catch((e) => {
  console.error("Échec:", e);
  process.exit(1);
});
