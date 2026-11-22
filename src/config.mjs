import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function integer(env, name, fallback, min, max) {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`Configuración inválida: ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Configuración inválida: ${name}`);
  return value;
}

export function normalizeIp(value) {
  return value?.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
}

function remoteChargeTargets(raw) {
  if (!raw) return new Set();
  const targets = raw.split(',').map(item => item.trim());
  if (targets.length > 1000 || targets.some(item => !/^e[1-9]\d{0,14}:t[1-9]\d{0,9}:(?:0|[1-9]\d{0,9})$/.test(item)
    || item.split(':').slice(1).some(id => Number(id.replace(/^t/, '')) > 2147483647))) {
    throw new Error('Configuración inválida: EVSARE_REMOTE_CHARGE_TARGETS (emplazamiento:terminal:conector)');
  }
  return new Set(targets);
}

export function loadConfig(env = process.env) {
  const port = integer(env, 'PORT', 3000, 1, 65535);
  const metricsPort = integer(env, 'METRICS_PORT', 0, 0, 65535);
  const metricsPeers = (env.METRICS_PEERS ?? '').split(',').map(s => normalizeIp(s.trim())).filter(Boolean);
  if (metricsPort === port || (metricsPort && !metricsPeers.length) || metricsPeers.some(ip => !isIP(ip))) {
    throw new Error('Configuración inválida: METRICS_PORT y METRICS_PEERS requieren puerto separado e IPs explícitas.');
  }
  let origin;
  try {
    const url = new URL(env.APP_ORIGIN ?? `http://localhost:${port}`);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    origin = url.origin;
  } catch {
    throw new Error('Configuración inválida: APP_ORIGIN');
  }
  const trustedProxies = [env.TRUSTED_PROXY, env.TRUSTED_PROXIES].filter(Boolean).join(',').split(',').map(s => normalizeIp(s.trim())).filter(Boolean);
  if (trustedProxies.some(ip => !isIP(ip))) throw new Error('Configuración inválida: TRUSTED_PROXY/TRUSTED_PROXIES (solo IP explícitas)');
  const vapidSubject = env.VAPID_SUBJECT || (origin.startsWith('https:') ? origin : null);
  if (vapidSubject) {
    let valid = /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(vapidSubject);
    try {
      const subject = new URL(vapidSubject);
      valid ||= subject.protocol === 'https:' && !subject.username && !subject.password && !subject.hash;
    } catch { /* La validación mailto es suficiente cuando aplica. */ }
    if (!valid || vapidSubject.length > 512) throw new Error('Configuración inválida: VAPID_SUBJECT');
  }
  return {
    origin,
    host: env.HOST || '127.0.0.1',
    port,
    metricsPort,
    metricsPeers: new Set(metricsPeers),
    dataDir: resolve(env.DATA_DIR || resolve(ROOT, 'data')),
    publicDir: resolve(ROOT, 'public'),
    catalogCredentialsPath: env.EVSARE_CATALOG_CREDENTIALS ? resolve(env.EVSARE_CATALOG_CREDENTIALS) : null,
    remoteCharge: env.EVSARE_REMOTE_CHARGE === '1',
    remoteChargeTargets: remoteChargeTargets(env.EVSARE_REMOTE_CHARGE_TARGETS),
    offerSeconds: integer(env, 'OFFER_SECONDS', 120, 1, 3600),
    arrivalSeconds: integer(env, 'ARRIVAL_SECONDS', 600, 1, 86400),
    staleSeconds: integer(env, 'STALE_SECONDS', 300, 1, 86400),
    vapidSubject,
    trustedProxies: new Set(trustedProxies),
    secureCookies: origin.startsWith('https:'),
    sessionSeconds: 7 * 86400,
    bodyLimit: 16 * 1024,
    workerInterval: 1000,
  };
}
