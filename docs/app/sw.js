// Service worker de ViYi.
//
// Objetivo: que la app SIEMPRE cargue la última versión cuando hay internet
// —se acabó el caché viejo del iPhone/Safari que mostraba lo de ayer— y que
// siga funcionando sin red usando lo último que guardó.
//
// Estrategia:
//   · La NAVEGACIÓN (index.html) va a la RED primero y con `no-store`, para
//     saltarse el caché del navegador: así el HTML fresco apunta siempre a la
//     última versión de app.js/styles.css (que van con ?v=N). Sin red, el
//     último index.html guardado.
//   · Los ASSETS versionados (?v=N) y demás GET: caché primero (son inmutables
//     por versión, así cargan al instante), y si no están, a la red y se guardan.
//   · Solo lo de NUESTRO origen. Las llamadas a Firebase/Firestore/Tuya pasan
//     de largo, intactas.
//
// No hace `skipWaiting` solo: cuando hay versión nueva, se queda "esperando" y
// la app muestra un botón "Actualizar". Al tocarlo, este SW recibe SKIP_WAITING,
// toma el control y la página se recarga una vez.

const CACHE = 'viyi-2';

self.addEventListener('install', (e) => {
  // Guarda el cascarón para que offline arranque; el resto se llena al usarse.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(['./', 'index.html', 'manifest.webmanifest']))
      .catch(() => {}),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    await self.clients.claim();
    // Borra cachés de versiones anteriores del SW.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
  })());
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return; // Firebase/Tuya: sin tocar.

  const esNavegacion = req.mode === 'navigate'
    || url.pathname.endsWith('/index.html')
    || url.pathname.endsWith('/app')
    || url.pathname.endsWith('/app/');

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (esNavegacion) {
      try {
        // `no-store`: nada de caché del navegador; index.html SIEMPRE fresco.
        const fresco = await fetch(url.pathname + url.search, { cache: 'no-store' });
        if (fresco && fresco.ok) cache.put('index.html', fresco.clone());
        return fresco;
      } catch (_) {
        return (await cache.match('index.html')) || (await cache.match('./')) || Response.error();
      }
    }
    const guardado = await cache.match(req);
    if (guardado) return guardado;
    try {
      const resp = await fetch(req);
      if (resp && resp.ok && resp.type === 'basic') cache.put(req, resp.clone());
      return resp;
    } catch (_) {
      return guardado || Response.error();
    }
  })());
});
