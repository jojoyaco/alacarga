import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { open, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { AppError, fail, object } from './errors.mjs';
import { Auth, safeEqual } from './auth.mjs';
import { openDatabase } from './db.mjs';
import { loadConfig, normalizeIp } from './config.mjs';
import { Service } from './service.mjs';
import { loadVapidKeys, createPushSender, PushWorker } from './push.mjs';
import { TokenVault } from './token-vault.mjs';
import { EvsareClient, EvsareAccess } from './evsare.mjs';
import { ChargerCatalog, loadCatalogCredentials } from './charger-catalog.mjs';
import { createMetrics, createMetricsServer } from './metrics.mjs';

const STATIC = new Set(['/', '/index.html', '/app.js', '/app.css', '/styles.css', '/style.css', '/main.css', '/sw.js', '/service-worker.js', '/manifest.webmanifest', '/manifest.json', '/icon.svg', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/favicon.ico', '/offline.html']);
STATIC.add('/proximity.js');
STATIC.add('/location-map.js');
STATIC.add('/charging-estimate.js');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.json': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export function clientIp(request, trustedProxies = new Set()) {
  const peer = normalizeIp(request.socket.remoteAddress) || 'unknown';
  if (!trustedProxies.has(peer)) return peer;
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string' || forwarded.length > 1024) return peer;
  const chain = forwarded.split(',').map(part => normalizeIp(part.trim()));
  if (!chain.length || chain.some(ip => !isIP(ip))) return peer;
  // Avanzar desde el proxy conocido hacia el cliente, nunca confiar en el extremo izquierdo arbitrario.
  let address = peer;
  for (let i = chain.length - 1; i >= 0 && trustedProxies.has(address); i--) address = chain[i];
  return address;
}

function headers(response, config) {
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://tile.openstreetmap.org; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  if (config.secureCookies) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function json(response, value, status = 200) {
  if (response.destroyed || response.writableEnded) return;
  const data = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(data));
  response.end(data);
}

function readJson(request, limit) {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(contentType)) fail(415, 'JSON_REQUIRED', 'Usa Content-Type: application/json.');
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') fail(415, 'ENCODING_UNSUPPORTED', 'No se admiten cuerpos comprimidos.');
  const contentLength = request.headers['content-length'];
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) fail(413, 'BODY_TOO_LARGE', 'Solicitud demasiado grande.');
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, settled = false;
    const error = (reason) => { if (!settled) { settled = true; reject(reason); } };
    request.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) { chunks.length = 0; error(new AppError(413, 'BODY_TOO_LARGE', 'Solicitud demasiado grande.')); }
      else chunks.push(chunk);
    });
    request.on('aborted', () => error(new AppError(400, 'INCOMPLETE_BODY', 'Solicitud incompleta.')));
    request.on('error', () => error(new AppError(400, 'INVALID_BODY', 'Solicitud no válida.')));
    request.on('end', () => {
      if (settled) return;
      try {
        const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
        settled = true; resolve(value);
      } catch { error(new AppError(400, 'INVALID_JSON', 'Se requiere un objeto JSON válido.')); }
    });
  });
}

async function staticFile(request, response, pathname, publicDir) {
  if (!STATIC.has(pathname)) fail(404, 'NOT_FOUND', 'No encontrado.');
  if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  let file;
  try {
    const root = await realpath(publicDir);
    const target = await realpath(resolve(root, relative));
    if (!target.startsWith(root + sep)) fail(404, 'NOT_FOUND', 'No encontrado.');
    file = await open(target, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) fail(404, 'NOT_FOUND', 'No encontrado.');
    response.setHeader('Content-Type', MIME[extname(relative)]);
    response.setHeader('Content-Length', stat.size);
    response.setHeader('Cache-Control', relative === 'sw.js' || relative === 'service-worker.js' ? 'no-store' : 'no-cache');
    if (relative === 'sw.js' || relative === 'service-worker.js') response.setHeader('Service-Worker-Allowed', '/');
    response.end(request.method === 'HEAD' ? undefined : await file.readFile());
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) fail(404, 'NOT_FOUND', 'No encontrado.');
    throw error;
  } finally { await file?.close(); }
}

export function createApplication(options = {}) {
  const config = options.config ?? loadConfig();
  const clock = options.clock ?? Date.now;
  const log = options.log ?? (code => console.error(code));
  const credentials = loadCatalogCredentials(config.catalogCredentialsPath);
  const catalog = options.catalog ?? (credentials ? new ChargerCatalog(credentials, { clock }) : null);
  const db = openDatabase(config.dataDir);
  let keys, vault, metrics;
  try {
    keys = loadVapidKeys(config.dataDir);
    vault = new TokenVault(db, config.dataDir, clock);
    if (config.metricsPort) metrics = createMetrics(db, catalog);
  } catch (error) { vault?.destroy(); db.close(); throw error; }
  const service = new Service(db, config, clock);
  service.catalog = catalog;
  const auth = new Auth(db, config, clock);
  const evsareClient = new EvsareClient({ fetchImpl: options.evsareFetch });
  const evsare = new EvsareAccess(evsareClient, vault);
  const send = Object.hasOwn(options, 'sendPush') ? options.sendPush : createPushSender(config, keys);
  const pushWorker = new PushWorker(service, send);
  let timer = null, closed = false;
  const refreshCatalog = () => catalog?.refresh().catch(() => {});

  const handler = async (request, response) => {
    const started = metrics ? performance.now() : 0;
    headers(response, config);
    try {
      if (closed) fail(503, 'SHUTTING_DOWN', 'Servicio reiniciándose.');
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) fail(400, 'INVALID_URL', 'URL no válida.');
      const url = new URL(request.url, config.origin);
      if (url.origin !== config.origin) fail(400, 'INVALID_URL', 'URL no válida.');
      const pathname = url.pathname;
      if (metrics) response.once('finish', () => metrics.record(request.method, pathname, response.statusCode, (performance.now() - started) / 1000));
      const ip = clientIp(request, config.trustedProxies);
      service.rateLimit('http', ip, 300, 60000);
      if (!pathname.startsWith('/api/')) return await staticFile(request, response, pathname, config.publicDir);
      response.setHeader('Vary', 'Cookie, Origin');
      if (!['GET', 'POST'].includes(request.method)) fail(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
      let session = auth.lookup(request.headers.cookie);
      const requireUser = () => {
        if (!session) fail(401, 'AUTH_REQUIRED', 'Inicia sesión para continuar.');
        return session.user.id;
      };
      let body;
      if (request.method === 'POST') {
        if (request.headers.origin !== config.origin || request.headers['sec-fetch-site'] === 'cross-site') fail(403, 'ORIGIN_REJECTED', 'Origen de solicitud no autorizado.');
        if (session && !safeEqual(request.headers['x-csrf-token'], session.csrfToken)) fail(403, 'CSRF_REJECTED', 'Token de seguridad no válido. Actualiza tu sesión.');
        if (!['/api/login', '/api/register', '/api/admin/login'].includes(pathname)) requireUser();
        service.rateLimit('write', session ? String(session.user.id) : ip, 60, 60000);
        body = await readJson(request, config.bodyLimit);
        // El cuerpo puede tardar en llegar: releer sesión/rol antes de efectuar la mutación.
        session = auth.lookup(request.headers.cookie);
        if (session && !safeEqual(request.headers['x-csrf-token'], session.csrfToken)) fail(403, 'CSRF_REJECTED', 'Token de seguridad no válido. Actualiza tu sesión.');
        if (!['/api/login', '/api/register', '/api/admin/login'].includes(pathname)) requireUser();
      }
      service.tick();
      let result;
      if (request.method === 'GET') {
        switch (pathname) {
          case '/api/health': result = { ok: true }; break;
          case '/api/session': result = auth.sessionView(session); break;
          case '/api/config': result = { source: 'manual', integrationStatus: 'partial', authProvider: 'evsare', mapStatus: catalog ? 'private' : 'unavailable', rfidMode: 'read-only', offerSeconds: config.offerSeconds,
            arrivalSeconds: config.arrivalSeconds, staleSeconds: config.staleSeconds, remoteCharge: service.remoteChargeEnabled(), vapidPublicKey: config.vapidSubject ? keys.publicKey : null }; break;
          case '/api/zones': result = service.zones(); break;
          case '/api/me': result = service.me(requireUser()); break;
          case '/api/evsare/profile': requireUser(); service.rateLimit('evsare-read', String(session.user.id), 30, 60000); result = await evsare.profile(session, { fresh: url.searchParams.get('fresh') === '1' }); break;
           case '/api/evsare/start-charge/status': requireUser(); result = service.remoteChargeStatus(session); break;
           case '/api/evsare/start-charge/check': {
             const userId = requireUser();
             if (url.search) fail(400, 'INVALID_QUERY', 'Esta consulta no admite parámetros.');
             service.rateLimit('evsare-charge-check', String(userId), 10, 60000);
             result = await service.remoteChargeCheck(session, evsare);
             break;
           }
          case '/api/evsare/recharges': requireUser(); service.rateLimit('evsare-read', String(session.user.id), 30, 60000); result = await evsare.recharges(session, { fresh: url.searchParams.get('fresh') === '1' }); break;
          case '/api/evsare/rfid-cards': {
            const userId = requireUser();
            if (session.user.provider !== 'evsare') fail(403, 'EVSARE_FORBIDDEN', 'Entra con tu cuenta EVsare para consultar tus tarjetas.');
            service.rateLimit('evsare-read', String(userId), 30, 60000);
            result = await evsare.rfidCards(session, service.subject(userId), { fresh: url.searchParams.get('fresh') === '1' });
            break;
          }
          case '/api/evsare/chargers': {
            const userId = requireUser();
            if (!catalog || session.user.provider !== 'evsare') fail(404, 'CHARGER_CATALOG_DISABLED', 'Catálogo privado no disponible.');
            service.rateLimit('charger-catalog', String(userId), 15, 60000);
            void refreshCatalog();
            if (catalog.readable && !catalog.readable()) {
              if (catalog.failed && !catalog.pending) fail(503, 'CHARGER_CATALOG_UNAVAILABLE', 'No se pudo sincronizar EVsare. Se reintentará automáticamente.');
              response.setHeader('Retry-After', '5');
              json(response, { status: 'syncing' }, 202);
              return;
            }
            result = service.privateChargers(userId);
            break;
          }
          default: {
            const curve = /^\/api\/evsare\/recharges\/([1-9]\d{0,9})\/curve$/.exec(pathname);
            if (!curve) fail(404, 'NOT_FOUND', 'No encontrado.');
            const userId = requireUser();
            if (session.user.provider !== 'evsare') fail(403, 'EVSARE_FORBIDDEN', 'Entra con tu cuenta EVsare para consultar esta curva.');
            service.rateLimit('evsare-curve', String(userId), 10, 60000);
            result = await evsare.rechargeCurve(session, Number(curve[1]));
          }
        }
      } else if (pathname === '/api/register') {
        fail(410, 'LOCAL_REGISTRATION_REMOVED', 'Usa tu cuenta EVsare. A la caaarga!! ya no crea cuentas de acceso independientes.');
      } else if (pathname === '/api/admin/login' || pathname === '/api/login') {
        service.rateLimit('auth-ip', ip, 12, 15 * 60000);
        if (typeof body.username === 'string') service.rateLimit('auth-user', body.username.toLowerCase(), 10, 15 * 60000);
        const signed = pathname === '/api/admin/login' ? await auth.login(body, request.headers.cookie) : await auth.loginEvsare(body, request.headers.cookie, evsareClient, vault);
        if (pathname === '/api/login') void refreshCatalog();
        service.tick();
        response.setHeader('Set-Cookie', signed.cookie);
        result = signed.view;
      } else {
        const userId = requireUser();
        const queueAction = /^\/api\/queue\/([1-9]\d*)\/(accept|leave|complete|start|estimate|release)$/.exec(pathname);
        const resourceClaim = /^\/api\/resources\/([1-9]\d*)\/claim$/.exec(pathname);
        const adminResource = /^\/api\/admin\/resources\/([1-9]\d*)\/(status|charge-finished)$/.exec(pathname);
        if (pathname.startsWith('/api/admin/') && session.user.role !== 'admin') fail(403, 'ADMIN_REQUIRED', 'Esta acción requiere administración.');
        if (pathname === '/api/logout') { evsare.invalidateSession(session); response.setHeader('Set-Cookie', auth.logout(session)); result = { ok: true }; }
        else if (pathname === '/api/queue') result = service.join(userId, body);
        else if (queueAction) result = service[queueAction[2]](userId, Number(queueAction[1]), body);
        else if (resourceClaim) result = service.claim(userId, Number(resourceClaim[1]), body);
        else if (pathname === '/api/subscriptions') result = service.subscribeZone(userId, body);
        else if (pathname === '/api/evsare/favorites' && session.user.provider === 'evsare') result = service.favoriteCharger(userId, body);
        else if (pathname === '/api/evsare/rfid-cards/reveal') {
          if (session.user.provider !== 'evsare') fail(403, 'EVSARE_FORBIDDEN', 'Entra con tu cuenta EVsare para consultar tus tarjetas.');
          service.rateLimit('rfid-reveal', String(userId), 10, 60000);
          result = await evsare.revealRfidCard(session, service.subject(userId), body.ending);
        }
        else if (pathname === '/api/evsare/start-charge') result = await service.remoteCharge(session, body, evsare);
         else if (pathname === '/api/evsare/start-charge/finish') {
          if (url.search) fail(400, 'INVALID_QUERY', 'Esta acción no admite parámetros.');
          service.rateLimit('evsare-charge-action', String(userId), 6, 60000);
           result = await service.remoteChargeFinish(session, body, evsare);
        }
        else if (pathname === '/api/push/subscribe') {
          if (!config.vapidSubject) fail(503, 'PUSH_UNAVAILABLE', 'Las notificaciones push no están configuradas.');
          result = service.subscribePush(userId, body);
        } else if (pathname === '/api/push/unsubscribe') result = service.unsubscribePush(userId, body);
        else if (pathname === '/api/push/test') { service.rateLimit('push-test', String(userId), 3, 60000); result = service.testPush(userId); }
        else if (pathname === '/api/admin/zones') result = service.createZone(body);
        else if (pathname === '/api/admin/resources') result = service.createResource(body);
        else if (adminResource) result = adminResource[2] === 'status' ? service.setStatus(Number(adminResource[1]), body) : service.chargeFinished(Number(adminResource[1]));
        else fail(404, 'NOT_FOUND', 'No encontrado.');
      }
      json(response, result);
    } catch (error) {
      const busy = error?.errcode === 5 || error?.errcode === 6;
      const status = error instanceof AppError ? error.status : busy ? 503 : 500;
      if (status >= 500 && !(error instanceof AppError)) log(busy ? 'DATABASE_BUSY' : 'HTTP_INTERNAL_ERROR');
      if (!request.complete) { response.setHeader('Connection', 'close'); request.resume(); }
      if (status === 429 || status === 503) response.setHeader('Retry-After', status === 429 ? '60' : '5');
      json(response, { error: error instanceof AppError ? error.message : busy ? 'Servicio ocupado. Intenta nuevamente.' : 'Error interno del servicio.', code: error instanceof AppError ? error.code : busy ? 'DATABASE_BUSY' : 'INTERNAL_ERROR' }, status);
    }
  };

  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000 }, (req, res) => {
    handler(req, res).catch(() => { log('HTTP_HANDLER_ERROR'); res.destroy(); });
  });
  server.maxRequestsPerSocket = 1000;
  const metricsServer = metrics ? createMetricsServer(metrics, config.metricsPeers) : null;
  const startWorkers = () => {
    if (timer || closed) return;
    const work = () => {
      try { service.tick(); } catch { log('EXPIRY_WORKER_ERROR'); }
      if (catalog && !catalog.pending && service.get(`SELECT p.zone_id FROM private_provider_zones p WHERE EXISTS
        (SELECT 1 FROM subscriptions s WHERE s.zone_id=p.zone_id) OR EXISTS
        (SELECT 1 FROM queue q WHERE q.zone_id=p.zone_id AND q.state IN ('WAITING','OFFERED','ACCEPTED','CHARGING')) LIMIT 1`)) {
        void refreshCatalog();
      }
      pushWorker.drain().catch(() => log('PUSH_WORKER_ERROR'));
    };
    work();
    void refreshCatalog();
    timer = setInterval(work, config.workerInterval);
    timer.unref();
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    const closeServer = listener => new Promise((resolve, reject) => {
      if (!listener?.listening) return resolve();
      listener.close(error => error ? reject(error) : resolve());
      listener.closeIdleConnections();
    });
    await Promise.all([closeServer(server), closeServer(metricsServer), pushWorker.stop(), catalog?.pending?.catch(() => {})]);
    vault.destroy();
    db.close();
  };
  return { server, metricsServer, service, auth, db, config, pushWorker, startWorkers, close };
}
