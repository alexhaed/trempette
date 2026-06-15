// Worker Cloudflare unique pour Trempette :
//  - sert le site statique (binding ASSETS) ;
//  - régénère data.json toutes les 30 min (Cron Trigger) et le stocke dans KV ;
//  - sert /data.json depuis KV (le fichier statique est exclu via .assetsignore).
//
// La logique de récupération vit dans scripts/build-data.mjs (partagée avec le
// script Node de transition).

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
