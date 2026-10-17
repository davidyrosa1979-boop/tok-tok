/**
 * Tok Tok - Service Worker PWA (v6)
 * Actualización: Verificación obligatoria de correo con código PIN y buzón simulado + Nuevo diseño móvil limpio y ordenado.
 */

const CACHE_NAME = "toktok-pwa-v42";
const ASSETS_TO_CACHE = [
  "./",
  "./index.html?v=42",
  "./styles.css?v=42",
  "./app.js?v=42",
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
  // Network first para documentos, scripts y estilos para que los móviles reciban siempre la versión actualizada al instante
  if (e.request.mode === 'navigate' || e.request.destination === 'document' || e.request.destination === 'script' || e.request.destination === 'style') {
    e.respondWith(
      fetch(e.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone)).catch(() => {});
        }
        return response;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
