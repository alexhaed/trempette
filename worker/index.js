// Worker Cloudflare unique pour Trempette :
//  - sert le site statique (binding ASSETS) ;
//  - régénère data.json toutes les 30 min (Cron Trigger) et le stocke dans KV ;
//  - sert /data.json depuis KV (route gérée par le Worker via run_worker_first
//    dans wrangler.toml ; data.json n'est pas un asset statique).
//
// Stratégie de récupération (voir scripts/build-data.mjs) :
//  - Air/vent (open-meteo) : rafraîchis à CHAQUE cycle (toutes les 30 min).
//  - Eau (Alplakes) : les simulations ne sont mises à jour qu'une fois par jour.
//    On met en cache la fenêtre brute par plage dans KV et on ne la re-télécharge
//    que lorsqu'un nouveau run paraît (end_date avancé) ou que la fenêtre ne
//    couvre plus « maintenant ». Les autres cycles réinterpolent en local.
//  → la plupart des cycles = 2 sous-requêtes (météo + metadata) ; ~1×/jour = ~42.

import lakes from "../scripts/lakes.json";
import {
  flattenLakes,
  fetchWindow,
  interpolate,
  fetchLakeEndDates,
  fetchWeatherAll,
  pool,
} from "../scripts/build-data.mjs";

const DATA_KEY = "data";
const WINDOWS_KEY = "windows";

// Plan GRATUIT : ≤ 50 sous-requêtes/invocation. Alplakes throttle le parallèle
// (mesuré : 6 en // → 27/40 ; séquentiel → 40/40) → on reste séquentiel.
const TRIES = 1;
const REFETCH_CONCURRENCY = 1;

const beaches = flattenLakes(lakes);

// La fenêtre en cache permet-elle encore d'interpoler « now » ? Il faut un point
// après `now` (encadrement + prévision) ; marge de 2 h avant la fin de fenêtre.
function brackets(win, now) {
  const t = win?.times;
  if (!t || t.length < 2) return false;
  return now >= t[0] && now < t[t.length - 1] - 2 * 3600e3;
}

async function regenerate(env) {
  const now = Date.now();

  // 1. Air + vent : toujours rafraîchis.
  let weather;
  try {
    weather = await fetchWeatherAll(fetch, beaches, TRIES);
  } catch {
    weather = beaches.map(() => ({ air: null, wind: null, windDir: null }));
  }

  // 2. Fenêtres d'eau en cache + détection d'un nouveau run quotidien.
  const cache = (await env.DATA.get(WINDOWS_KEY, "json")) || {};
  let endDates = {};
  try {
    endDates = await fetchLakeEndDates(fetch, TRIES);
  } catch {
    /* metadata indisponible : on retombe sur le seul critère « fenêtre périmée » */
  }

  // 3. Ne re-télécharge que les fenêtres nécessaires (absente, nouveau run, ou
  //    ne couvrant plus « now »). Les autres plages : interpolation locale.
  const toFetch = beaches.filter((b) => {
    const c = cache[b.id];
    const runEnd = endDates[`${b.model}/${b.lake}`];
    return !c || (runEnd && c.runEnd !== runEnd) || !brackets(c, now);
  });
  await pool(toFetch, REFETCH_CONCURRENCY, async (b) => {
    try {
      const win = await fetchWindow(fetch, b, now, TRIES);
      if (win.times.length) {
        win.runEnd = endDates[`${b.model}/${b.lake}`] ?? null;
        cache[b.id] = win;
      }
    } catch {
      /* échec ce cycle : on conserve l'ancienne fenêtre si présente */
    }
  });

  // 4. Payload : interpolation locale depuis le cache + météo fraîche.
  const out = beaches.map((b, i) => {
    const wi = interpolate(cache[b.id], now);
    const wx = weather[i] ?? { air: null, wind: null, windDir: null };
    return {
      id: b.id,
      name: b.name,
      lat: b.lat,
      lng: b.lng,
      lakeName: b.lakeName,
      lake: b.lake,
      group: b.group,
      water: wi.water,
      trend: wi.trend,
      next: wi.next,
      air: wx.air,
      wind: wx.wind,
      windDir: wx.windDir,
    };
  });

  // 5. Filet de sécurité : si un champ manque ce cycle, garde la dernière valeur
  //    connue plutôt que d'afficher « n/d » (la donnée se complète au cycle suivant).
  try {
    const prevRaw = await env.DATA.get(DATA_KEY);
    if (prevRaw) {
      const prevById = new Map(JSON.parse(prevRaw).beaches.map((b) => [b.id, b]));
      for (const b of out) {
        const p = prevById.get(b.id);
        if (!p) continue;
        if (b.water == null && p.water != null) {
          b.water = p.water;
          b.trend = p.trend;
        }
        if (b.air == null && p.air != null) b.air = p.air;
        if (b.wind == null && p.wind != null) {
          b.wind = p.wind;
          b.windDir = p.windDir;
        }
      }
    }
  } catch {
    /* pas d'état précédent exploitable */
  }

  const payload = {
    updatedAt: new Date(now).toISOString(),
    counts: { total: out.length, water: out.filter((b) => b.water != null).length },
    beaches: out,
  };

  await env.DATA.put(WINDOWS_KEY, JSON.stringify(cache));
  await env.DATA.put(DATA_KEY, JSON.stringify(payload));
  return payload;
}

export default {
  // Déclenché par le Cron Trigger (voir wrangler.toml).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(regenerate(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/data.json") {
      let body = await env.DATA.get(DATA_KEY);
      if (!body) {
        // KV vide (tout premier appel avant le 1er cron) : amorçage à la volée.
        body = JSON.stringify(await regenerate(env));
      }
      return new Response(body, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-cache",
        },
      });
    }

    // Tout le reste = fichiers statiques (index.html, css, js, icônes…).
    return env.ASSETS.fetch(request);
  },
};
