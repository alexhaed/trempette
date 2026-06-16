// Worker Cloudflare unique pour Trempette :
//  - sert le site statique (binding ASSETS) ;
//  - régénère data.json toutes les 30 min (Cron Trigger) et le stocke dans KV ;
//  - sert /data.json depuis KV (route gérée par le Worker via run_worker_first
//    dans wrangler.toml ; data.json n'est pas un asset statique).
//
// La logique de récupération vit dans scripts/build-data.mjs.

import lakes from "../scripts/lakes.json";
import { buildPayload } from "../scripts/build-data.mjs";

const DATA_KEY = "data";

// Plan GRATUIT : ≤ 50 sous-requêtes par invocation et CPU limité.
// De plus, Alplakes throttle les appels parallèles (mesuré : 6 en // → 27/40 ;
// séquentiel → 40/40), donc on reste séquentiel. tries=1 → ~41 sous-requêtes.
// Sur Workers PAID (1000 sous-requêtes), passez TRIES=3 pour la fiabilité max.
const CONCURRENCY = 1;
const TRIES = 1;

async function regenerate(env) {
  const payload = await buildPayload(lakes, fetch, Date.now(), {
    concurrency: CONCURRENCY,
    tries: TRIES,
  });

  // Plan gratuit : sans reprises (TRIES=1) et avec Alplakes parfois capricieux,
  // un cycle peut manquer quelques plages. On fusionne avec le dernier état
  // connu (KV) : une plage sans donnée ce cycle garde sa valeur précédente
  // plutôt que d'afficher « n/d ». La donnée se complète sur quelques cycles.
  try {
    const prevRaw = await env.DATA.get(DATA_KEY);
    if (prevRaw) {
      const prevById = new Map(JSON.parse(prevRaw).beaches.map((b) => [b.id, b]));
      for (const b of payload.beaches) {
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
      payload.counts.water = payload.beaches.filter((b) => b.water != null).length;
    }
  } catch {
    // pas d'état précédent exploitable : on garde le payload tel quel
  }

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
