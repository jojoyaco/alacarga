/* Solo se cachea una lista cerrada de shell estático. Nunca /api ni estados. */
// Incrementar esta versión al publicar cambios del shell. La instalación
// completa una copia coherente antes de sustituir la caché de la versión previa.
const CACHE = 'alacarga-shell-v44';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/proximity.js', '/location-map.js', '/charging-estimate.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];
const ALLOWED = new Set(SHELL);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
  // Activar el shell completo no recarga páginas ni modifica formularios abiertos.
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('alacarga-shell-') && name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.search || !ALLOWED.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') await cache.put(url.pathname, response.clone());
      return response;
    } catch {
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      return new Response('No hay conexión. Vuelve a abrir A la caaarga!! cuando puedas conectarte.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});

function applicationURL(candidate) {
  try {
    const url = new URL(typeof candidate === 'string' ? candidate : '/#my-turn', self.location.origin);
    // Ni enlaces externos ni rutas API: un clic solo puede abrir la app.
    if (url.origin === self.location.origin && ['/', '/index.html'].includes(url.pathname) && !url.username && !url.password) return url.href;
  } catch { /* Un payload inválido abre la app, nunca un origen externo. */ }
  return new URL('/#my-turn', self.location.origin).href;
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data?.json() || {}; } catch { /* Se usa un aviso genérico y honesto. */ }
    if (!payload || typeof payload !== 'object') payload = {};
    const expiresAt = Number(payload.expiresAt);
    const expired = Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now();
    // Safari requiere un aviso visible por cada push. Un mensaje tardío no se
    // presenta como oferta vigente: invita a consultar el estado del servidor.
    const title = expired ? 'Consulta el estado actual de tu turno' : typeof payload.title === 'string' ? payload.title.slice(0, 160) : 'A la caaarga!!';
    const body = expired ? 'Este aviso llegó después de su plazo. Abre la app para comprobar tu turno; no se ha aceptado ni liberado nada.' : typeof payload.body === 'string' ? payload.body.slice(0, 600) : 'Hay una actualización. Abre A la caaarga!! para consultar el estado actual.';
    await self.registration.showNotification(title, {
      body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      tag: typeof payload.tag === 'string' ? payload.tag.slice(0, 160) : 'alacarga-update',
      data: { url: applicationURL(payload.url), expiresAt: Number.isFinite(expiresAt) ? expiresAt : null },
      // Deliberadamente no hay acciones Aceptar/Liberar ni mutaciones en el SW.
    });
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: 'ALACARGA_REFRESH', focusTurn: false });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = applicationURL(event.notification.data?.url);
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      const current = new URL(client.url);
      if (current.origin === self.location.origin && ['/', '/index.html'].includes(current.pathname)) {
        // Focalizar sin navegar conserva el formulario que esté editando.
        client.postMessage({ type: 'ALACARGA_REFRESH', focusTurn: true });
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
