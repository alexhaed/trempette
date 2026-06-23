// Worker Cloudflare unique pour Trempette :
//  - sert le site statique (binding ASSETS) ;
//  - régénère data.json toutes les 30 min (Cron Trigger) et le stocke dans KV ;
//  - sert /data.json depuis KV (route gérée par le Worker via run_worker_first
//    dans wrangler.toml ; data.json n'est pas un asset statique) ;
//  - back-office /admin (protégé par secret) : moniteur des corrections par défaut
//    (/admin = /admin/monitor) et éditeur du catalogue sur /admin/plages.
//
// Source de vérité du catalogue : KV (clé "catalogue"), repli sur le lakes.json
// embarqué si KV vide. L'éditeur /admin/plages écrit dans KV → le run suivant rebâtit.
//
// Stratégie de récupération (voir scripts/build-data.mjs) :
//  - Air/vent (open-meteo) : rafraîchis à CHAQUE cycle (30 min).
//  - Eau (Alplakes) : simulations mises à jour 1×/jour → on met en cache la
//    fenêtre brute par plage (KV "windows") et on ne re-télécharge que sur
//    nouveau run (end_date), changement de coordonnées, ou fenêtre périmée.

import bundledLakes from "../scripts/lakes.json";
import plagesHtml from "./plages.html";
import correctionHtml from "./correction.html";
import {
  flattenLakes,
  fetchWindow,
  interpolate,
  fetchLakeEndDates,
  fetchWeatherAll,
  pool,
  computeLemanBiases,
  applyLemanBias,
  pushHistory,
} from "../scripts/build-data.mjs";

const DATA_KEY = "data";
const WINDOWS_KEY = "windows";
const CATALOGUE_KEY = "catalogue";
const HISTORY_KEY = "history";

// Plan GRATUIT : ≤ 50 sous-requêtes/invocation. Alplakes throttle le parallèle → séquentiel.
const TRIES = 1;
const REFETCH_CONCURRENCY = 1;

async function getCatalogue(env) {
  return (await env.DATA.get(CATALOGUE_KEY, "json")) || bundledLakes;
}

// La fenêtre en cache permet-elle encore d'interpoler « now » (point après now,
// marge 2 h) et correspond-elle aux coordonnées actuelles de la plage ?
function fresh(win, beach, now) {
  const t = win?.times;
  if (!t || t.length < 2) return false;
  if (win.lat !== beach.lat || win.lng !== beach.lng) return false;
  return now >= t[0] && now < t[t.length - 1] - 2 * 3600e3;
}

async function regenerate(env) {
  const now = Date.now();
  const beaches = flattenLakes(await getCatalogue(env));

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

  // 3. Ne re-télécharge que les fenêtres nécessaires.
  const toFetch = beaches.filter((b) => {
    const c = cache[b.id];
    const runEnd = endDates[`${b.model}/${b.lake}`];
    return !c || (runEnd && c.runEnd !== runEnd) || !fresh(c, b, now);
  });
  await pool(toFetch, REFETCH_CONCURRENCY, async (b) => {
    try {
      const win = await fetchWindow(fetch, b, now, TRIES);
      if (win.times.length) {
        win.runEnd = endDates[`${b.model}/${b.lake}`] ?? null;
        win.lat = b.lat;
        win.lng = b.lng;
        cache[b.id] = win;
      }
    } catch {
      /* échec ce cycle : on conserve l'ancienne fenêtre si présente */
    }
  });

  // 3bis. Biais in-situ du Léman (bouées LéXPLORE + Buchillon), via le même cache
  // de fenêtres. Échec/panne d'une bouée → elle est simplement ignorée.
  let lemanBiases = [];
  try {
    lemanBiases = await computeLemanBiases(fetch, now, cache, endDates, TRIES);
  } catch {
    /* correction indisponible ce cycle : on sert le modèle brut */
  }

  // 4. Payload : interpolation locale + météo fraîche.
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

  // 4bis. Correction de biais des plages du Léman (IDW des bouées). No-op si
  // aucune bouée exploitable ce cycle → la valeur modèle brute est conservée.
  applyLemanBias(beaches, out, lemanBiases);

  // 5. Filet de sécurité : garde la dernière valeur connue si un champ manque.
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
    lemanBiases: lemanBiases.map((b) => ({
      name: b.name,
      bias: Math.round(b.bias * 100) / 100,
      insitu: Math.round(b.insitu * 10) / 10,
      model: Math.round(b.model * 10) / 10,
    })),
    beaches: out,
  };

  // 6. Historique de monitoring (niveau bouées + agrégat), pour /admin/monitor.
  try {
    const history = (await env.DATA.get(HISTORY_KEY, "json")) || [];
    const updated = pushHistory(history, now, lemanBiases, out);
    await env.DATA.put(HISTORY_KEY, JSON.stringify(updated));
  } catch {
    /* historique best-effort : ne bloque jamais la génération des données */
  }

  await env.DATA.put(WINDOWS_KEY, JSON.stringify(cache));
  await env.DATA.put(DATA_KEY, JSON.stringify(payload));
  return payload;
}

// --- Back-office /admin ---

function authorized(request, env) {
  const token = env.ADMIN_TOKEN;
  if (!token) return false; // pas de secret configuré → tout refusé (fail closed)
  return request.headers.get("X-Admin-Token") === token;
}

// Validation légère d'un catalogue avant écriture (évite de corrompre le pipeline).
function validCatalogue(c) {
  if (!Array.isArray(c) || c.length === 0) return "catalogue vide ou non-tableau";
  for (const lk of c) {
    if (!lk || typeof lk.name !== "string" || typeof lk.model !== "string" || typeof lk.lake !== "string")
      return "lac sans name/model/lake";
    const groups = lk.regions ? lk.regions.map((r) => r.beaches) : [lk.beaches];
    if (lk.regions && !Array.isArray(lk.regions)) return `regions invalide (${lk.name})`;
    if (!lk.regions && !Array.isArray(lk.beaches)) return `beaches manquant (${lk.name})`;
    for (const bs of groups) {
      if (!Array.isArray(bs)) return `liste de plages invalide (${lk.name})`;
      for (const b of bs) {
        if (!b || typeof b.name !== "string" || !b.name.trim()) return `plage sans nom (${lk.name})`;
        if (!Number.isFinite(b.lat) || !Number.isFinite(b.lng)) return `coordonnées invalides (${b.name})`;
      }
    }
  }
  return null;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const htmlPage = (html) =>
  new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" },
  });

async function handleAdmin(request, env, ctx, pathname) {
  // Page par défaut de /admin = le moniteur (alias /admin/monitor conservé).
  if (pathname === "/admin" || pathname === "/admin/" || pathname === "/admin/monitor" || pathname === "/admin/monitor/") {
    return htmlPage(correctionHtml);
  }

  // Éditeur des plages, désormais sur son propre chemin.
  if (pathname === "/admin/plages" || pathname === "/admin/plages/") {
    return htmlPage(plagesHtml);
  }

  if (pathname === "/admin/history") {
    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
    const history = (await env.DATA.get(HISTORY_KEY, "json")) || [];
    return json(history);
  }

  if (pathname === "/admin/catalogue") {
    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

    if (request.method === "GET") {
      return json(await getCatalogue(env));
    }
    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response("JSON invalide", { status: 400 });
      }
      const err = validCatalogue(body);
      if (err) return new Response(err, { status: 400 });
      await env.DATA.put(CATALOGUE_KEY, JSON.stringify(body));
      const total = body.reduce(
        (n, lk) => n + (lk.regions ? lk.regions.reduce((m, r) => m + r.beaches.length, 0) : lk.beaches.length),
        0
      );
      // Régénère en arrière-plan avec le nouveau catalogue.
      ctx.waitUntil(regenerate(env));
      return json({ ok: true, count: total });
    }
    return new Response("Méthode non autorisée", { status: 405 });
  }

  return new Response("Not found", { status: 404 });
}

export default {
  // Déclenché par le Cron Trigger (voir wrangler.toml).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(regenerate(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, ctx, url.pathname);
    }

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
