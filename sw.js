// Service worker minimal.
// - Coquille de l'app (HTML/CSS/JS/icônes) : cache-first (chargement instantané, hors-ligne).
// - data.json : network-first (toujours la donnée la plus fraîche), repli cache si hors-ligne.

// À incrémenter à chaque release pour que le cache-first récupère le nouveau
// shell (sinon les visiteurs récurrents gardent l'ancien JS/CSS). Aligné sur
// le numéro de version affiché en bas de page.
const VERSION = "v1.21";
const SHELL = `trempette-shell-${VERSION}`;
const DATA = `trempette-data-${VERSION}`;

const SHELL_ASSETS = [
  ".",
  "index.html",
  "css/style.css",
  "js/app.js",
  "manifest.webmanifest",
  "img/logo.png",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.endsWith("/data.json")) {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copy = r.clone();
          caches.open(DATA).then((c) => c.put("data.json", copy));
          return r;
        })
        .catch(() => caches.open(DATA).then((c) => c.match("data.json")))
    );
    return;
  }

  e.respondWith(caches.match(e.request).then((cached) => cached || fetch(e.request)));
});
