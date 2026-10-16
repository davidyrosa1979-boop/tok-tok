/**
 * Tok Tok - Service Worker PWA (v6)
 * Actualización: Verificación obligatoria de correo con código PIN y buzón simulado + Nuevo diseño móvil limpio y ordenado.
 */

const CACHE_NAME = "toktok-pwa-v25";
const ASSETS_TO_CACHE = [
  "./",
  "./index.html?v=25",
  "./styles.css?v=25",
  "./app.js?v=25",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch(() => {});
    })
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  // Network first for html to always get the latest layout and verification workflow
  if (e.request.mode === 'navigate' || e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match("./index.html"))
    );
    return;
  }

  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
