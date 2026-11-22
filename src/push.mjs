import * as webpush from 'web-push';
import { ECDH, createECDH, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns';
import { Agent } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { constants, openSync, closeSync, readFileSync, writeFileSync, linkSync, unlinkSync, fchmodSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, fail, object } from './errors.mjs';
import { normalizeIp } from './config.mjs';

export function allowedPushHost(host) {
  return host === 'fcm.googleapis.com' || host === 'web.push.apple.com' ||
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+push\.services\.mozilla\.com$/.test(host) ||
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+notify\.windows\.com$/.test(host);
}

export function validateEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || /[\s\\]/u.test(endpoint)) fail(400, 'INVALID_PUSH_ENDPOINT', 'Endpoint push no válido.');
  let url;
  try { url = new URL(endpoint); } catch { fail(400, 'INVALID_PUSH_ENDPOINT', 'Endpoint push no válido.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !allowedPushHost(url.hostname) || url.pathname === '/') {
    fail(400, 'INVALID_PUSH_ENDPOINT', 'Solo se admiten proveedores push conocidos por HTTPS.');
  }
  return url.href;
}

function base64Key(value, bytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length !== Math.ceil(bytes * 4 / 3)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === bytes && decoded.toString('base64url') === value ? decoded : null;
}

export function validateSubscription(body, now = Date.now()) {
  object(body); object(body.keys);
  const endpoint = validateEndpoint(body.endpoint);
  const publicKey = base64Key(body.keys.p256dh, 65);
  if (!publicKey || publicKey[0] !== 4 || !base64Key(body.keys.auth, 16)) fail(400, 'INVALID_PUSH_KEYS', 'Claves push no válidas.');
  try { ECDH.convertKey(publicKey, 'prime256v1', undefined, undefined, 'uncompressed'); }
  catch { fail(400, 'INVALID_PUSH_KEYS', 'Clave pública push no válida.'); }
  const expirationTime = body.expirationTime ?? null;
  if (expirationTime !== null && (!Number.isSafeInteger(expirationTime) || expirationTime <= now)) fail(400, 'INVALID_PUSH_EXPIRATION', 'La suscripción push ya venció o no es válida.');
  return { endpoint, expirationTime, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth } };
}

export function loadVapidKeys(dataDir) {
  const path = join(dataDir, 'vapid.json');
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('No se pueden abrir las claves VAPID.');
    const temp = join(dataDir, `.vapid-${randomBytes(16).toString('hex')}.tmp`);
    try {
      writeFileSync(temp, JSON.stringify(webpush.generateVAPIDKeys()), { flag: 'wx', mode: 0o600, flush: true });
      try { linkSync(temp, path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > 1024) throw new Error();
    fchmodSync(fd, 0o600);
    const keys = JSON.parse(readFileSync(fd, 'utf8'));
    if (!base64Key(keys.publicKey, 65) || !base64Key(keys.privateKey, 32)) throw new Error();
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(keys.privateKey, 'base64url'));
    if (ecdh.getPublicKey().toString('base64url') !== keys.publicKey) throw new Error();
    return { publicKey: keys.publicKey, privateKey: keys.privateKey };
  } catch { throw new Error('Claves VAPID inválidas; no se regeneraron para preservar las suscripciones.'); }
  finally { closeSync(fd); }
}

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001:db8::', 32], ['2001::', 32], ['2002::', 16]]) blocked.addSubnet(address, prefix, 'ipv6');

export function isPublicAddress(address) {
  const normalized = normalizeIp(address);
  const family = isIP(normalized);
  if (family === 4) return !blocked.check(normalized, 'ipv4');
  // Solo unicast global IPv6; excluye localhost, ULA, link-local, multicast y NAT64.
  return family === 6 && /^[23][0-9a-f]{0,3}:/i.test(normalized) && !blocked.check(normalized, 'ipv6');
}

function safeLookup(hostname, options, callback) {
  if (!allowedPushHost(hostname)) return callback(new Error('Proveedor push no autorizado.'));
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) return callback(new Error('Dirección push no pública.'));
    const family = typeof options === 'number' ? options : options?.family;
    const filtered = family ? addresses.filter(entry => entry.family === family) : addresses;
    if (!filtered.length) return callback(new Error('Dirección push no disponible.'));
    if (options?.all) callback(null, filtered);
    else callback(null, filtered[0].address, filtered[0].family);
  });
}

export function createPushSender(config, keys, transport = webpush.sendNotification, deadlineMs = 10000) {
  if (!config.vapidSubject) return null;
  return async (subscription, payload, options) => {
    validateSubscription(subscription);
    // Sin proxy, sin redirecciones, con DNS público validado en el propio socket TLS.
    const agent = new Agent({ keepAlive: false, maxSockets: 1, lookup: safeLookup });
    let timeout;
    try {
      return await Promise.race([
        transport(subscription, payload, { ...options, timeout: 8000, agent,
          contentEncoding: 'aes128gcm', vapidDetails: { subject: config.vapidSubject, ...keys } }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => { agent.destroy(); reject(new Error('Push deadline exceeded.')); }, deadlineMs);
        }),
      ]);
    } finally { clearTimeout(timeout); agent.destroy(); }
  };
}

export class PushWorker {
  constructor(service, send) { this.service = service; this.send = send; this.running = null; this.stopping = false; }
  drain(limit = 20) {
    if (this.running) return this.running;
    if (!this.send || this.stopping) return Promise.resolve(0);
    this.running = this.run(limit).finally(() => { this.running = null; });
    return this.running;
  }
  async run(limit) {
    let count = 0;
    while (!this.stopping && count < limit) {
      const job = this.service.claimPush();
      if (!job) break;
      const subscription = { endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth } };
      let result;
      try {
        validateSubscription(subscription, this.service.clock());
        const payload = JSON.stringify({ title: job.title, body: job.body, url: '/', tag: `alacarga-${job.notification_id}`,
          type: job.kind.toLowerCase(), notificationId: job.notification_id, queueId: job.queue_id, expiresAt: job.expires_at });
        result = await this.send(subscription, payload, { TTL: job.ttl, urgency: job.kind === 'OFFER' ? 'high' : 'normal', topic: `tc-${job.notification_id}` });
      } catch (error) {
        // Nunca registrar el error del proveedor: puede contener endpoint, claves o payload.
        result = { statusCode: error instanceof AppError ? 400 : error?.statusCode, headers: error?.headers };
      }
      this.service.finishPush(job, result);
      count++;
    }
    return count;
  }
  async stop() { this.stopping = true; if (this.running) await this.running; }
}
