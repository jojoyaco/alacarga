import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createECDH, randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { Service } from '../src/service.mjs';

const preferred = tmpdir();
export function temporary(t) {
  const directory = mkdtempSync(join(existsSync(preferred) ? preferred : tmpdir(), 'alacarga-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
export function testConfig(directory, overrides = {}) {
  return { ...loadConfig({ DATA_DIR: join(directory, 'data'), APP_ORIGIN: 'https://alacarga.test', VAPID_SUBJECT: 'mailto:ops@example.test' }), publicDir: join(directory, 'public'), ...overrides };
}
export function fixture(t, overrides = {}) {
  const directory = temporary(t);
  const config = testConfig(directory, overrides);
  const clockState = { now: 1800000000000 };
  const clock = () => clockState.now;
  const f = { directory, config, clock, clockState, advance: amount => { clockState.now += amount; } };
  f.db = openDatabase(config.dataDir);
  f.service = new Service(f.db, config, clock);
  f.reopen = () => {
    f.db.close();
    f.db = openDatabase(config.dataDir);
    f.service = new Service(f.db, config, clock);
  };
  t.after(() => { if (f.db.isOpen) f.db.close(); });
  let sequence = 0;
  f.user = () => Number(f.db.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES (?,'synthetic-test-only','user',?)").run(`person_${++sequence}`, clock()).lastInsertRowid);
  f.zone = () => f.service.createZone({ name: 'Zona de prueba', description: 'Datos sintéticos solo en DB temporal.' }).zone.id;
  f.resource = (zoneId, connector = 'TYPE2') => f.service.createResource({ zoneId, name: `Plaza ${connector}`, connector, powerKw: 22 }).resource.id;
  f.available = resourceId => f.service.setStatus(resourceId, { status: 'AVAILABLE' });
  return f;
}
export function subscription(suffix = 'test-only') {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`, expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
export function isCode(code) { return error => error?.code === code; }
