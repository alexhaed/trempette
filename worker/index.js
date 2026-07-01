// Worker Cloudflare unique pour Trempette :
//  - sert le site statique (binding ASSETS) ;
//  - régénère data.json toutes les 30 min (Cron Trigger) et le stocke dans KV ;
//  - sert /data.json depuis KV (route gérée par le Worker via run_worker_first
//    dans wrangler.toml ; data.json n'est pas un asset statique) ;
//  - back-office /admin (protégé par secret) : moniteur des corrections par défaut
//    (/admin = /admin/correction) et éditeur du catalogue sur /admin/plages.
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
import tipsHtml from "./tips.html";
import statsHtml from "./stats.html";
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
const TIPS_KEY = "tips";
const STATS_DAILY_KEY = "stats-daily"; // archive { "YYYY-MM-DD": { totals, beaches } } au-delà des 90 j d'AE
const STATS_CURSOR_KEY = "stats-cursor"; // dernière date (UTC) déjà snapshotée

// Astuces « Le savais-tu ? » affichées (au hasard) sur la page d'accueil.
// Source de vérité : KV (clé "tips"), éditable sur /admin/tips. Ce tableau sert
// de repli tant que rien n'a été enregistré. href "#info" ouvre l'overlay
// Infos & contact ; sinon c'est un lien normal (page interne ou URL).
const DEFAULT_TIPS = [
  {
    text: "Les températures affichées proviennent d'un modèle et sont ajustées avec des stations de mesure dans l'eau.",
    cta: "En savoir plus",
    href: "#info",
  },
  { text: "Une idée ou un commentaire ? Écris-nous !", cta: "Contact", href: "#info" },
  { text: "Trempette propose aussi un widget pour iPhone.", cta: "Découvrir le widget", href: "/widget/" },
];

async function getTips(env) {
  const t = await env.DATA.get(TIPS_KEY, "json");
  return Array.isArray(t) && t.length ? t : DEFAULT_TIPS;
}

// --- URLs publiques partageables / SEO : /lac/<lac>/<plage> ------------------
// Le slug de lac vient du nom PUBLIC (pas de l'id interne : geneva→leman, etc.).
// Ces slugs sont permanents (les changer casserait liens partagés + référencement).
const SITE = "https://trempette.app";
const LAKE_SLUG = { geneva: "leman", neuchatel: "neuchatel", biel: "bienne", murten: "morat", joux: "joux" };
const SLUG_LAKE = Object.fromEntries(Object.entries(LAKE_SLUG).map(([k, v]) => [v, k]));
const LAKE_DISPLAY = { leman: "Léman", neuchatel: "Lac de Neuchâtel", bienne: "Lac de Bienne", morat: "Lac de Morat", joux: "Lac de Joux" };

function slugify(s) {
  return String(s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // retire les diacritiques (accents)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
const lakeSlugOf = (b) => LAKE_SLUG[b.lake] || slugify(b.lakeName);
const beachPath = (b) => `/lac/${lakeSlugOf(b)}/${slugify(b.name)}`;

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const tempTxt = (v) => (v == null ? null : `${(Math.round(v * 10) / 10).toFixed(1)} °C`);

async function getData(env) {
  let body = await env.DATA.get(DATA_KEY);
  if (!body) body = JSON.stringify(await regenerate(env)); // KV vide (1er appel) : amorçage
  return JSON.parse(body);
}

function buildBeachMeta(beach, lakeSlug, lakeBeaches) {
  const lakeName = beach.lakeName;
  const temp = tempTxt(beach.water);
  const canonical = SITE + beachPath(beach);
  const title = `${beach.name} — température de l'eau${temp ? ` (${temp})` : ""} | Trempette`;
  const description =
    `Température de l'eau à ${beach.name}, ${lakeName}${temp ? ` : ${temp} actuellement` : ""}. ` +
    `Air, vent et tendance — pour savoir si c'est le moment d'aller se baigner.`;
  const ogTitle = `${beach.name}${temp ? ` · ${temp}` : ""} — ${lakeName}`;

  const air = beach.air != null ? `Air ${Math.round(beach.air)} °C. ` : "";
  const wind = beach.wind != null ? `Vent ${Math.round(beach.wind)} km/h.` : "";
  const sibs = lakeBeaches
    .filter((x) => x.id !== beach.id)
    .slice(0, 14)
    .map((x) => `<a href="${beachPath(x)}">${esc(x.name)}</a>`)
    .join(" · ");
  const bodyHtml =
    `<noscript><section style="max-width:680px;margin:0 auto;padding:18px;color:#F7F2E7;font-family:sans-serif">` +
    `<h1>${esc(beach.name)} — eau ${esc(temp || "n/d")}</h1>` +
    `<p>${esc(lakeName)}${beach.group ? ` · ${esc(beach.group)}` : ""}. ${air}${wind}</p>` +
    (sibs ? `<p>Autres plages du ${esc(lakeName)} : ${sibs}</p>` : "") +
    `<p><a href="/lac/${lakeSlug}">${esc(lakeName)}</a> · <a href="/">Trempette — toutes les plages romandes</a></p>` +
    `</section></noscript>`;

  const jsonld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Place",
    name: beach.name,
    url: canonical,
    geo: { "@type": "GeoCoordinates", latitude: beach.lat, longitude: beach.lng },
    containedInPlace: { "@type": "BodyOfWater", name: lakeName },
    ...(beach.water != null
      ? {
          additionalProperty: {
            "@type": "PropertyValue",
            name: "Température de l'eau",
            value: Math.round(beach.water * 10) / 10,
            unitCode: "CEL",
          },
        }
      : {}),
  }).replace(/</g, "\\u003c");

  return { title, description, ogTitle, ogDescription: description, canonical, jsonld, bodyHtml };
}

function buildLakeMeta(lakeSlug, lakeBeaches) {
  const lakeName = LAKE_DISPLAY[lakeSlug] || lakeSlug;
  const canonical = SITE + `/lac/${lakeSlug}`;
  const warm = [...lakeBeaches].sort((a, b) => (b.water ?? -99) - (a.water ?? -99));
  const sample = warm.slice(0, 4).map((b) => b.name).join(", ");
  const title = `${lakeName} — température de l'eau des plages | Trempette`;
  const description =
    `Température actuelle de l'eau des plages du ${lakeName}${sample ? ` (${sample}…)` : ""}. ` +
    `Air, vent et tendance, mises à jour en continu.`;

  const items = warm
    .map((b) => `<li><a href="${beachPath(b)}">${esc(b.name)}</a>${b.water != null ? ` — ${esc(tempTxt(b.water))}` : ""}</li>`)
    .join("");
  const bodyHtml =
    `<noscript><section style="max-width:680px;margin:0 auto;padding:18px;color:#F7F2E7;font-family:sans-serif">` +
    `<h1>Température de l'eau — ${esc(lakeName)}</h1><ul>${items}</ul>` +
    `<p><a href="/">Trempette — tous les lacs romands</a></p></section></noscript>`;

  const jsonld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Plages du ${lakeName}`,
    itemListElement: warm.map((b, i) => ({ "@type": "ListItem", position: i + 1, name: b.name, url: SITE + beachPath(b) })),
  }).replace(/</g, "\\u003c");

  return { title, description, ogTitle: title, ogDescription: description, canonical, jsonld, bodyHtml };
}

// Sert l'index.html en réécrivant les balises <head> (titre, description, OG,
// canonical), en injectant le JSON-LD et un <noscript> de repli pour les
// crawlers sans JS. L'app (avec JS) lit le chemin et ouvre la bonne plage.
async function renderShell(request, env, meta) {
  const page = await env.ASSETS.fetch(new Request(new URL("/index.html", request.url)));
  const rewriter = new HTMLRewriter()
    .on("title", { element: (e) => e.setInnerContent(meta.title) })
    .on('meta[name="description"]', { element: (e) => e.setAttribute("content", meta.description) })
    .on('link[rel="canonical"]', { element: (e) => e.setAttribute("href", meta.canonical) })
    .on('meta[property="og:title"]', { element: (e) => e.setAttribute("content", meta.ogTitle) })
    .on('meta[property="og:description"]', { element: (e) => e.setAttribute("content", meta.ogDescription) })
    .on('meta[property="og:url"]', { element: (e) => e.setAttribute("content", meta.canonical) })
    .on('meta[name="twitter:title"]', { element: (e) => e.setAttribute("content", meta.ogTitle) })
    .on('meta[name="twitter:description"]', { element: (e) => e.setAttribute("content", meta.ogDescription) })
    .on("head", { element: (e) => e.append(`<script type="application/ld+json">${meta.jsonld}</script>`, { html: true }) })
    .on("body", { element: (e) => e.append(meta.bodyHtml, { html: true }) });
  const res = rewriter.transform(page);
  const h = new Headers(res.headers);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("cache-control", "public, max-age=300");
  h.delete("x-robots-tag"); // ces pages DOIVENT être indexées
  return new Response(res.body, { status: 200, headers: h });
}

async function handleLacRoute(request, env, url) {
  const parts = url.pathname
    .replace(/^\/lac\//, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s).toLowerCase());
  const [lakeSlug, beachSlugWanted, extra] = parts;
  if (extra || !lakeSlug || !SLUG_LAKE[lakeSlug]) return Response.redirect(new URL("/", url).toString(), 302);

  const data = await getData(env);
  const lakeBeaches = data.beaches.filter((b) => lakeSlugOf(b) === lakeSlug);

  if (beachSlugWanted) {
    const beach = lakeBeaches.find((b) => slugify(b.name) === beachSlugWanted);
    if (!beach) return Response.redirect(new URL(`/lac/${lakeSlug}`, url).toString(), 302);
    return renderShell(request, env, buildBeachMeta(beach, lakeSlug, lakeBeaches));
  }
  return renderShell(request, env, buildLakeMeta(lakeSlug, lakeBeaches));
}

function handleSitemap(data) {
  const lastmod = (data.updatedAt || new Date().toISOString()).slice(0, 10);
  const urls = [`${SITE}/`, ...Object.keys(SLUG_LAKE).map((s) => `${SITE}/lac/${s}`)];
  for (const b of data.beaches) urls.push(SITE + beachPath(b));
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${u}</loc><lastmod>${lastmod}</lastmod></url>`).join("\n") +
    `\n</urlset>\n`;
  return new Response(body, {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

// Validation légère avant écriture (évite de casser le rendu de la page).
function validTips(t) {
  if (!Array.isArray(t)) return "tips : tableau attendu";
  if (t.length > 50) return "trop d'astuces (max 50)";
  for (const x of t) {
    if (!x || typeof x.text !== "string" || !x.text.trim()) return "astuce sans texte";
    if (x.text.length > 400) return "astuce trop longue (max 400)";
    if (x.cta != null && (typeof x.cta !== "string" || x.cta.length > 80)) return "libellé de lien invalide";
    if (x.href != null && (typeof x.href !== "string" || x.href.length > 300)) return "lien invalide";
  }
  return null;
}

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
    weather = beaches.map(() => ({ air: null, wind: null, windDir: null, weatherCode: null, isDay: null }));
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
    const wx = weather[i] ?? { air: null, wind: null, windDir: null, weatherCode: null, isDay: null };
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
      weatherCode: wx.weatherCode,
      isDay: wx.isDay,
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
        if (b.weatherCode == null && p.weatherCode != null) {
          b.weatherCode = p.weatherCode;
          b.isDay = p.isDay;
        }
      }
    }
  } catch {
    /* pas d'état précédent exploitable */
  }

  const payload = {
    updatedAt: new Date(now).toISOString(),
    tips: await getTips(env),
    counts: { total: out.length, water: out.filter((b) => b.water != null).length },
    lemanBiases: lemanBiases
      .filter((b) => b.bias != null)
      .map((b) => ({
        name: b.name,
        bias: Math.round(b.bias * 100) / 100,
        insitu: Math.round(b.insitu * 10) / 10,
        model: Math.round(b.model * 10) / 10,
      })),
    beaches: out,
  };

  // 6. Historique de monitoring (niveau bouées + agrégat), pour /admin/correction.
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
  // Ancienne route → redirection permanente vers la nouvelle.
  if (pathname === "/admin/monitor" || pathname === "/admin/monitor/") {
    return Response.redirect(new URL("/admin/correction", request.url).toString(), 301);
  }
  // Page par défaut de /admin = la correction de biais (alias /admin/correction).
  if (pathname === "/admin" || pathname === "/admin/" || pathname === "/admin/correction" || pathname === "/admin/correction/") {
    return htmlPage(correctionHtml);
  }

  // Éditeur des plages, désormais sur son propre chemin.
  if (pathname === "/admin/plages" || pathname === "/admin/plages/") {
    return htmlPage(plagesHtml);
  }

  // Éditeur des astuces « Le savais-tu ? ».
  if (pathname === "/admin/tips" || pathname === "/admin/tips/") {
    return htmlPage(tipsHtml);
  }

  // Statistiques de consultation par plage.
  if (pathname === "/admin/stats" || pathname === "/admin/stats/") {
    return htmlPage(statsHtml);
  }

  if (pathname === "/admin/stats-data") {
    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
    return handleStatsData(request, env);
  }

  // Déclenchement manuel de l'archivage quotidien (test / rattrapage).
  if (pathname === "/admin/stats-snapshot" && request.method === "POST") {
    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
    try {
      return json(await snapshotDailyStats(env, { force: true }));
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  }

  if (pathname === "/admin/tips-data") {
    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

    if (request.method === "GET") {
      return json(await getTips(env));
    }
    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response("JSON invalide", { status: 400 });
      }
      const err = validTips(body);
      if (err) return new Response(err, { status: 400 });
      const tips = body.map((x) => ({
        text: x.text.trim(),
        cta: x.cta ? x.cta.trim() : "",
        href: x.href ? x.href.trim() : "",
      }));
      await env.DATA.put(TIPS_KEY, JSON.stringify(tips));
      // Reflète tout de suite dans data.json (lu par la page), sans relancer le
      // pipeline complet (eau/air) : un simple patch du JSON déjà en cache.
      try {
        const raw = await env.DATA.get(DATA_KEY);
        if (raw) {
          const d = JSON.parse(raw);
          d.tips = tips;
          await env.DATA.put(DATA_KEY, JSON.stringify(d));
        }
      } catch {
        /* pas de data.json encore : il sera créé avec ces tips au prochain cycle */
      }
      return json({ ok: true, count: tips.length });
    }
    return new Response("Méthode non autorisée", { status: 405 });
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

// --- Formulaire de contact (overlay « Infos & contact ») ---

// Destinataire dans un secret (env.CONTACT_TO) pour ne pas exposer l'adresse
// perso dans le repo public. Posé via : wrangler secret put CONTACT_TO
const CONTACT_FROM = "Trempette <contact@trempette.app>";

// Vérifie le jeton Turnstile (anti-bot). Sans secret configuré → on laisse passer
// (utile en dev local). En prod, TURNSTILE_SECRET est défini → vérification réelle.
async function verifyTurnstile(token, ip, secret) {
  if (!secret) return true;
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token || "");
  if (ip) body.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const d = await r.json();
    return !!d.success;
  } catch {
    return false;
  }
}

async function handleContact(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "requête invalide" }, 400);
  }
  const email = String(body.email || "").trim();
  const message = String(body.message || "").trim();

  if (body.website) return json({ ok: true }); // honeypot : bot → on fait comme si
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "email invalide" }, 400);
  if (message.length < 2 || message.length > 5000) return json({ error: "message invalide" }, 400);

  const ip = request.headers.get("cf-connecting-ip");
  if (!(await verifyTurnstile(body.turnstile, ip, env.TURNSTILE_SECRET))) {
    return json({ error: "anti-robot échoué" }, 403);
  }

  if (!env.RESEND_API_KEY || !env.CONTACT_TO) return json({ error: "email non configuré" }, 500);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: CONTACT_FROM,
      to: [env.CONTACT_TO],
      reply_to: email,
      subject: "Trempette — nouveau message",
      text: `De : ${email}\n\n${message}`,
    }),
  });
  if (!r.ok) {
    console.warn(`[contact] Resend KO ${r.status} ${await r.text().catch(() => "")}`);
    return json({ error: "envoi impossible" }, 502);
  }
  return json({ ok: true });
}

// --- Statistiques de consultation (Analytics Engine) ---

// Réponse vide partagée (sendBeacon ignore le corps de toute façon).
const NO_CONTENT = new Response(null, { status: 204 });

// Liste blanche des types d'events. "impression" = carte favori vue dans le hero.
const EVENT_TYPES = new Set(["open", "impression", "fav", "share"]);

// Borne la cardinalité : on ne fait jamais confiance aveuglément à un id client.
const sanitizeId = (v) => (typeof v === "string" && /^[a-z0-9-]{1,40}$/.test(v) ? v : "");

// Classement grossier de l'User-Agent en familles agrégées (aucune donnée perso).
function parseUA(ua) {
  ua = ua || "";
  let browser = "Autre";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/SamsungBrowser/.test(ua)) browser = "Samsung";
  else if (/Firefox\/|FxiOS/.test(ua)) browser = "Firefox";
  else if (/Chrome\/|CriOS/.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";

  let os = "Autre";
  if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Linux/.test(ua)) os = "Linux";

  const device = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))
    ? "tablette"
    : /Mobi|iPhone|iPod|Android/.test(ua)
    ? "mobile"
    : "ordinateur";

  return { browser, os, device };
}

// POST /e — un event de consultation. Best-effort, ne bloque jamais, 204 systématique.
async function handleEvent(request, env) {
  if (!env.VIEWS) return NO_CONTENT; // binding absent (ex. dev local) : on ne fait rien
  let body;
  try {
    body = JSON.parse(await request.text()); // sendBeacon envoie text/plain
  } catch {
    return NO_CONTENT;
  }
  const beach = sanitizeId(body.b);
  const lake = sanitizeId(body.l);
  const type = EVENT_TYPES.has(body.t) ? body.t : "";
  if (!beach || !type) return NO_CONTENT;

  const { browser, os, device } = parseUA(request.headers.get("user-agent"));
  const country = (request.cf && request.cf.country) || "XX";
  const mode = body.m === "standalone" ? "standalone" : "navigateur";
  // referrer : host seul, jamais l'URL complète (pas de query/chemin).
  let ref = "direct";
  if (typeof body.r === "string" && body.r) {
    try { ref = new URL(body.r).hostname.replace(/^www\./, "") || "direct"; } catch { ref = "direct"; }
  }

  try {
    env.VIEWS.writeDataPoint({
      indexes: [beach],
      blobs: [type, beach, lake || "?", browser, os, device, country, ref, mode],
    });
  } catch {
    /* écriture best-effort : ne jamais faire échouer la requête */
  }
  return NO_CONTENT;
}

// Exécute une requête sur l'API SQL d'Analytics Engine et renvoie les lignes.
async function aeQuery(env, sql) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    { method: "POST", headers: { Authorization: `Bearer ${env.AE_API_TOKEN}` }, body: sql }
  );
  if (!r.ok) throw new Error(`AE ${r.status} ${await r.text().catch(() => "")}`);
  return (await r.json()).data || [];
}

// Visites/jour issues de Cloudflare Web Analytics (dataset RUM), via l'API
// GraphQL. siteTag = identifiant du site Web Analytics (≠ token du beacon).
// Même token Account Analytics Read que l'API SQL. Best-effort.
const RUM_SITE_TAG = "ac015916adb9407c9eaae24a74aff619";
async function rumVisitsByDay(env, days) {
  const today = dayStr(new Date());
  const from = dayStr(new Date(Date.now() - (days - 1) * 86400e3));
  const query =
    `query { viewer { accounts(filter:{accountTag:"${env.CF_ACCOUNT_ID}"}) { ` +
    `rumPageloadEventsAdaptiveGroups(limit:1000, orderBy:[date_ASC], ` +
    `filter:{date_geq:"${from}", date_leq:"${today}", siteTag:"${RUM_SITE_TAG}"}) ` +
    `{ dimensions{date} sum{visits} count } } } }`;
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AE_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`RUM ${r.status}`);
  const j = await r.json();
  if (j.errors) throw new Error("RUM " + JSON.stringify(j.errors));
  const rows = j.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
  return rows.map((x) => ({ date: x.dimensions.date, visits: x.sum.visits, pageviews: x.count }));
}

// GET /admin/stats-data?range=24h|7d|30d — agrège les events pour le dashboard.
async function handleStatsData(request, env) {
  if (!env.CF_ACCOUNT_ID || !env.AE_API_TOKEN) {
    return json({ error: "Analytics Engine non configuré (CF_ACCOUNT_ID / AE_API_TOKEN)" }, 503);
  }
  const range = new URL(request.url).searchParams.get("range") || "24h";
  if (range === "1an") return statsFromArchive(env); // au-delà des 90 j AE → archive KV
  const DAYS = { "24h": 1, "7d": 7, "30d": 30 };
  const days = DAYS[range] || 1;
  const T = "trempette_views";
  const WIN = `timestamp > NOW() - INTERVAL '${days}' DAY`;
  const N = (x) => Number(x) || 0;

  // Une requête par dimension de session (navigateur/OS/appareil/pays/referrer/mode).
  const dim = (col) =>
    aeQuery(env, `SELECT ${col} k, SUM(_sample_interval) n FROM ${T} WHERE ${WIN} GROUP BY k ORDER BY n DESC LIMIT 12`)
      .then((rows) => rows.map((r) => ({ k: r.k || "?", n: N(r.n) })));

  try {
    const [beaches, daily, hourly, browsers, os, devices, countries, referrers, modes] = await Promise.all([
      // Table plages : opens/favs/shares en une passe (agrégation conditionnelle).
      aeQuery(
        env,
        `SELECT blob2 beach, blob3 lake,
           SUM(IF(blob1='open',_sample_interval,0)) opens,
           SUM(IF(blob1='impression',_sample_interval,0)) impressions,
           SUM(IF(blob1='fav',_sample_interval,0)) favs,
           SUM(IF(blob1='share',_sample_interval,0)) shares
         FROM ${T} WHERE ${WIN} GROUP BY beach, lake ORDER BY opens DESC LIMIT 100`
      ),
      aeQuery(
        env,
        `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) day, SUM(IF(blob1='open',_sample_interval,0)) opens
         FROM ${T} WHERE ${WIN} GROUP BY day ORDER BY day`
      ),
      aeQuery(
        env,
        `SELECT toHour(timestamp) hour, SUM(IF(blob1='open',_sample_interval,0)) opens
         FROM ${T} WHERE ${WIN} GROUP BY hour ORDER BY hour`
      ),
      dim("blob4"),
      dim("blob5"),
      dim("blob6"),
      dim("blob7"),
      dim("blob8"),
      dim("blob9"),
    ]);

    // N'affiche que les plages encore présentes au catalogue (écarte les ids
    // de test/orphelins : AE ne permet pas de supprimer les events eux-mêmes).
    const validIds = new Set(((await getData(env)).beaches || []).map((b) => b.id));
    const beachRows = beaches
      .filter((r) => validIds.has(r.beach))
      .map((r) => ({
        beach: r.beach,
        lake: r.lake,
        opens: N(r.opens),
        impressions: N(r.impressions),
        favs: N(r.favs),
        shares: N(r.shares),
      }));

    // Agrégats dérivés (sans requête supplémentaire).
    const lakeMap = new Map();
    for (const b of beachRows) lakeMap.set(b.lake, (lakeMap.get(b.lake) || 0) + b.opens);
    const lakes = [...lakeMap.entries()].map(([lake, opens]) => ({ lake, opens })).sort((a, b) => b.opens - a.opens);

    // Visites/jour (Cloudflare Web Analytics) — best-effort : un échec côté RUM
    // ne doit pas faire échouer tout le dashboard.
    let visits = [];
    try {
      visits = await rumVisitsByDay(env, days);
    } catch (e) {
      console.warn("[stats] RUM KO", e);
    }

    const kpis = {
      visits: visits.length ? visits.reduce((s, v) => s + (v.visits || 0), 0) : null,
      opens: beachRows.reduce((s, b) => s + b.opens, 0),
      impressions: beachRows.reduce((s, b) => s + b.impressions, 0),
      favs: beachRows.reduce((s, b) => s + b.favs, 0),
      shares: beachRows.reduce((s, b) => s + b.shares, 0),
      beaches: beachRows.filter((b) => b.opens + b.impressions + b.favs + b.shares > 0).length,
      countries: countries.length,
    };

    return json({
      range,
      generatedAt: new Date().toISOString(),
      kpis,
      beaches: beachRows,
      lakes,
      daily: daily.map((r) => ({ day: r.day, opens: N(r.opens) })),
      visits,
      hourly: hourly.map((r) => ({ hour: N(r.hour), opens: N(r.opens) })),
      browsers,
      os,
      devices,
      countries,
      referrers,
      modes,
    });
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
}

const dayStr = (d) => d.toISOString().slice(0, 10); // "YYYY-MM-DD" en UTC

// Snapshot quotidien : agrège les jours complets depuis AE (rétention 90 j) et
// les archive dans KV pour conserver un historique au-delà. Idempotent : ne
// réécrit qu'une fois par jour (sauf force). Best-effort, ne bloque jamais le cron.
async function snapshotDailyStats(env, { force = false } = {}) {
  if (!env.CF_ACCOUNT_ID || !env.AE_API_TOKEN) return { skipped: "AE non configuré" };
  const today = dayStr(new Date());
  const cursor = await env.DATA.get(STATS_CURSOR_KEY);
  if (cursor === today && !force) return { skipped: "déjà fait aujourd'hui" };

  const rows = await aeQuery(
    env,
    `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) day, blob2 beach, blob3 lake,
       SUM(IF(blob1='open',_sample_interval,0)) opens,
       SUM(IF(blob1='impression',_sample_interval,0)) impressions,
       SUM(IF(blob1='fav',_sample_interval,0)) favs,
       SUM(IF(blob1='share',_sample_interval,0)) shares
     FROM trempette_views WHERE timestamp > NOW() - INTERVAL '90' DAY
     GROUP BY day, beach, lake LIMIT 10000`
  );

  const archive = (await env.DATA.get(STATS_DAILY_KEY, "json")) || {};
  const N = (x) => Number(x) || 0;
  // On ne fige que les jours COMPLETS (on saute la journée en cours).
  const fresh = {};
  for (const r of rows) {
    const date = String(r.day).slice(0, 10);
    if (date >= today) continue;
    const rec = (fresh[date] ||= { totals: { opens: 0, impressions: 0, favs: 0, shares: 0 }, beaches: {} });
    const o = N(r.opens), im = N(r.impressions), f = N(r.favs), s = N(r.shares);
    rec.totals.opens += o; rec.totals.impressions += im; rec.totals.favs += f; rec.totals.shares += s;
    rec.beaches[r.beach] = { lake: r.lake, opens: o, impressions: im, favs: f, shares: s };
  }
  // AE fait foi pour les 90 derniers jours ; KV conserve les jours plus anciens.
  for (const [date, rec] of Object.entries(fresh)) archive[date] = rec;

  // Plafonne à ~2 ans pour borner la taille de la valeur KV.
  const dates = Object.keys(archive).sort();
  for (const date of dates.slice(0, Math.max(0, dates.length - 760))) delete archive[date];

  await env.DATA.put(STATS_DAILY_KEY, JSON.stringify(archive));
  await env.DATA.put(STATS_CURSOR_KEY, today);
  return { ok: true, days: Object.keys(archive).length };
}

// Vue « 1 an » servie depuis l'archive KV (dimensions de session non conservées).
async function statsFromArchive(env) {
  const archive = (await env.DATA.get(STATS_DAILY_KEY, "json")) || {};
  const since = dayStr(new Date(Date.now() - 365 * 86400e3));
  const dates = Object.keys(archive).filter((d) => d >= since).sort();

  const validIds = new Set(((await getData(env)).beaches || []).map((b) => b.id));
  const beachMap = new Map();
  const daily = [];
  let opens = 0, impressions = 0, favs = 0, shares = 0;
  for (const date of dates) {
    const rec = archive[date];
    daily.push({ day: date + " 00:00:00", opens: rec.totals.opens });
    for (const [id, b] of Object.entries(rec.beaches)) {
      if (!validIds.has(id)) continue; // écarte les ids orphelins/tests
      opens += b.opens; impressions += b.impressions || 0; favs += b.favs; shares += b.shares;
      const cur = beachMap.get(id) || { beach: id, lake: b.lake, opens: 0, impressions: 0, favs: 0, shares: 0 };
      cur.opens += b.opens; cur.impressions += b.impressions || 0; cur.favs += b.favs; cur.shares += b.shares;
      beachMap.set(id, cur);
    }
  }
  const beaches = [...beachMap.values()].sort((a, b) => b.opens - a.opens).slice(0, 100);
  const lakeMap = new Map();
  for (const b of beaches) lakeMap.set(b.lake, (lakeMap.get(b.lake) || 0) + b.opens);
  const lakes = [...lakeMap.entries()].map(([lake, o]) => ({ lake, opens: o })).sort((a, b) => b.opens - a.opens);

  return json({
    range: "1an",
    archive: true,
    generatedAt: new Date().toISOString(),
    coverage: dates.length ? { from: dates[0], to: dates[dates.length - 1], days: dates.length } : null,
    kpis: { opens, impressions, favs, shares, beaches: beaches.length, countries: 0 },
    beaches,
    lakes,
    daily,
    hourly: [],
    browsers: [], os: [], devices: [], countries: [], referrers: [], modes: [],
  });
}

export default {
  // Déclenché par le Cron Trigger (voir wrangler.toml).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(regenerate(env));
    // Archive quotidienne des stats (idempotente : ne travaille qu'1×/jour).
    ctx.waitUntil(snapshotDailyStats(env).catch((e) => console.warn("[stats] snapshot KO", e)));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, ctx, url.pathname);
    }

    if (url.pathname === "/contact" && request.method === "POST") {
      return handleContact(request, env);
    }

    if (url.pathname === "/e" && request.method === "POST") {
      return handleEvent(request, env);
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

    // Sitemap dynamique (accueil + 5 lacs + toutes les plages).
    if (url.pathname === "/sitemap.xml") {
      return handleSitemap(await getData(env));
    }

    // Pages partageables / indexables par plage et par lac.
    if (url.pathname === "/lac" || url.pathname === "/lac/") {
      return Response.redirect(new URL("/", url).toString(), 302);
    }
    if (url.pathname.startsWith("/lac/")) {
      return handleLacRoute(request, env, url);
    }

    // Tout le reste = fichiers statiques (index.html, css, js, icônes…).
    return env.ASSETS.fetch(request);
  },
};
