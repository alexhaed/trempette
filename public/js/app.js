// App web statique : lit data.json (généré par le Worker Cloudflare) et l'affiche.
// Écran d'accueil « Immersif aquatique ». Aucun appel API direct ici — tout est
// pré-calculé côté Worker (cron).

const FAV_KEY = "templac_favoris"; // ordre des favoris (tableau d'ids), conservé d'avant le renommage
const COLLAPSE_KEY = "trempette_lacs_replies"; // lacs repliés en mode « Par lac »
// Lacs déjà vus : `collapsed` ne liste que les lacs REPLIÉS, donc un lac ajouté
// après coup en serait absent → affiché déplié. On mémorise les lacs connus pour
// replier automatiquement les nouveaux.
const SEEN_KEY = "trempette_lacs_vus";
// Migration : lacs existants avant l'ajout de la Gruyère. Sans cette liste, les
// utilisateurs ayant déjà une préférence verraient TOUS leurs lacs repliés.
const LAKES_BEFORE_SEEN = ["Léman", "Lac de Neuchâtel", "Lac de Bienne", "Lac de Morat", "Lac de Joux"];
// L'indice « clique sur une plage pour voir les détails » ne sert qu'au tout
// premier contact : dès qu'un détail a été ouvert (une fois, mémorisé), on le retire.
const TAP_KEY = "trempette_detail_vu";
let detailSeen = false;
try { detailSeen = localStorage.getItem(TAP_KEY) === "1"; } catch (e) {}

// --- URLs partageables /lac/<lac>/<plage> (mêmes slugs que le Worker) ---
// Titre d'accueil figé : sur un deep link, le Worker a déjà réécrit <title> avec
// le nom de la plage, donc on ne peut pas le lire depuis document.title ici.
const DEFAULT_TITLE = "Trempette — Températures des lacs romands";
const LAKE_SLUG = { geneva: "leman", neuchatel: "neuchatel", biel: "bienne", murten: "morat", joux: "joux", gruyere: "gruyere" };
const slugify = (s) =>
  String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const beachPath = (b) => `/lac/${LAKE_SLUG[b.lake] || slugify(b.lakeName)}/${slugify(b.name)}`;

// Statistiques de consultation : ping best-effort vers le Worker (POST /e).
// Appareil/navigateur/pays sont déduits côté serveur ; ici on n'envoie que
// plage + lac + type + referrer + mode d'affichage. Jamais bloquant.
function track(type, b) {
  if (!b || !navigator.sendBeacon) return;
  try {
    const standalone =
      (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
    navigator.sendBeacon(
      "/e",
      JSON.stringify({
        b: b.id,
        l: LAKE_SLUG[b.lake] || slugify(b.lakeName),
        t: type,
        r: document.referrer || "",
        m: standalone ? "standalone" : "browser",
      })
    );
  } catch {
    /* analytics best-effort */
  }
}
function beachFromPath(pathname) {
  const m = pathname.match(/^\/lac\/([^/]+)\/([^/]+)\/?$/);
  if (!m) return null;
  const lake = decodeURIComponent(m[1]).toLowerCase();
  const slug = decodeURIComponent(m[2]).toLowerCase();
  return state.beaches.find((b) => (LAKE_SLUG[b.lake] || slugify(b.lakeName)) === lake && slugify(b.name) === slug) || null;
}
// /lac/<lac> (sans plage) → slug du lac, sinon null.
function lakeSlugFromPath(pathname) {
  const m = pathname.match(/^\/lac\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}
// slug de lac → nom d'affichage du lac (clé de regroupement « Par lac »).
function lakeNameFromSlug(slug) {
  const b = state.beaches.find((x) => (LAKE_SLUG[x.lake] || slugify(x.lakeName)) === slug);
  return b ? b.lakeName : null;
}

const state = {
  beaches: [],
  updatedAt: null,
  tips: [], // astuces « Le savais-tu ? » (servies dans data.json)
  sort: "lake", // défaut : Par lac
  favOrder: loadFavOrder(), // tableau ordonné d'ids favoris
  collapsed: loadCollapsed(), // Set de noms de lacs repliés
  userPos: null, // {lat,lng} si géolocalisé (mode « proximité »)
  heroIdx: 0,
};

// Distance haversine (km) entre deux points lat/lng.
function distanceKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function fmtDist(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1).replace(".", ",")} km`;
}

const $ = (sel) => document.querySelector(sel);
const listEl = $("#list");

function loadFavOrder() {
  try {
    const v = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveFavOrder() {
  localStorage.setItem(FAV_KEY, JSON.stringify(state.favOrder));
}
const isFav = (id) => state.favOrder.includes(id);

function loadCollapsed() {
  const raw = localStorage.getItem(COLLAPSE_KEY);
  if (raw === null) return null; // aucune préférence : défaut calculé au 1er rendu « Par lac »
  try {
    const v = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set();
  }
}
function saveCollapsed() {
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...state.collapsed]));
}
function loadSeen() {
  const raw = localStorage.getItem(SEEN_KEY);
  if (raw === null) return new Set(LAKES_BEFORE_SEEN); // 1re exécution de ce code
  try {
    const v = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set(LAKES_BEFORE_SEEN);
  }
}
function saveSeen(lakes) {
  localStorage.setItem(SEEN_KEY, JSON.stringify(lakes));
}
function toggleLake(lake) {
  if (state.collapsed.has(lake)) state.collapsed.delete(lake);
  else state.collapsed.add(lake);
  saveCollapsed();
}

// ---- Chargement des données ----
let lastLoadedAt = 0;
let routeApplied = false; // applyInitialRoute() ne doit s'exécuter qu'une fois

async function load() {
  try {
    const r = await fetch(`/data.json?t=${Math.floor(Date.now() / 60000)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    state.beaches = data.beaches || [];
    state.updatedAt = data.updatedAt;
    state.tips = Array.isArray(data.tips) ? data.tips : [];
    // Purge les favoris dont la plage n'existe plus.
    const ids = new Set(state.beaches.map((b) => b.id));
    state.favOrder = state.favOrder.filter((id) => ids.has(id));
    lastLoadedAt = Date.now();
    renderAll();
    // Astuce tirée une seule fois par chargement (pas à chaque renderAll, pour
    // ne pas la faire sauter quand on change de tri / favori).
    renderTip();
    // Deep link : ouvre le détail si l'URL cible une plage (une seule fois).
    if (!routeApplied) {
      routeApplied = true;
      applyInitialRoute();
    }
    // Bloc SEO servi par le Worker (/lac/…) : l'app affiche désormais le même
    // contenu (liste + overlay), on le retire pour éviter le doublon. Retiré
    // SEULEMENT ici, en cas de succès : si le chargement échoue, il reste la
    // seule information à l'écran.
    document.querySelectorAll(".seo-static").forEach((el) => el.remove());
  } catch (e) {
    listEl.innerHTML = `<p class="empty">Impossible de charger les données.<br>${e.message}</p>`;
  }
}

// Rafraîchit les données quand l'utilisateur revient sur la page après un
// moment (onglet rouvert, PWA iOS restée ouverte en arrière-plan…). Seuil pour
// éviter de refetcher à chaque bascule rapide d'onglet.
const STALE_AFTER = 3 * 60 * 1000; // 3 min
function refreshIfStale() {
  if (document.visibilityState === "visible" && Date.now() - lastLoadedAt > STALE_AFTER) {
    load();
  }
}
document.addEventListener("visibilitychange", refreshIfStale);
// pageshow couvre la restauration depuis le bfcache (retour arrière navigateur).
window.addEventListener("pageshow", (e) => {
  if (e.persisted) refreshIfStale();
});

// ---- Helpers ----
const byId = (id) => state.beaches.find((b) => b.id === id);

function fmt(v) {
  // 1 décimale, virgule française.
  return v == null ? null : (Math.round(v * 10) / 10).toFixed(1).replace(".", ",");
}
function verdict(t) {
  if (t == null) return "";
  if (t < 16.5) return "Frisquet";
  if (t < 19) return "Vivifiant";
  if (t < 21) return "Agréable";
  if (t < 23) return "Parfait";
  return "Comme un bain";
}
function trendInfo(slope) {
  if (slope == null) return { cls: "", txt: "" };
  if (slope > 0.05) return { cls: "trend-up", txt: `Se réchauffe (+${slope.toFixed(2)}\u00A0°C/h)` };
  if (slope < -0.05) return { cls: "trend-down", txt: `Se refroidit (${slope.toFixed(2)}\u00A0°C/h)` };
  return { cls: "trend-flat", txt: "Stable" };
}
// La flèche pointe vers où VA le vent : direction d'origine + 180°.
function windAngle(deg) {
  return deg == null ? null : (deg + 180) % 360;
}

// ---- Prévision 24 h glissantes : phrase du pic + sparkline ----
// `b.fc` = { t0 ISO, step (h), v: [°C], peak: { at, temp } }, calculé côté
// Worker depuis la fenêtre Alplakes déjà téléchargée (aucun appel de plus).

// Heure locale (Europe/Zurich) au format « 18 h », + « demain » si autre jour.
function peakWhen(at) {
  const d = new Date(at);
  const opt = { timeZone: "Europe/Zurich" };
  // formatToParts : on récupère le NOMBRE seul (fr-CH formate déjà « 21 h »,
  // ce qui doublonnait avec le « h » ajouté ensuite).
  // Number() : évite « 00 h » / « 08 h » (fr-CH complète parfois à 2 chiffres).
  const h = Number(
    new Intl.DateTimeFormat("fr-CH", { ...opt, hour: "numeric", hourCycle: "h23" })
      .formatToParts(d)
      .find((p) => p.type === "hour").value
  );
  const sameDay = d.toLocaleDateString("fr-CH", opt) === new Date().toLocaleDateString("fr-CH", opt);
  return `${sameDay ? "" : "demain "}vers ${h} h`;
}

// Lissage cubique MONOTONE (Fritsch-Carlson) → Bézier.
// Pas un Catmull-Rom uniforme : nos points ne sont PAS équidistants (le premier
// intervalle « maintenant → 1er point du modèle » est bien plus court que les
// 3 h suivantes). Les tangentes calculées sur p2−p0 projetaient alors les points
// de contrôle trop loin, et la courbe dépassait les valeurs réelles.
// Ici les tangentes sont bornées : la courbe ne sort JAMAIS de l'intervalle des
// points — aucune température inventée au-dessus du max ni sous le min.
function smoothPath(p) {
  const n = p.length;
  if (n < 3) return p.map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(" ");
  const dx = [], d = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = p[i + 1].x - p[i].x;
    d[i] = (p[i + 1].y - p[i].y) / dx[i];
  }
  // Tangentes : moyenne des pentes voisines, forcées à 0 sur un extremum local.
  const m = [d[0]];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  m[n - 1] = d[n - 2];
  // Bornage Fritsch-Carlson : garantit la monotonie segment par segment.
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  let out = `M${p[0].x.toFixed(1)} ${p[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    out += ` C${(p[i].x + h).toFixed(1)} ${(p[i].y + m[i] * h).toFixed(1)},` +
      ` ${(p[i + 1].x - h).toFixed(1)} ${(p[i + 1].y - m[i + 1] * h).toFixed(1)},` +
      ` ${p[i + 1].x.toFixed(1)} ${p[i + 1].y.toFixed(1)}`;
  }
  return out;
}

// Courbe compacte + graduations discrètes (min/max en °C, heures rondes).
// Les points sont placés selon le TEMPS (le 1er intervalle est plus court :
// on préfixe la valeur actuelle), pas selon leur index.
function sparkline(pts, bestIdx, gridStart = 0) {
  const W = 300, H = 76;            // hauteur : place pour les libellés d'heures
  const L = 34, R = 294, TOP = 9, BOT = 50; // zone de tracé
  const ts = pts.map((p) => p.t);
  const vs = pts.map((p) => p.v);
  const t0 = ts[0], t1 = ts[ts.length - 1];
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi - lo < 0.6) { const m = (hi + lo) / 2; lo = m - 0.3; hi = m + 0.3; } // évite la ligne plate
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (R - L);
  const y = (v) => TOP + (1 - (v - lo) / (hi - lo)) * (BOT - TOP);

  const xy = pts.map((p) => ({ x: x(p.t), y: y(p.v) }));
  const d = smoothPath(xy);
  const area = `${d} L${R} ${BOT} L${L} ${BOT} Z`;

  // Graduations Y : seulement min et max (2 repères suffisent, restent lisibles).
  const grid = [hi, lo]
    .map((v) => `<line class="grid" x1="${L}" y1="${y(v).toFixed(1)}" x2="${R}" y2="${y(v).toFixed(1)}"></line>` +
      `<text class="ylab" x="${L - 5}" y="${(y(v) + 3).toFixed(1)}">${fmt(v)}°</text>`)
    .join("");

  // Graduations X : un repère tous les 2 points du modèle (= 6 h). On ne filtre
  // PAS sur des heures rondes : la grille Alplakes est à 3 h UTC, ce qui tombe
  // en local sur 2/5/8/11 h… (jamais un multiple de 6). L'index reste régulier.
  const hourOf = (t) => Number(new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", hour: "numeric", hourCycle: "h23" })
    .formatToParts(new Date(t)).find((q) => q.type === "hour").value);
  const first = gridStart; // indice du 1er point du modèle (0, ou 1 si « maintenant » préfixé)
  const hasNow = gridStart === 1; // pts[0] est la valeur actuelle (préfixée)
  // Ancrage adapté aux bords : centré déborderait du viewBox (libellé coupé).
  const anchor = (px) => (px < 16 ? "start" : px > W - 16 ? "end" : "middle");
  const labels = [];
  // Ancre le bord gauche sur « maintenant » : lève l'ambiguïté passé/futur.
  // Sans ce repère, la 1re heure ronde (ex. « 23 h ») + la fenêtre qui passe
  // minuit (23 h → 5 h → 11 h → 17 h) se lisaient comme un historique.
  if (hasNow) {
    labels.push(`<text class="xlab xnow" text-anchor="start" x="${L}" y="${H - 6}">maintenant</text>`);
  }
  // Heures rondes : sélection par POSITION (et non par index). Un pas d'index
  // fixe échouait sur une fenêtre courte (peu de points) : l'axe se retrouvait
  // vide. Ici on écarte seulement la zone « maintenant » (gauche), puis on prend
  // les points en respectant un écart minimal → toujours ≥ 1 repère utile, et le
  // repère le plus à droite (souvent le pic) reste affiché.
  const leftBound = hasNow ? L + 60 : L - 1; // laisse la place au libellé « maintenant »
  const MIN_GAP = 52;
  let lastX = -Infinity;
  for (let i = first; i < pts.length; i++) {
    const px = x(pts[i].t);
    if (px < leftBound || px > R || px - lastX < MIN_GAP) continue;
    labels.push(`<text class="xlab" text-anchor="${anchor(px)}" x="${px.toFixed(1)}" y="${H - 6}">${hourOf(pts[i].t)} h</text>`);
    lastX = px;
  }
  const xlab = labels.join("");

  // Point marquant le maximum de la courbe AFFICHÉE (peut être « maintenant »).
  const pkDot = `<circle class="pkdot" cx="${xy[bestIdx].x.toFixed(1)}" cy="${xy[bestIdx].y.toFixed(1)}" r="3.6"></circle>`;
  // Point « maintenant » : inutile s'il coïncide avec le maximum.
  const nowDot = bestIdx === 0
    ? ""
    : `<circle class="nowdot" cx="${xy[0].x.toFixed(1)}" cy="${xy[0].y.toFixed(1)}" r="2.6"></circle>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Température de l'eau prévue des prochaines 24 h">` +
    `${grid}<path class="sf" d="${area}"></path><path class="sl" d="${d}"></path>` +
    `${nowDot}${pkDot}${xlab}</svg>`;
}

function renderForecast(b) {
  const line = $("#d-peak");
  const box = $("#d-spark");
  const trend = $("#d-trend-txt");
  const fc = b.fc;
  if (!fc || !Array.isArray(fc.v) || fc.v.length < 3) {
    // Pas de prévision : on garde l'ancienne ligne (point suivant / tendance),
    // sinon on perdrait toute indication d'évolution.
    trend.textContent = forecastText(b);
    trend.hidden = false;
    line.hidden = box.hidden = true;
    box.innerHTML = "";
    return;
  }
  // La phrase du pic + la courbe remplacent la ligne « Température prévue à… ».
  trend.hidden = true;
  const now = Date.now();
  const t0 = new Date(fc.t0).getTime();
  const stepMs = (fc.step || 3) * 3600e3;
  const pts = [];
  // La courbe démarre sur la température affichée, pour rester cohérente.
  if (b.water != null && now < t0) pts.push({ t: now, v: b.water });
  fc.v.forEach((v, i) => pts.push({ t: t0 + i * stepMs, v }));

  // Maximum de la courbe AFFICHÉE (et non `fc.peak`, calculé côté serveur sur
  // les seuls points futurs) : si la température actuelle dépasse toute la suite,
  // le vrai maximum est le 1er point.
  let maxIdx = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].v > pts[maxIdx].v) maxIdx = i;
  const best = pts[maxIdx];
  // Écart mesuré sur la COURBE affichée (pts[0] = « maintenant ») : le texte doit
  // décrire ce que l'utilisateur voit, et rien d'autre.
  const gain = best.v - pts[0].v;
  // Le point crème marque TOUJOURS le maximum de la courbe, et la phrase parle
  // toujours de ce même point. Auparavant, un gain ≤ 0,2° renvoyait phrase et
  // point sur « maintenant » alors que la courbe montait plus haut ensuite :
  // l'axe affichait 24,9° pendant que la phrase annonçait 24,7° comme maximum.
  // On nomme donc la hausse même quand elle est imperceptible — en le disant.
  line.innerHTML =
    maxIdx === 0
      ? "C'est le plus chaud des prochaines 24 h."
      : gain > 0.2
        ? `Le plus chaud <span class="pk">${peakWhen(best.t)}</span> (${fmt(best.v)}°)`
        : `À peine plus chaud <span class="pk">${peakWhen(best.t)}</span> (${fmt(best.v)}°)`;
  box.innerHTML = sparkline(pts, maxIdx, pts.length > fc.v.length ? 1 : 0);
  line.hidden = box.hidden = false;
}

// Météo (codes WMO open-meteo) → icône (id de symbole SVG) + libellé « Ciel ».
// isDay : 0 = nuit ; 1/null → jour par défaut (variantes soleil/lune).
function weather(code, isDay) {
  if (code == null) return null;
  const day = isDay !== 0;
  const M = [
    [[0], day ? "i-sun" : "i-wx-moon", "Dégagé"],
    [[1], day ? "i-wx-pcloud-day" : "i-wx-pcloud-night", "Beau temps"],
    [[2], day ? "i-wx-pcloud-day" : "i-wx-pcloud-night", "Éclaircies"],
    [[3], "i-wx-cloud", "Couvert"],
    [[45, 48], "i-wx-fog", "Brouillard"],
    [[51, 53, 55, 56, 57], "i-wx-rain", "Bruine"],
    [[61, 63, 65, 66, 67], "i-wx-rain", "Pluie"],
    [[80, 81, 82], "i-wx-rain", "Averses"],
    [[71, 73, 75, 77, 85, 86], "i-wx-snow", "Neige"],
    [[95, 96, 99], "i-wx-thunder", "Orage"],
  ];
  for (const [codes, id, label] of M) if (codes.includes(code)) return { id, label };
  return { id: "i-wx-cloud", label: "—" };
}
function norm(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

// WGS84 → coordonnées suisses LV95 (EPSG:2056), formule approchée officielle
// swisstopo. Vérifiée à ~5 cm près contre le service REFRAME.
function wgs84ToLv95(lat, lng) {
  const phi = (lat * 3600 - 169028.66) / 10000;
  const lam = (lng * 3600 - 26782.5) / 10000;
  const E =
    2600072.37 + 211455.93 * lam - 10938.51 * lam * phi - 0.36 * lam * phi * phi - 44.54 * lam ** 3;
  const N =
    1200147.07 + 308807.95 * phi + 3745.25 * lam * lam + 76.63 * phi * phi -
    194.56 * lam * lam * phi + 119.79 * phi ** 3;
  return { E: Math.round(E), N: Math.round(N) };
}
function mapUrl(b) {
  const { E, N } = wgs84ToLv95(b.lat, b.lng);
  // bgLayer=ch.swisstopo.swissimage → fond aérien (SWISSIMAGE) au lieu de la carte.
  return `https://map.geo.admin.ch/#/map?center=${E},${N}&z=10&bgLayer=ch.swisstopo.swissimage&crosshair=marker`;
}

const svgUse = (id, size, style) =>
  `<svg width="${size}" height="${size}"${style ? ` style="${style}"` : ""} aria-hidden="true"><use href="#${id}"></use></svg>`;

// ---- Rendu global ----
function renderAll() {
  renderHero();
  renderList();
  renderUpdated();
}

// ---- Hero « Mes plages » (carrousel des favoris) ----
function renderHero() {
  const track = $("#hero-track");
  const dots = $("#hero-dots");
  const favs = state.favOrder.map(byId).filter(Boolean);
  // La réservation de hauteur (anti-CLS, posée d'abord par le script en <head>)
  // doit suivre l'état RÉEL : si aucune carte favori ne s'affiche (favoris vides
  // ou ids périmés), on retire .has-favs pour que le hero reste compact.
  document.documentElement.classList.toggle("has-favs", favs.length > 0);

  // Aucun favori : on masque toute la section « Mes plages » plutôt que d'afficher
  // un placeholder qui occupe le haut de l'écran au détriment des températures.
  const section = $("#hero");
  if (favs.length === 0) {
    if (section) section.hidden = true;
    track.innerHTML = "";
    dots.innerHTML = "";
    return;
  }
  if (section) section.hidden = false;

  if (state.heroIdx >= favs.length) state.heroIdx = 0;

  track.innerHTML = favs.map((b) => heroCard(b)).join("");
  dots.innerHTML = favs.map((_, i) => `<i class="${i === state.heroIdx ? "on" : ""}"></i>`).join("");

  // Clic sur une carte → détail.
  track.querySelectorAll(".hero-card").forEach((el, i) => {
    el.addEventListener("click", () => openDetail(favs[i]));
  });

  scheduleHeroImpression(); // compte la carte centrée comme « vue » (après pose)
}

// ---- Impressions du hero ----
// Une carte favori est comptée « vue » quand elle reste centrée un court
// instant (pose), une seule fois par session, et seulement si le hero est
// réellement visible (pas d'overlay détail/infos ouvert, onglet actif).
const heroSeen = new Set();
let heroImpTimer = null;
function scheduleHeroImpression() {
  clearTimeout(heroImpTimer);
  heroImpTimer = setTimeout(() => {
    if (document.hidden) return;
    if (!$("#detail").hidden || !$("#info").hidden) return; // hero masqué par un overlay
    const favs = state.favOrder.map(byId).filter(Boolean);
    const b = favs[state.heroIdx];
    if (!b || heroSeen.has(b.id)) return;
    heroSeen.add(b.id);
    track("impression", b);
  }, 1200);
}

function heroCard(b) {
  const water = fmt(b.water);
  const ang = windAngle(b.windDir);
  return `
    <div class="hero-card" data-id="${b.id}">
      <span class="hero-card-dist">${svgUse("i-pin", 14)} ${b.group || b.lakeName}</span>
      <div class="hero-card-name">${b.name}</div>
      <div class="hero-card-sub">${b.lakeName}</div>
      <div class="hero-card-temp${water == null ? " na" : ""}">${
        water != null ? `${water}<span class="deg">°</span>` : "n/d"
      }</div>
      ${b.water != null ? `<div class="verdict-badge">${verdict(b.water)}</div>` : ""}
      <div class="hero-tiles">
        <div class="tile tile-air">
          <div class="tile-label">${svgUse("i-sun", 15)} Air</div>
          <div class="tile-val">${b.air != null ? `${Math.round(b.air)}°` : "n/d"}</div>
        </div>
        <div class="tile tile-wind">
          <div class="tile-label">${svgUse("i-wind", 15)} Vent</div>
          <div class="tile-wind-row">
            <span class="wind-pill">${svgUse("i-arrowup", 15, ang != null ? `transform:rotate(${ang}deg)` : "")}</span>
            <span class="tile-val">${b.wind != null ? `${Math.round(b.wind)}\u00A0km/h` : "n/d"}</span>
          </div>
        </div>
      </div>
    </div>`;
}

// Synchronise les points de pagination au défilement du carrousel.
$("#hero-track").addEventListener(
  "scroll",
  () => {
    const track = $("#hero-track");
    const idx = Math.round(track.scrollLeft / track.clientWidth);
    if (idx !== state.heroIdx) {
      state.heroIdx = idx;
      $("#hero-dots").querySelectorAll("i").forEach((d, i) => d.classList.toggle("on", i === idx));
      scheduleHeroImpression(); // nouvelle carte centrée
    }
  },
  { passive: true }
);

// ---- Liste des plages ----
function visibleBeaches() {
  if (state.sort === "fav") {
    const items = state.favOrder.map(byId).filter(Boolean);
    return { groups: [{ header: null, items }] };
  }

  if (state.sort === "warm") {
    return { groups: [{ header: null, items: sortWarm(state.beaches) }] };
  }

  if (state.sort === "near" && state.userPos) {
    const { lat, lng } = state.userPos;
    const items = [...state.beaches].sort(
      (a, b) => distanceKm(lat, lng, a.lat, a.lng) - distanceKm(lat, lng, b.lat, b.lng)
    );
    return { groups: [{ header: null, items }] };
  }

  // Par lac : groupes ordonnés par nombre de plages décroissant (égalité →
  // alphabétique). À l'intérieur, on garde l'ordre du fichier (≈ géographique).
  const byLake = new Map();
  for (const b of state.beaches) {
    if (!byLake.has(b.lakeName)) byLake.set(b.lakeName, []);
    byLake.get(b.lakeName).push(b);
  }
  const lakes = [...byLake.keys()].sort(
    (a, b) => byLake.get(b).length - byLake.get(a).length || a.localeCompare(b)
  );
  // Défaut au tout 1er affichage (aucune préférence enregistrée) : seul le
  // Léman ouvert, les autres lacs repliés.
  if (state.collapsed === null) {
    state.collapsed = new Set(lakes.filter((l) => l !== "Léman"));
    saveCollapsed();
    saveSeen(lakes);
  } else {
    // Lac ajouté depuis la dernière visite : absent du set « replié », il
    // s'afficherait déplié → on le replie explicitement (sauf le Léman).
    const seen = loadSeen();
    const nouveaux = lakes.filter((l) => !seen.has(l));
    if (nouveaux.length) {
      for (const l of nouveaux) if (l !== "Léman") state.collapsed.add(l);
      saveCollapsed();
      saveSeen(lakes);
    }
  }
  return { groups: lakes.map((lake) => ({ header: lake, items: byLake.get(lake) })) };
}
const sortWarm = (arr) => [...arr].sort((a, b) => (b.water ?? -99) - (a.water ?? -99));

function renderList() {
  const isFavMode = state.sort === "fav";
  $("#reorder-hint").hidden = !isFavMode || state.favOrder.length < 2;

  const { groups } = visibleBeaches();
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  // Indice « voir les détails » : modes hors Favoris, s'il y a des plages, et
  // tant que l'utilisateur n'a jamais ouvert de détail (geste alors acquis).
  $("#tap-hint").hidden = isFavMode || total < 1 || detailSeen;

  listEl.innerHTML = "";
  if (total === 0) {
    if (state.sort === "fav") {
      // Comme l'échec de géoloc : un repli « Voir par lac » plutôt qu'un cul-de-sac.
      listEl.innerHTML = `<div class="empty geoloc-fail">
        <p>Aucun favori — touche l'étoile pour ajouter une plage.</p>
        <div class="geoloc-actions">
          <button type="button" class="geoloc-back">Voir par lac</button>
        </div>
      </div>`;
      listEl.querySelector(".geoloc-back").addEventListener("click", goToLakeView);
    } else {
      listEl.innerHTML = `<p class="empty">Aucune plage trouvée.</p>`;
    }
    return;
  }

  const frag = document.createDocumentFragment();
  for (const g of groups) {
    if (g.header) {
      // Vrai nom du lac : on garde "Lac de …" tel quel et on ne préfixe "Lac "
      // que lorsqu'il manque (cas du Léman, stocké sans préfixe).
      const label = /^lac\b/i.test(g.header) ? g.header : `Lac ${g.header}`;
      const collapsed = state.collapsed.has(g.header);
      const h = document.createElement("button");
      h.type = "button";
      h.className = "group-title" + (collapsed ? " collapsed" : "");
      h.dataset.lake = g.header;
      h.setAttribute("aria-expanded", String(!collapsed));
      h.innerHTML =
        `${svgUse("i-waves", 14)}<span class="gt-name">${label}</span>` +
        `<span class="gt-count">${g.items.length}</span>` +
        `${svgUse("i-chevron", 16, "")}`;
      h.querySelector("svg:last-child").classList.add("gt-chev");
      h.addEventListener("click", () => {
        toggleLake(g.header);
        renderList();
      });
      frag.appendChild(h);
      if (collapsed) continue; // plages masquées tant que le lac est replié
    }
    for (const b of g.items) frag.appendChild(beachRow(b, isFavMode));
  }
  listEl.appendChild(frag);
}

function beachRow(b, isFavMode) {
  const row = document.createElement("div");
  row.className = "beach";
  row.dataset.id = b.id;

  const water = fmt(b.water);
  // Par lac : sous-titre = commune/région ; sinon = lac.
  let sub = state.sort === "lake" ? b.group || b.lakeName : b.lakeName;
  // Mode proximité : préfixe la distance depuis la position de l'utilisateur.
  if (state.sort === "near" && state.userPos) {
    const km = distanceKm(state.userPos.lat, state.userPos.lng, b.lat, b.lng);
    sub = `<span class="dist-badge">${fmtDist(km)}</span> · ${b.lakeName}`;
  }
  const fav = isFav(b.id);
  const wx = weather(b.weatherCode, b.isDay);
  const wxHtml = wx ? `<span class="beach-wx" title="${wx.label}" aria-label="Ciel : ${wx.label}">${svgUse(wx.id, 17)}</span>` : "";

  row.innerHTML = `
    ${isFavMode ? `<button class="drag-handle" aria-label="Réordonner">${svgUse("i-grip", 18)}</button>` : ""}
    <div class="beach-main">
      <a class="beach-name" href="${beachPath(b)}">${b.name}</a>
      <div class="beach-sub">${sub}</div>
    </div>
    ${wxHtml}
    <div class="beach-temp${water == null ? " na" : ""}">${water != null ? `${water}°` : "n/d"}</div>
    <button class="beach-star ${fav ? "on" : ""}" aria-label="${fav ? "Retirer des favoris" : "Ajouter aux favoris"}" aria-pressed="${fav}">${svgUse("i-star", 22)}</button>`;

  row.querySelector(".beach-star").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFav(b.id);
  });
  row.addEventListener("click", (e) => {
    // Le nom de plage est un vrai <a href> (lien interne crawlable pour le SEO).
    // Clic normal → on ouvre l'overlay (SPA) au lieu de naviguer ; cmd/ctrl-clic →
    // on laisse le navigateur ouvrir la page dans un nouvel onglet.
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    openDetail(b);
  });
  if (isFavMode) {
    row.querySelector(".drag-handle").addEventListener("pointerdown", (e) => startDrag(e, b.id));
  }
  return row;
}

function renderUpdated() {
  const el = $("#updated");
  if (!state.updatedAt) {
    el.textContent = "";
    return;
  }
  const d = new Date(state.updatedAt);
  const date = d.toLocaleDateString("fr-CH", { day: "2-digit", month: "2-digit" });
  const heure = d.toLocaleTimeString("fr-CH", { hour: "2-digit", minute: "2-digit" });
  el.textContent = `Mis à jour le ${date} à ${heure}`;
}

// ---- « Le savais-tu ? » ----
// Affiche une astuce au hasard. href "#info" ouvre l'overlay Infos & contact ;
// une URL externe s'ouvre dans un nouvel onglet ; un chemin interne navigue.
function renderTip() {
  const box = $("#tip");
  const body = $("#tip-body");
  if (!box || !body) return;
  if (!state.tips.length) {
    box.hidden = true;
    return;
  }
  // En mode installé (standalone), inutile de proposer « ajouter à l'écran
  // d'accueil » → on écarte ces astuces du tirage.
  // N'affiche que les astuces actives (case cochée en admin ; défaut = actif).
  let pool = state.tips.filter((t) => t.enabled !== false);
  if (isStandalone()) pool = pool.filter((t) => t.href !== "#install");
  if (!pool.length) { box.hidden = true; return; }
  const t = pool[Math.floor(Math.random() * pool.length)];
  body.textContent = t.text || "";
  if (t.cta && t.href) {
    body.append(" ");
    const a = document.createElement("a");
    a.textContent = t.cta;
    a.href = t.href;
    if (t.href === "#info") {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        openInfo();
      });
    } else if (t.href === "#install") {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        openInstall();
      });
    } else if (/^https?:/i.test(t.href)) {
      a.target = "_blank";
      a.rel = "noopener";
    }
    body.appendChild(a);
  }
  box.hidden = false;
}

// ---- Favoris ----
function toggleFav(id) {
  const i = state.favOrder.indexOf(id);
  if (i >= 0) state.favOrder.splice(i, 1);
  else {
    state.favOrder.push(id);
    track("fav", byId(id)); // on ne compte que l'ajout en favori
  }
  saveFavOrder();
  renderAll();
}

// ---- Réordonnancement par glisser-déposer (mode Favoris) ----
let drag = null;
function startDrag(e, id) {
  e.preventDefault();
  drag = { id, pm: (ev) => onDragMove(ev), pu: () => endDrag() };
  document.addEventListener("pointermove", drag.pm, { passive: false });
  document.addEventListener("pointerup", drag.pu);
  document.addEventListener("pointercancel", drag.pu);
  drag.prevSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";
  document.body.style.webkitUserSelect = "none";
  const row = listEl.querySelector(`.beach[data-id="${id}"]`);
  if (row) {
    row.classList.add("lifted");
    row.querySelector(".drag-handle")?.classList.add("grabbing");
  }
}
function clearSelection() {
  const s = window.getSelection && window.getSelection();
  if (s && !s.isCollapsed) s.removeAllRanges();
}
function onDragMove(e) {
  if (!drag) return;
  if (e.cancelable) e.preventDefault();
  clearSelection();
  const rows = [...listEl.querySelectorAll(".beach")];
  if (!rows.length) return;
  const y = e.clientY;
  let target = rows.length - 1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) {
      target = i;
      break;
    }
  }
  const order = state.favOrder.slice();
  const from = order.indexOf(drag.id);
  if (from < 0 || target === from) return;
  order.splice(from, 1);
  order.splice(target, 0, drag.id);
  state.favOrder = order;
  saveFavOrder();
  // Re-rendu liste + carrousel (l'ordre pilote le hero).
  renderList();
  renderHero();
  listEl.querySelector(`.beach[data-id="${drag.id}"]`)?.classList.add("lifted");
  listEl.querySelector(`.beach[data-id="${drag.id}"] .drag-handle`)?.classList.add("grabbing");
}
function endDrag() {
  if (!drag) return;
  document.removeEventListener("pointermove", drag.pm);
  document.removeEventListener("pointerup", drag.pu);
  document.removeEventListener("pointercancel", drag.pu);
  document.body.style.userSelect = drag.prevSelect || "";
  document.body.style.webkitUserSelect = drag.prevSelect || "";
  clearSelection();
  drag = null;
  renderList();
}

// ---- Vue détail (overlay) ----
// Texte de prévision : prochain point du modèle Alplakes (marques 3 h UTC),
// affiché à l'heure locale. Repli sur la tendance si pas de point de prévision.
function forecastText(b) {
  if (b.next && b.next.temp != null) {
    const d = new Date(b.next.at);
    const [hh, mm] = d
      .toLocaleTimeString("fr-CH", { hour: "2-digit", minute: "2-digit", hour12: false })
      .split(":");
    const heure = mm === "00" ? `${parseInt(hh, 10)}h` : `${hh}h${mm}`;
    return `Température prévue à ${heure} : ${fmt(b.next.temp)}°`;
  }
  return trendInfo(b.trend).txt;
}

// Bloc de contenu unique et VISIBLE par plage (SEO longue traîne + utilité).
// Tout est tiré des données du jour → chaque plage a un texte différent (pas de
// « thin content » : ni paragraphe figé, ni contenu caché/noscript).
function renderAbout(b) {
  const box = $("#d-about");
  if (!box) return;
  const w = b.water;
  if (w == null) { box.hidden = true; box.innerHTML = ""; return; }

  // Plages du même lac AYANT une mesure → classement + moyenne du jour.
  const peers = state.beaches.filter((x) => x.lakeName === b.lakeName && x.water != null);
  let rankTxt = "";
  let avgTxt = "";
  if (peers.length >= 3) {
    const sorted = [...peers].sort((a, c) => c.water - a.water);
    const rank = sorted.findIndex((x) => x.id === b.id) + 1;
    rankTxt = rank === 1
      ? `la plage la plus chaude du ${b.lakeName} aujourd'hui`
      : `la ${rank}e plage la plus chaude du ${b.lakeName} aujourd'hui`;
    const avg = peers.reduce((s, x) => s + x.water, 0) / peers.length;
    const d = w - avg;
    avgTxt = Math.abs(d) < 0.3
      ? "dans la moyenne du lac"
      : `~${fmt(Math.abs(d))}\u00A0°C ${d > 0 ? "au-dessus" : "en dessous"} de la moyenne du lac`;
  }

  // Tendance à partir de la prévision (pic serveur sur les points futurs).
  let trendTxt = "";
  const fc = b.fc;
  if (fc && fc.peak && typeof fc.peak.temp === "number" && Array.isArray(fc.v) && fc.v.length) {
    const gain = fc.peak.temp - w;
    if (gain > 0.2) trendTxt = `Tendance en hausse, pic attendu ${peakWhen(fc.peak.at)}.`;
    else if (w - fc.v[fc.v.length - 1] > 0.2) trendTxt = "Tendance en légère baisse ces prochaines heures.";
    else trendTxt = "Température plutôt stable ces prochaines heures.";
  }

  const loc = b.group ? `${b.group}, ${b.lakeName}` : b.lakeName;
  // « aux Bains des Pâquis » : calculé dans le pipeline (champ nameAt de
  // data.json) pour que client et Worker disent la même chose. Repli si le
  // data.json servi date d'avant l'ajout du champ.
  const at = b.nameAt || `à ${b.name}`;
  const facts = [rankTxt, avgTxt].filter(Boolean).join(", ");
  const lead = `L'eau est à <strong>${fmt(w)}\u00A0°C</strong> ${at} (${loc})`;
  const body = `${facts ? `${lead} — ${facts}.` : `${lead}.`}${trendTxt ? " " + trendTxt : ""}`;
  const recal = b.lake === "geneva" ? " recalée en temps réel sur les bouées du Léman" : "";

  box.innerHTML =
    `<h2 class="d-about-title">Température de l'eau ${at} aujourd'hui</h2>` +
    `<p class="d-about-body">${body}</p>` +
    `<p class="d-about-method">Estimation du modèle Alplakes${recal}. ` +
    `<button type="button" class="d-about-more">En savoir plus</button></p>`;
  // stopPropagation : le clic ne doit pas remonter jusqu'au fond du détail.
  box.querySelector(".d-about-more").addEventListener("click", (e) => {
    e.stopPropagation();
    closeDetail();
    openInfo();
  });
  box.hidden = false;
}

function openDetail(b, push = true) {
  const water = fmt(b.water);

  $("#d-lake").textContent = b.lakeName + (b.group ? " · " + b.group : "");
  $("#d-name").textContent = b.name;

  const wv = $("#d-water-val");
  wv.textContent = water != null ? water : "n/d";
  wv.classList.toggle("na", water == null);

  const v = verdict(b.water);
  $("#d-verdict").innerHTML = v ? `<span>${v}</span>` : "";
  renderForecast(b);

  $("#d-air").textContent = b.air != null ? `${Math.round(b.air)}°` : "n/d";
  $("#d-wind").textContent = b.wind != null ? `${Math.round(b.wind)}\u00A0km/h` : "n/d";
  const ang = windAngle(b.windDir);
  $("#d-wind-arrow").style.transform = ang != null ? `rotate(${ang}deg)` : "";
  $("#d-wind-arrow").style.opacity = ang != null ? "1" : "0";

  const sky = weather(b.weatherCode, b.isDay);
  $("#d-sky").textContent = sky ? sky.label : "n/d";
  $("#d-sky-use").setAttribute("href", "#" + (sky ? sky.id : "i-wx-cloud"));
  $("#d-sky-ico").style.opacity = sky ? "1" : "0.4";

  $("#d-map").href = mapUrl(b);

  const favBtn = $("#d-fav");
  const setFavIcon = () => favBtn.classList.toggle("on", isFav(b.id));
  setFavIcon();
  favBtn.onclick = () => {
    toggleFav(b.id);
    setFavIcon();
  };

  $("#d-share").onclick = () => shareBeach(b);
  renderAbout(b);

  // URL partageable (deep link) + titre d'onglet adapté.
  if (push) history.pushState({ d: b.id }, "", beachPath(b));
  document.title = `${b.name}${water != null ? ` — ${water}°` : ""} · Trempette`;

  $("#detail").hidden = false;
  markOverlayOpened();
  syncScrollLock();
  track("open", b);

  // 1re ouverture d'un détail : l'indice « clique pour les détails » a fait son
  // office, on le retire définitivement (mémorisé d'une visite à l'autre).
  if (!detailSeen) {
    detailSeen = true;
    try { localStorage.setItem(TAP_KEY, "1"); } catch (e) {}
    const hint = $("#tap-hint");
    if (hint) hint.hidden = true;
  }
}
function closeDetail(updateUrl = true) {
  $("#detail").hidden = true;
  // Revient à l'accueil dans la barre d'adresse sans empiler d'entrée superflue.
  if (updateUrl && location.pathname.startsWith("/lac/")) history.replaceState({}, "", "/");
  document.title = DEFAULT_TITLE;
  syncScrollLock();
  scheduleHeroImpression(); // le hero redevient visible
}

// Partage natif (feuille iOS/Android) avec repli presse-papier.
async function shareBeach(b) {
  track("share", b);
  const url = location.origin + beachPath(b);
  const w = fmt(b.water);
  const title = `${b.name} — ${w != null ? w + "°" : "température de l'eau"}`;
  const text = `${b.name} : ${w != null ? w + "\u00A0°C" : "température de l'eau"} dans ${b.lakeName} 🌊`;
  try {
    if (navigator.share) return await navigator.share({ title, text, url });
    await navigator.clipboard.writeText(url);
    flashShareCopied();
  } catch (e) {
    if (e && e.name === "AbortError") return; // partage annulé par l'utilisateur
    try {
      await navigator.clipboard.writeText(url);
      flashShareCopied();
    } catch {
      /* presse-papier indisponible : on n'insiste pas */
    }
  }
}
function flashShareCopied() {
  const btn = $("#d-share");
  const label = $("#d-share-label");
  const old = label.textContent;
  label.textContent = "Lien copié !";
  btn.classList.add("copied");
  setTimeout(() => {
    label.textContent = old;
    btn.classList.remove("copied");
  }, 1800);
}

// Ouvre/ferme le détail selon l'URL (boutons Précédent/Suivant du navigateur).
window.addEventListener("popstate", () => {
  const b = beachFromPath(location.pathname);
  if (b) openDetail(b, false);
  else closeDetail(false);
});

// Au chargement : si l'URL pointe une plage, ouvre directement son détail.
function applyInitialRoute() {
  const b = beachFromPath(location.pathname);
  if (b) {
    history.replaceState({ d: b.id }, "", beachPath(b)); // normalise (slash final, casse)
    openDetail(b, false);
    return;
  }
  // /lac/<lac> (footer, sitemap…) : atterrit en « Par lac » avec ce lac déplié
  // et les autres repliés. Repli en mémoire seulement (n'écrase pas la
  // préférence de repli enregistrée par l'utilisateur).
  const target = lakeNameFromSlug(lakeSlugFromPath(location.pathname) || "");
  if (!target) return;
  state.sort = "lake";
  state.collapsed = new Set(state.beaches.map((x) => x.lakeName).filter((n) => n !== target));
  const seg = document.querySelector('.seg-btn[data-sort="lake"]');
  if (seg) setActiveSeg(seg);
  renderList();
  const header = [...document.querySelectorAll(".group-title")].find((h) => h.dataset.lake === target);
  if (header) header.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Un overlay (détail plage, infos, installation) est-il ouvert ?
function anyOverlayOpen() {
  return !$("#detail").hidden || !$("#info").hidden || !$("#install").hidden;
}

// Fermeture au clic sur le FOND d'un overlay : ignorée juste après l'ouverture.
// Sur iOS, quand un même geste ferme un overlay et en ouvre un autre (« En savoir
// plus »), le clic est redélivré à l'élément désormais sous le doigt — le fond du
// nouvel overlay — qui refermait donc tout d'un coup. Personne ne ferme
// volontairement un overlay dans les 400 ms suivant son ouverture.
let overlayOpenedAt = 0;
const markOverlayOpened = () => { overlayOpenedAt = Date.now(); };
const backdropCloseAllowed = () => Date.now() - overlayOpenedAt > 400;

// Bloque le défilement de la page tant qu'un overlay est ouvert (sinon, sur
// mobile, le scroll « passe » à la page derrière et on se sent coincé).
function syncScrollLock() {
  document.documentElement.style.overflow = anyOverlayOpen() ? "hidden" : "";
}

// ---- Événements ----
function setActiveSeg(btn) {
  document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("is-active"));
  btn.classList.add("is-active");
}

// Bascule vers l'onglet « Par lac ». Repli commun aux états vides (favoris,
// échec de géolocalisation) via le bouton « Voir par lac ».
function goToLakeView() {
  const lakeBtn = document.querySelector('.seg-btn[data-sort="lake"]');
  setActiveSeg(lakeBtn);
  state.sort = "lake";
  renderList();
}

document.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.sort === "near") return activateNear(btn);
    setActiveSeg(btn);
    state.sort = btn.dataset.sort;
    renderList();
  });
});

// ---- Onglet « Plus proche » : tri par distance (géolocalisation) ----
function activateNear(btn) {
  // Position déjà connue : bascule directe, sans redemander l'autorisation.
  if (state.userPos) {
    setActiveSeg(btn);
    state.sort = "near";
    renderList();
    return;
  }
  setActiveSeg(btn);
  state.sort = "near";
  if (!navigator.geolocation) {
    renderGeolocFail(btn, { canRetry: false });
    return;
  }
  btn.classList.add("is-locating");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.classList.remove("is-locating");
      state.userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      state.sort = "near";
      setActiveSeg(btn);
      renderList();
    },
    (err) => {
      btn.classList.remove("is-locating");
      const denied = err.code === err.PERMISSION_DENIED;
      // Un refus PERMANENT ne re-déclenche PAS la popup : rappeler
      // getCurrentPosition renverrait aussitôt la même erreur → un bouton
      // « Réessayer » y serait un leurre. On interroge l'API Permissions pour
      // ne le proposer que si un nouvel essai peut réellement aboutir (état
      // « prompt », ou simple erreur temporaire de position).
      if (denied && navigator.permissions && navigator.permissions.query) {
        navigator.permissions
          .query({ name: "geolocation" })
          .then((p) => renderGeolocFail(btn, { canRetry: p.state !== "denied", blocked: p.state === "denied" }))
          .catch(() => renderGeolocFail(btn, { canRetry: true, denied: true }));
      } else {
        renderGeolocFail(btn, { canRetry: true, denied });
      }
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
  );
}

// Écran d'échec de géolocalisation — jamais un cul-de-sac : au moins « Voir par
// lac », et « Réessayer » uniquement quand il peut aboutir (voir activateNear).
function renderGeolocFail(btn, { canRetry = true, blocked = false, denied = false } = {}) {
  const msg = blocked
    ? "Géolocalisation bloquée pour ce site. Réautorise-la dans les réglages du navigateur (icône près de la barre d'adresse), puis reviens ici — ou parcours les plages par lac."
    : denied
    ? "Géolocalisation refusée. Autorise l'accès à ta position, ou parcours les plages par lac."
    : navigator.geolocation
    ? "Position indisponible pour l'instant."
    : "La géolocalisation n'est pas disponible sur cet appareil.";
  listEl.innerHTML = `<div class="empty geoloc-fail">
    <p>${msg}</p>
    <div class="geoloc-actions">
      ${canRetry ? `<button type="button" class="geoloc-retry">Réessayer</button>` : ""}
      <button type="button" class="geoloc-back">Voir par lac</button>
    </div>
  </div>`;
  const retry = listEl.querySelector(".geoloc-retry");
  if (retry) retry.addEventListener("click", () => activateNear(btn));
  // Repli sans friction vers le mode « Par lac » (jamais un écran vide).
  listEl.querySelector(".geoloc-back").addEventListener("click", goToLakeView);
}

// Rafraîchissement des données. Le bouton d'en-tête a été retiré ; ne subsistent
// que les déclencheurs automatiques (retour d'onglet, bfcache) et le pull-to-refresh.
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  // durée mini pour que le retour visuel du pull-to-refresh reste perceptible
  await Promise.all([load(), new Promise((r) => setTimeout(r, 600))]);
  refreshing = false;
}

// ---- Pull-to-refresh (tactile) ----
(() => {
  const ptr = $("#ptr");
  const icon = ptr.querySelector(".ptr-icon");
  const THRESHOLD = 70; // distance de déclenchement
  const MAX = 110; // amplitude max de tirage
  let startY = null, startX = 0, pull = 0, engaged = false;

  const atTop = () => window.scrollY <= 0;
  const setPtr = (p) => {
    ptr.style.transform = `translateY(${p - 52}px)`;
    ptr.style.opacity = Math.min(1, p / THRESHOLD).toFixed(2);
    icon.style.transform = `rotate(${(p / MAX) * 270}deg)`;
  };
  const reset = () => {
    ptr.classList.remove("refreshing");
    ptr.style.transition = "transform .2s ease, opacity .2s ease";
    ptr.style.transform = "translateY(-52px)";
    ptr.style.opacity = "0";
    icon.style.transform = "";
    setTimeout(() => { ptr.style.transition = ""; }, 220);
  };

  window.addEventListener("touchstart", (e) => {
    // Overlay ouvert : le pull-to-refresh ne doit PAS s'engager, sinon un swipe
    // vers le bas dans la carte détail annule son scroll et refresh la page.
    if (refreshing || anyOverlayOpen() || e.touches.length !== 1 || !atTop()) { startY = null; return; }
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    engaged = false;
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (startY == null || refreshing || anyOverlayOpen()) return;
    const dy = e.touches[0].clientY - startY;
    const dx = e.touches[0].clientX - startX;
    // N'engage que sur un tirage vers le bas franc et vertical (laisse passer le
    // défilement horizontal du carrousel et le scroll normal).
    if (!engaged) {
      if (dy > 8 && dy > Math.abs(dx) && atTop()) engaged = true;
      else if (dy <= 0 || Math.abs(dx) > dy) { startY = null; return; }
      else return;
    }
    if (!atTop()) { startY = null; reset(); return; }
    e.preventDefault(); // empêche le rebond natif pendant le tirage
    pull = Math.min(MAX, dy * 0.5);
    setPtr(pull);
  }, { passive: false });

  const finish = () => {
    if (startY == null || refreshing) { startY = null; return; }
    startY = null;
    if (engaged && pull >= THRESHOLD) {
      ptr.style.transition = "transform .2s ease";
      ptr.style.transform = "translateY(0)";
      ptr.style.opacity = "1";
      ptr.classList.add("refreshing");
      refresh().then(reset);
    } else if (engaged) {
      reset();
    }
    pull = 0;
    engaged = false;
  };
  window.addEventListener("touchend", finish, { passive: true });
  window.addEventListener("touchcancel", finish, { passive: true });
})();

$("#d-close").addEventListener("click", closeDetail);
$("#detail").addEventListener("click", (e) => {
  if (e.target.id === "detail" && backdropCloseAllowed()) closeDetail();
});

// ---- Infos & contact (overlay) ----
const closeInfo = () => {
  $("#info").hidden = true;
  syncScrollLock();
};
let turnstileLoaded = false;
function openInfo() {
  $("#info").hidden = false;
  markOverlayOpened();
  syncScrollLock();
  $("#info .detail-card").scrollTop = 0; // ouvre toujours en haut (bouton fermer visible)
  // Charge le script Turnstile à la 1re ouverture seulement (perf + rendu pendant
  // que l'overlay est visible). Le script auto-rend le `.cf-turnstile` du formulaire.
  if (!turnstileLoaded) {
    turnstileLoaded = true;
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }
}
$("#info-open").addEventListener("click", openInfo);
$("#info-close").addEventListener("click", closeInfo);
$("#info").addEventListener("click", (e) => {
  if (e.target.id === "info" && backdropCloseAllowed()) closeInfo();
});

// ---- Ajout à l'écran d'accueil (overlay #install) ----
// Aucune API unique entre plateformes : Android/Chromium expose une pop-up
// native (beforeinstallprompt), iOS impose une manip manuelle via Partager.
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e; // conservé pour déclencher la pop-up au clic
});
window.addEventListener("appinstalled", () => { deferredInstall = null; });

const isStandalone = () =>
  (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;

function platformInstall() {
  const ua = navigator.userAgent;
  const iOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isStandalone()) return "installed";
  if (deferredInstall) return "prompt"; // Android/Chromium : pop-up native dispo
  if (iOS) return /CriOS/.test(ua) ? "ios-chrome" : /FxiOS|EdgiOS/.test(ua) ? "ios-other" : "ios-safari";
  return "generic";
}

function installContent(kind) {
  const share = svgUse("i-share-ios", 17, "vertical-align:-3px");
  if (kind === "installed") return `<p>✅ Trempette est déjà sur ton écran d'accueil.</p>`;
  if (kind === "prompt")
    return `<p class="install-intro">Accès en un tap, plein écran, comme une app.</p>
      <button id="install-go" class="install-btn" type="button">Installer l'application</button>`;
  const steps = {
    "ios-safari": [
      `Touche l'icône <strong>Partager</strong> ${share} en bas de Safari`,
      `Fais défiler et choisis <strong>« Sur l'écran d'accueil »</strong>`,
      `Confirme avec <strong>Ajouter</strong>`,
    ],
    "ios-chrome": [
      `Touche l'icône <strong>Partager</strong> ${share}`,
      `Touche <strong>« En voir plus »</strong>`,
      `Choisis <strong>« Sur l'écran d'accueil »</strong>`,
    ],
    "ios-other": [
      `Ouvre le menu <strong>Partager</strong> ${share} de ton navigateur`,
      `Via <strong>« En voir plus »</strong> si besoin, choisis <strong>« Sur l'écran d'accueil »</strong>`,
    ],
    generic: [
      `Ouvre le <strong>menu</strong> de ton navigateur (⋮)`,
      `Choisis <strong>« Installer l'application »</strong> ou <strong>« Ajouter à l'écran d'accueil »</strong>`,
    ],
  }[kind] || [];
  return `<p class="install-intro">Accès en un tap, plein écran, comme une app.</p>
    <ol class="install-steps">${steps.map((s) => `<li>${s}</li>`).join("")}</ol>`;
}

function openInstall() {
  $("#install-body").innerHTML = installContent(platformInstall());
  $("#install").hidden = false;
  markOverlayOpened();
  syncScrollLock();
  const go = $("#install-go");
  if (go)
    go.addEventListener("click", async () => {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      await deferredInstall.userChoice.catch(() => {});
      deferredInstall = null;
      closeInstall();
    });
}
const closeInstall = () => {
  $("#install").hidden = true;
  syncScrollLock();
};
$("#install-close").addEventListener("click", closeInstall);
$("#install").addEventListener("click", (e) => {
  if (e.target.id === "install" && backdropCloseAllowed()) closeInstall();
});
$("#contact-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#contact-email").value.trim();
  const message = $("#contact-msg").value.trim();
  const website = $("#contact-hp").value; // honeypot (doit rester vide)
  const turnstile = (document.querySelector('[name="cf-turnstile-response"]') || {}).value || "";
  const status = $("#contact-status");
  // `field` : on ramène l'utilisateur au champ en cause, ce qui le fait aussi
  // défiler jusqu'au message d'erreur.
  const fail = (msg, field) => {
    status.className = "contact-status err";
    status.textContent = msg;
    if (field) field.focus();
  };
  // Validation côté client (message immédiat, pas d'aller-retour serveur).
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Indique une adresse email valide.", $("#contact-email"));
  if (!message) return fail("Écris un message.", $("#contact-msg"));

  const btn = $("#contact-send");
  btn.disabled = true;
  status.className = "contact-status";
  status.textContent = "Envoi…";
  try {
    const r = await fetch("/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, message, website, turnstile }),
    });
    if (!r.ok) {
      const err = await r.json().then((d) => d.error).catch(() => "");
      // Erreurs « métier » → message clair ; le reste = vrai souci technique.
      return fail(
        {
          "email invalide": "Indique une adresse email valide.",
          "message invalide": "Ton message est vide ou trop long.",
          "anti-robot échoué": "Confirme que tu n'es pas un robot, puis réessaie.",
        }[err] || "Échec de l'envoi, réessaie plus tard."
      );
    }
    status.className = "contact-status ok";
    status.textContent = "Merci, message envoyé !";
    $("#contact-form").reset();
    window.turnstile && window.turnstile.reset();
  } catch {
    fail("Échec de l'envoi, réessaie plus tard.");
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeDetail();
    closeInfo();
    closeInstall();
  }
});

// ---- Service worker (offline) + hard-refresh automatique ----
// Quand une nouvelle version est déployée (VERSION de sw.js modifiée), le SW se
// met à jour, prend le contrôle (skipWaiting + clients.claim côté sw.js) et on
// recharge la page une fois → équivalent d'un hard-refresh, utile sur iOS où le
// shell est tenace en cache. `updateViaCache:none` force la re-récupération du
// script sw.js (jamais servi depuis le cache HTTP).
if ("serviceWorker" in navigator) {
  let reloading = false;
  // Ne recharge que si la page était déjà contrôlée (évite un reload au tout
  // premier chargement, où le SW prend le contrôle pour la 1re fois).
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  }
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
      // Cherche une mise à jour à chaque retour au premier plan (les PWA iOS
      // restent « ouvertes » longtemps).
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update();
      });
    } catch {
      /* hors-ligne ou non supporté : on ignore */
    }
  });
}

load();
