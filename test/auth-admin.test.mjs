import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { statSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.mjs';
import { hashPassword, verifyPassword, createAdmin } from '../src/auth.mjs';
import { backupData } from '../src/admin.mjs';
import { loadVapidKeys } from '../src/push.mjs';
import { fixture, isCode } from './helpers.mjs';

test('scrypt asíncrono con salt distinto, verificación constante y sin aceptar hash corrupto', async () => {
  const password = 'synthetic-long-password-only-for-tests';
  const [a, b] = await Promise.all([hashPassword(password), hashPassword(password)]);
  assert.notEqual(a === b, true);
  assert.equal(await verifyPassword(password, a), true);
  assert.equal(await verifyPassword('incorrect-password', a), false);
  assert.equal(await verifyPassword(password, 'corrupt'), false);
  assert.equal(await verifyPassword(password), false);
});

test('scrypt acota concurrencia y memoria sin bloquear el event loop', async () => {
  const tasks = [hashPassword('synthetic-one-password'), hashPassword('synthetic-two-password'), hashPassword('synthetic-three-password')];
  const settled = Promise.allSettled(tasks);
  let loopRan = false;
  await new Promise(resolve => setImmediate(() => { loopRan = true; resolve(); }));
  assert.equal(loopRan, true);
  const results = await settled;
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'AUTH_BUSY');
});

test('config valida orígenes, tiempos y proxies; no acepta comodín de confianza', () => {
  for (const env of [{ APP_ORIGIN: 'https://example.test/path' }, { APP_ORIGIN: 'https://a:b@example.test' }, { APP_ORIGIN: 'javascript:alert(1)' }, { OFFER_SECONDS: '0' }, { ARRIVAL_SECONDS: 'NaN' }, { STALE_SECONDS: '-1' }, { PORT: '65536' }, { TRUSTED_PROXIES: '*' }, { VAPID_SUBJECT: 'not-a-uri' }]) assert.throws(() => loadConfig(env), /Configuración inválida/);
  const c = loadConfig({ APP_ORIGIN: 'https://example.test/', TRUSTED_PROXIES: '127.0.0.1, ::ffff:10.0.0.2' });
  assert.equal(c.origin, 'https://example.test');
  assert.equal(c.vapidSubject, 'https://example.test');
  assert.equal(c.trustedProxies.has('10.0.0.2'), true);
  assert.equal(loadConfig({ TRUSTED_PROXY: '192.0.2.10' }).trustedProxies.has('192.0.2.10'), true);
});

test('CLI admin password por stdin, sin promoción de usuario existente ni password en stdout', async t => {
  const f = fixture(t);
  const password = 'synthetic-cli-test-password';
  const cli = new URL('../src/admin.mjs', import.meta.url);
  const env = { ...process.env, DATA_DIR: f.config.dataDir, APP_ORIGIN: 'https://alacarga.test' };
  const result = spawnSync(process.execPath, [cli.pathname, 'create', 'cli_admin'], { input: `${password}\n`, encoding: 'utf8', env, timeout: 10000 });
  assert.equal(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`.includes(password), false);
  const row = f.db.prepare('SELECT role,password_hash FROM users WHERE username=?').get('cli_admin');
  assert.equal(row.role, 'admin');
  assert.equal(await verifyPassword(password, row.password_hash), true);
  const userId = f.user();
  const username = f.db.prepare('SELECT username FROM users WHERE id=?').get(userId).username;
  await assert.rejects(createAdmin(f.db, { username, password }), isCode('USERNAME_EXISTS'));
  assert.equal(f.db.prepare('SELECT role FROM users WHERE id=?').get(userId).role, 'user');
  const argvPassword = spawnSync(process.execPath, [cli.pathname, 'create', 'cli_admin', password], { encoding: 'utf8', env, timeout: 10000 });
  assert.equal(argvPassword.status, 1);
  assert.equal(`${argvPassword.stdout}${argvPassword.stderr}`.includes(password), false);
  const backupResult = spawnSync(process.execPath, [cli.pathname, 'backup', join(f.directory, 'cli-backup')], { encoding: 'utf8', env, timeout: 10000 });
  assert.equal(backupResult.status, 0);
  assert.equal(statSync(join(f.directory, 'cli-backup', 'alacarga.sqlite')).mode & 0o777, 0o600);
});

test('backup online incluye WAL consistente y VAPID, privado, verificable, sin sobrescribir', async t => {
  const f = fixture(t), z = f.zone(), r = f.resource(z), u = f.user();
  f.service.claim(u, r, { expectedReleaseAt: f.clock() + 10000 });
  loadVapidKeys(f.config.dataDir);
  const destination = join(f.directory, 'backup');
  await backupData(f.config.dataDir, destination);
  assert.equal(statSync(destination).mode & 0o777, 0o700);
  assert.equal(statSync(join(destination, 'alacarga.sqlite')).mode & 0o777, 0o600);
  assert.equal(statSync(join(destination, 'vapid.json')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(destination, 'vapid.json')).equals(readFileSync(join(f.config.dataDir, 'vapid.json'))), true);
  const copied = new DatabaseSync(join(destination, 'alacarga.sqlite'), { readOnly: true });
  try {
    assert.equal(copied.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(copied.prepare('SELECT state FROM queue').get().state, 'CHARGING');
    assert.equal(copied.prepare('SELECT count(*) AS n FROM resources').get().n, 1);
  } finally { copied.close(); }
  await assert.rejects(backupData(f.config.dataDir, destination), error => error.code === 'EEXIST');
});
