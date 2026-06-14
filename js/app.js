// App web statique : lit data.json (généré par la GitHub Action) et l'affiche.
// Aucun appel API direct ici — tout est pré-calculé côté Action.

const FAV_KEY = "templac_favoris";
const state = {
  beaches: [],
  updatedAt: null,
  sort: "lake",
  query: "",
  favoris: new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")),
};

const $ = (sel) => document.querySelector(sel);
const listEl = $("#list");

// ---- Chargement des données ----
async function load() {
  try {
    // cache-bust léger pour récupérer la dernière version après une Action.
    const r = await fetch(`data.json?t=${Math.floor(Date.now() / 60000)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    state.beaches = data.beaches || [];
    state.updatedAt = data.updatedAt;
    render();
  } catch (e) {
    listEl.innerHTML = `<p class="empty">Impossible de charger les données.<br>${e.message}</p>`;
  }
}

// ---- Helpers d'affichage ----
function fmt(v) {
  return v == null ? null : (Math.round(v * 10) / 10).toFixed(1);
}
function trendInfo(slope) {
  if (slope == null) return { sym: "", cls: "trend-flat", txt: "" };
  if (slope > 0.05) return { sym: "▲", cls: "trend-up", txt: `Se réchauffe (+${slope.toFixed(2)} °C/h)` };
  if (slope < -0.05) return { sym: "▼", cls: "trend-down", txt: `Se refroidit (${slope.toFixed(2)} °C/h)` };
  return { sym: "▶", cls: "trend-flat", txt: "Stable" };
}
function windArrow(deg) {
  if (deg == null) return "";
  const a = ["↓", "↙", "←", "↖", "↑", "↗", "→", "↘"];
  return a[Math.round(deg / 45) % 8];
}
function norm(s) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// WGS84 → coordonnées suisses LV95 (EPSG:2056), formule approchée officielle
// swisstopo. Vérifiée à ~5 cm près contre le service REFRAME. map.geo.admin.ch
// attend le centre en LV95 (easting, northing).
function wgs84ToLv95(lat, lng) {
  const phi = (lat * 3600 - 169028.66) / 10000;
  const lam = (lng * 3600 - 26782.5) / 10000;
  const E =
    2600072.37 +
    211455.93 * lam -
    10938.51 * lam * phi -
    0.36 * lam * phi * phi -
    44.54 * lam ** 3;
  const N =
    1200147.07 +
    308807.95 * phi +
    3745.25 * lam * lam +
    76.63 * phi * phi -
    194.56 * lam * lam * phi +
    119.79 * phi ** 3;
  return { E: Math.round(E), N: Math.round(N) };
}

// ---- Rendu de la liste ----
function render() {
  const q = norm(state.query.trim());
  let beaches = state.beaches.filter(
    (b) => !q || norm(b.name).includes(q) || norm(b.lakeName).includes(q)
  );

  if (state.sort === "fav") {
    beaches = beaches.filter((b) => state.favoris.has(b.id));
  }

  listEl.innerHTML = "";

  if (beaches.length === 0) {
    listEl.innerHTML = `<p class="empty">${
      state.sort === "fav" ? "Aucun favori — touchez l'étoile sur une plage." : "Aucune plage trouvée."
    }</p>`;
    renderUpdated();
    return;
  }

  if (state.sort === "warm") {
    const sorted = [...beaches].sort((a, b) => (b.water ?? -99) - (a.water ?? -99));
    appendBeaches(sorted);
  } else if (state.sort === "fav") {
    const sorted = [...beaches].sort((a, b) => (b.water ?? -99) - (a.water ?? -99));
    appendBeaches(sorted);
  } else {
    // Par lac, en respectant l'ordre des lacs du fichier.
    const order = [];
    const byLake = new Map();
    for (const b of beaches) {
      if (!byLake.has(b.lakeName)) {
        byLake.set(b.lakeName, []);
        order.push(b.lakeName);
      }
      byLake.get(b.lakeName).push(b);
    }
    for (const lake of order) {
      const h = document.createElement("h2");
      h.className = "group-title";
      h.textContent = lake;
      listEl.appendChild(h);
      appendBeaches(byLake.get(lake));
    }
  }

  renderUpdated();
}

function appendBeaches(beaches) {
  const frag = document.createDocumentFragment();
  for (const b of beaches) {
    frag.appendChild(beachRow(b));
  }
  listEl.appendChild(frag);
}

function beachRow(b) {
  const row = document.createElement("button");
  row.className = "beach";
  row.type = "button";

  const isFav = state.favoris.has(b.id);
  const t = trendInfo(b.trend);
  const water = fmt(b.water);
  const showLake = state.sort !== "lake";

  row.innerHTML = `
    <span class="beach-fav ${isFav ? "" : "off"}">${isFav ? "★" : "☆"}</span>
    <span class="beach-main">
      <span class="beach-name">${b.name}</span>
      <span class="beach-sub">${showLake ? b.lakeName : (b.group || b.lakeName)}</span>
    </span>
    <span class="beach-temp">
      ${water != null ? `<span class="val">${water}°</span>` : `<span class="na">n/d</span>`}
      <span class="trend ${t.cls}">${t.sym}</span>
    </span>`;

  row.querySelector(".beach-fav").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFav(b.id);
    render();
  });
  row.addEventListener("click", () => openDetail(b));
  return row;
}

function renderUpdated() {
  const el = $("#updated");
  if (!state.updatedAt) { el.textContent = ""; return; }
  const d = new Date(state.updatedAt);
  el.textContent = "Mis à jour le " + d.toLocaleString("fr-CH", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

// ---- Favoris ----
function toggleFav(id) {
  if (state.favoris.has(id)) state.favoris.delete(id);
  else state.favoris.add(id);
  localStorage.setItem(FAV_KEY, JSON.stringify([...state.favoris]));
}

// ---- Vue détail ----
function openDetail(b) {
  const t = trendInfo(b.trend);
  const water = fmt(b.water);
  $("#d-lake").textContent = b.lakeName + (b.group ? " · " + b.group : "");
  $("#d-name").textContent = b.name;

  const wv = $("#d-water-val");
  wv.textContent = water != null ? water : "n/d";
  wv.classList.toggle("na", water == null);

  const tr = $("#d-trend");
  tr.textContent = t.sym;
  tr.className = "d-trend " + t.cls;
  $("#d-trend-txt").textContent = t.txt;

  $("#d-air").textContent = b.air != null ? `${fmt(b.air)}°` : "n/d";
  const w = b.wind != null ? `${Math.round(b.wind)} km/h ${windArrow(b.windDir)}` : "n/d";
  $("#d-wind").textContent = w;

  const { E, N } = wgs84ToLv95(b.lat, b.lng);
  $("#d-map").href = `https://map.geo.admin.ch/#/map?center=${E},${N}&z=10&crosshair=marker`;

  const favBtn = $("#d-fav");
  const setFavIcon = () => {
    const on = state.favoris.has(b.id);
    favBtn.textContent = on ? "★" : "☆";
  };
  setFavIcon();
  favBtn.onclick = () => { toggleFav(b.id); setFavIcon(); render(); };

  $("#detail").hidden = false;
}
function closeDetail() { $("#detail").hidden = true; }

// ---- Événements ----
document.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    state.sort = btn.dataset.sort;
    render();
  });
});
$("#search").addEventListener("input", (e) => { state.query = e.target.value; render(); });
$("#refresh").addEventListener("click", load);
$("#d-close").addEventListener("click", closeDetail);
$("#detail").addEventListener("click", (e) => { if (e.target.id === "detail") closeDetail(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

// ---- Service worker (offline) ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

load();
