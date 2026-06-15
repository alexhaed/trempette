// App web statique : lit data.json (généré par la GitHub Action) et l'affiche.
// Écran d'accueil « Immersif aquatique ». Aucun appel API direct ici — tout est
// pré-calculé côté Action.

const FAV_KEY = "templac_favoris"; // ordre des favoris (tableau d'ids), conservé d'avant le renommage
const COLLAPSE_KEY = "trempette_lacs_replies"; // lacs repliés en mode « Par lac »

const state = {
  beaches: [],
  updatedAt: null,
  sort: "warm", // défaut : Plus chaude
  query: "",
  favOrder: loadFavOrder(), // tableau ordonné d'ids favoris
  collapsed: loadCollapsed(), // Set de noms de lacs repliés
  heroIdx: 0,
};

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
function toggleLake(lake) {
  if (state.collapsed.has(lake)) state.collapsed.delete(lake);
  else state.collapsed.add(lake);
  saveCollapsed();
}

// ---- Chargement des données ----
async function load() {
  try {
    const r = await fetch(`data.json?t=${Math.floor(Date.now() / 60000)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    state.beaches = data.beaches || [];
    state.updatedAt = data.updatedAt;
    // Purge les favoris dont la plage n'existe plus.
    const ids = new Set(state.beaches.map((b) => b.id));
    state.favOrder = state.favOrder.filter((id) => ids.has(id));
    renderAll();
  } catch (e) {
    listEl.innerHTML = `<p class="empty">Impossible de charger les données.<br>${e.message}</p>`;
  }
}

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
  if (slope > 0.05) return { cls: "trend-up", txt: `Se réchauffe (+${slope.toFixed(2)} °C/h)` };
  if (slope < -0.05) return { cls: "trend-down", txt: `Se refroidit (${slope.toFixed(2)} °C/h)` };
  return { cls: "trend-flat", txt: "Stable" };
}
// La flèche pointe vers où VA le vent : direction d'origine + 180°.
function windAngle(deg) {
  return deg == null ? null : (deg + 180) % 360;
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
  return `https://map.geo.admin.ch/#/map?center=${E},${N}&z=10&crosshair=marker`;
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

  if (favs.length === 0) {
    track.innerHTML = `<div class="hero-empty">${svgUse("i-star", 26)}
      <p>Ajouter une plage en favori pour la voir ici</p></div>`;
    dots.innerHTML = "";
    $("#map-link").style.display = "none";
    return;
  }

  $("#map-link").style.display = "";
  if (state.heroIdx >= favs.length) state.heroIdx = 0;

  track.innerHTML = favs.map((b) => heroCard(b)).join("");
  dots.innerHTML = favs.map((_, i) => `<i class="${i === state.heroIdx ? "on" : ""}"></i>`).join("");
  updateMapLink(favs[state.heroIdx]);

  // Clic sur une carte → détail.
  track.querySelectorAll(".hero-card").forEach((el, i) => {
    el.addEventListener("click", () => openDetail(favs[i]));
  });
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
            <span class="tile-val">${b.wind != null ? `${Math.round(b.wind)} km/h` : "n/d"}</span>
          </div>
        </div>
      </div>
    </div>`;
}

function updateMapLink(b) {
  if (b) $("#map-link").href = mapUrl(b);
}

// Synchronise les points de pagination et le lien carte au défilement.
$("#hero-track").addEventListener(
  "scroll",
  () => {
    const track = $("#hero-track");
    const idx = Math.round(track.scrollLeft / track.clientWidth);
    if (idx !== state.heroIdx) {
      state.heroIdx = idx;
      const favs = state.favOrder.map(byId).filter(Boolean);
      $("#hero-dots").querySelectorAll("i").forEach((d, i) => d.classList.toggle("on", i === idx));
      updateMapLink(favs[idx]);
    }
  },
  { passive: true }
);

// ---- Liste des plages ----
function visibleBeaches() {
  const q = norm(state.query);
  if (q) {
    // Recherche transverse : nom (complet + mots) et commune/région, préfixe,
    // insensible aux accents ; triée du plus chaud au plus froid, sans en-têtes.
    const matches = state.beaches.filter((b) => {
      const words = [b.name].concat(b.name.split(/[\s’'–-]+/));
      return words.some((w) => norm(w).startsWith(q)) || norm(b.group).startsWith(q);
    });
    return { groups: [{ header: null, items: sortWarm(matches) }] };
  }

  if (state.sort === "fav") {
    const items = state.favOrder.map(byId).filter(Boolean);
    return { groups: [{ header: null, items }] };
  }

  if (state.sort === "warm") {
    return { groups: [{ header: null, items: sortWarm(state.beaches) }] };
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
  }
  return { groups: lakes.map((lake) => ({ header: lake, items: byLake.get(lake) })) };
}
const sortWarm = (arr) => [...arr].sort((a, b) => (b.water ?? -99) - (a.water ?? -99));

function renderList() {
  const isFavMode = state.sort === "fav" && !state.query.trim();
  $("#reorder-hint").hidden = !isFavMode || state.favOrder.length < 2;

  const { groups } = visibleBeaches();
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  listEl.innerHTML = "";
  if (total === 0) {
    listEl.innerHTML = `<p class="empty">${
      state.query.trim()
        ? "Aucune plage ne correspond."
        : state.sort === "fav"
          ? "Aucun favori — touchez l'étoile d'une plage."
          : "Aucune plage trouvée."
    }</p>`;
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
  const sub = state.sort === "lake" && !state.query.trim() ? b.group || b.lakeName : b.lakeName;
  const fav = isFav(b.id);

  row.innerHTML = `
    ${isFavMode ? `<button class="drag-handle" aria-label="Réordonner">${svgUse("i-grip", 18)}</button>` : ""}
    <div class="beach-main">
      <div class="beach-name">${b.name}</div>
      <div class="beach-sub">${sub}</div>
    </div>
    <div class="beach-temp${water == null ? " na" : ""}">${water != null ? `${water}°` : "n/d"}</div>
    <button class="beach-star ${fav ? "on" : ""}" aria-label="${fav ? "Retirer des favoris" : "Ajouter aux favoris"}" aria-pressed="${fav}">${svgUse("i-star", 22)}</button>`;

  row.querySelector(".beach-star").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFav(b.id);
  });
  row.addEventListener("click", () => openDetail(b));
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

// ---- Favoris ----
function toggleFav(id) {
  const i = state.favOrder.indexOf(id);
  if (i >= 0) state.favOrder.splice(i, 1);
  else state.favOrder.push(id);
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
function openDetail(b) {
  const t = trendInfo(b.trend);
  const water = fmt(b.water);

  $("#d-lake").textContent = b.lakeName + (b.group ? " · " + b.group : "");
  $("#d-name").textContent = b.name;

  const wv = $("#d-water-val");
  wv.textContent = water != null ? water : "n/d";
  wv.classList.toggle("na", water == null);

  const v = verdict(b.water);
  $("#d-verdict").innerHTML = v ? `<span>${v}</span>` : "";
  $("#d-trend-txt").textContent = t.txt;

  $("#d-air").textContent = b.air != null ? `${Math.round(b.air)}°` : "n/d";
  $("#d-wind").textContent = b.wind != null ? `${Math.round(b.wind)} km/h` : "n/d";
  const ang = windAngle(b.windDir);
  $("#d-wind-arrow").style.transform = ang != null ? `rotate(${ang}deg)` : "";
  $("#d-wind-arrow").style.opacity = ang != null ? "1" : "0";

  $("#d-map").href = mapUrl(b);

  const favBtn = $("#d-fav");
  const setFavIcon = () => favBtn.classList.toggle("on", isFav(b.id));
  setFavIcon();
  favBtn.onclick = () => {
    toggleFav(b.id);
    setFavIcon();
  };

  $("#detail").hidden = false;
}
function closeDetail() {
  $("#detail").hidden = true;
}

// ---- Événements ----
document.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    state.sort = btn.dataset.sort;
    renderList();
  });
});

const searchInput = $("#search");
searchInput.addEventListener("input", (e) => {
  state.query = e.target.value;
  $("#search-clear").hidden = !state.query;
  renderList();
});
$("#search-clear").addEventListener("click", () => {
  searchInput.value = "";
  state.query = "";
  $("#search-clear").hidden = true;
  renderList();
  searchInput.focus();
});

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const btn = $("#refresh");
  btn.classList.add("is-spinning");
  // durée mini pour que le retour visuel soit perceptible même si le fetch est instantané
  await Promise.all([load(), new Promise((r) => setTimeout(r, 600))]);
  btn.classList.remove("is-spinning");
  refreshing = false;
}
$("#refresh").addEventListener("click", refresh);

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
    if (refreshing || e.touches.length !== 1 || !atTop()) { startY = null; return; }
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    engaged = false;
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (startY == null || refreshing) return;
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
  if (e.target.id === "detail") closeDetail();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDetail();
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
      const reg = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
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

// Au démarrage, ouvrir l'onglet Favoris si l'utilisateur en a déjà.
if (state.favOrder.length > 0) {
  state.sort = "fav";
  document.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.sort === "fav")
  );
}

load();
