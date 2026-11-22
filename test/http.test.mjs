import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication, clientIp } from '../src/http.mjs';
import { digest, createAdmin } from '../src/auth.mjs';
import { transaction } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { ChargerCatalog, normalizeCatalog, terminalState } from '../src/charger-catalog.mjs';
import { temporary, testConfig, subscription } from './helpers.mjs';

const PASSWORD = 'synthetic-test-only-password';

async function fixture(t, overrides = {}, appOptions = {}) {
  const directory = temporary(t), config = testConfig(directory, overrides);
  const state = { now: 1800000000000 }, logs = [];
  const f = { directory, config, state, logs, advance: amount => { state.now += amount; } };
  const start = async () => {
    f.app = createApplication({ config, clock: () => state.now, sendPush: null, log: code => logs.push(code), evsareFetch: async () => { throw new Error('No upstream network in unit tests'); }, ...appOptions });
    await new Promise(resolve => f.app.server.listen(0, '127.0.0.1', resolve));
    f.base = `http://127.0.0.1:${f.app.server.address().port}`;
  };
  await start();
  t.after(() => f.app.close());
  f.restart = async () => { await f.app.close(); await start(); };
  f.call = async (path, { method = 'GET', body, session, origin = true, headers = {}, raw } = {}) => {
    const requestHeaders = { ...headers };
    if (method === 'POST') {
      requestHeaders['content-type'] ??= 'application/json';
      if (origin) requestHeaders.origin ??= config.origin;
    }
    if (session) {
      requestHeaders.cookie = session.cookie;
      if (session.csrfToken) requestHeaders['x-csrf-token'] ??= session.csrfToken;
    }
    const res = await fetch(f.base + path, { method, headers: requestHeaders, body: raw ?? (method === 'POST' ? JSON.stringify(body ?? {}) : undefined) });
    const content = await res.text();
    const result = { status: res.status, headers: res.headers, text: content };
    if (res.headers.get('content-type')?.startsWith('application/json')) result.body = JSON.parse(content);
    return result;
  };
  f.adminSession = async username => {
    await createAdmin(f.app.db, { username, password: PASSWORD }, () => state.now);
    const result = await f.call('/api/admin/login', { method: 'POST', body: { username, password: PASSWORD } });
    assert.equal(result.status, 200);
    return { cookie: result.headers.get('set-cookie').split(';')[0], csrfToken: result.body.csrfToken, user: result.body.user };
  };
  let sequence = 0;
  // Fixture explícita, nunca usada por el runtime: login administrativo y EVsare se prueban por separado.
  f.session = (role = 'user', subject = null) => {
    const username = `fixture_${++sequence}`;
    const id = Number(f.app.db.prepare('INSERT INTO users(username,password_hash,role,created_at) VALUES (?,?,?,?)').run(username, 'synthetic-test-only', role, state.now).lastInsertRowid);
    if (subject !== null) f.app.db.prepare("INSERT INTO external_identities VALUES (?,'evsare',?,?)").run(id, subject, username);
    const signed = transaction(f.app.db, () => f.app.auth.issue({ id, username, role }));
    return { cookie: signed.cookie.split(';')[0], csrfToken: signed.view.csrfToken, user: signed.view.user };
  };
  return f;
}

test('HTTP private chargers authorize by upstream subject, never by local ID or admin role', async t => {
  const terminal = { id: 't1', name: 'Terminal privado', state: 'BUSY', connectors: [{ kind: 'TYPE2', name: 'Tipo 2', power: 22, state: 'BUSY' }], tariffSegments: [], parcels: [10] };
  const site = { id: 'e1', name: 'Sitio privado', address: 'Dirección de prueba', terminals: [terminal] };
  const catalog = { refresh: async () => {}, fresh: () => true, observedAt: 1800000000000, sites: [site], terminals: new Map([['t1', terminal]]),
    allows: (key, subject) => key === 't1' && subject === '42', view: subject => ({ observedAt: 1800000000000, sites: subject === '42' ? [site] : [] }) };
  const f = await fixture(t, {}, { catalog });
  const path = '/api/evsare/chargers';
  assert.equal((await f.call(path)).status, 401);
  assert.equal((await f.call(path, { session: f.session('admin') })).status, 404);
  const member = f.session('user', '42'), outsider = f.session('user', '43');
  const own = await f.call(path, { session: member });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await f.call(path, { session: outsider })).body.sites, []);
  assert.deepEqual((await f.call('/api/zones')).body.zones, []);
  const { id, zoneId, terminals: projected } = own.body.sites[0];
  assert.equal(id, 'e1');
  assert.ok(Number.isSafeInteger(zoneId));
  assert.deepEqual(projected[0].parcels, [10]);
  assert.equal(projected[0].zoneId, undefined);
  const favorite = (session, enabled) => f.call('/api/evsare/favorites', { method: 'POST', session, body: { zoneId, enabled } });
  assert.equal((await favorite(outsider, true)).status, 404);
  assert.equal((await favorite(member, true)).status, 200);
  const mine = (await f.call('/api/me', { session: member })).body;
  assert.deepEqual(mine.favorites, [zoneId]);
  assert.deepEqual(mine.subscriptions, []);
  assert.equal(mine.queue, null);
  assert.deepEqual((await f.call('/api/me', { session: outsider })).body.favorites, []);
  assert.equal((await favorite(member, false)).status, 200);
  assert.deepEqual((await f.call('/api/me', { session: member })).body.favorites, []);
  assert.equal((await f.call('/api/queue', { method: 'POST', session: outsider, body: { zoneId, connector: 'ANY' } })).status, 404);
  assert.equal((await f.call('/api/subscriptions', { method: 'POST', session: outsider, body: { zoneId, enabled: true } })).status, 404);
  assert.equal((await f.call('/api/subscriptions', { method: 'POST', session: member, body: { zoneId, enabled: true } })).status, 200);
  const queued = (await f.call('/api/queue', { method: 'POST', session: member, body: { zoneId, connector: 'ANY' } })).body.queue;
  assert.equal(queued.state, 'WAITING');
  assert.equal(queued.zoneId, zoneId);
  assert.deepEqual((await f.call('/api/me', { session: member })).body.subscriptions, [zoneId]);
});

test('private charger reads do not wait for an upstream refresh', async t => {
  let release;
  let readable = false;
  const pending = new Promise(resolve => { release = resolve; });
  const catalog = { refresh: () => pending, pending, readable: () => readable, fresh: () => false,
    view: () => ({ status: 'stale', observedAt: 1799999995000, sites: [] }) };
  const f = await fixture(t, {}, { catalog });
  t.after(release);
  const path = '/api/evsare/chargers', session = f.session('user', '42');
  try {
    const first = await f.call(path);
    assert.equal(first.status, 401);
    const cold = await f.call(path, { session });
    assert.equal(cold.status, 202);
    assert.equal(cold.headers.get('cache-control'), 'no-store');
    assert.deepEqual(cold.body, { status: 'syncing' });
    readable = true;
    const cached = await f.call(path, { session });
    assert.equal(cached.status, 200);
    assert.equal(cached.body.status, 'stale');
  } finally { release(); }
});

async function chargeFixture(t, overrides = {}) {
  const metadata = normalizeCatalog({ e1: { id: 1, name: 'Sitio de prueba', terminalsId: ['t99', 't98'] } }, {
    t99: { id: 99, emplacementId: 1, connectedToIbilsare: false, userId: ['u42', 'u44'], description: 'Cargador · Plaza 10-11',
      connectors: { c0: { id: 7, idphysical: 'B', type: 2, power: 22 }, c1: { id: 8, idphysical: 'A', type: 2, power: 22 } } },
    t98: { id: 98, emplacementId: 1, userId: ['u42', 'u43'], description: 'Otro terminal', connectors: { c0: { id: 7, idphysical: 'B', type: 2, power: 22 } } },
  }, {});
  const telemetry = { t99: { connectors: { unrelatedKey: { id: 7, state: 1 }, differentKey: { id: 8, state: 1 } } } };
  const catalog = new ChargerCatalog(null, { clock: () => f.state.now });
  catalog.refresh = async () => {};
  const replies = { card: [{ idtarjetarfid: 314159 }], send: () => Response.json({ iniciada: true, sessionid: 'SYNTHETIC-SECRET' }, { status: 201 }) };
  const calls = [];
  const evsareFetch = async (url, request) => {
    const path = url.slice('https://appkbs.ibilcloud.com'.length);
    assert.equal(request.redirect, 'error');
    if (path === '/user/login2') return Response.json({ valid: true, user: { userId: Number(JSON.parse(request.body).idUsuario) }, token: 'test-provider-token' });
    assert.equal(request.headers['X-IBIL-TOKEN'], 'test-provider-token');
    calls.push([path, request.method, request.body ? JSON.parse(request.body) : null]);
    if (path === '/user/cards?soloActivas=true') return await (replies.read?.() ?? Response.json({ cards: replies.card }));
    if (path === '/recargas/iniciarrecarga?broker_interop=IBILSARE') return await replies.send();
    throw new Error('Unexpected upstream route');
  };
  const f = await fixture(t, { remoteCharge: true, remoteChargeTargets: new Set(['e1:t99:7']), ...overrides }, { catalog, evsareFetch });
  const update = () => {
    catalog.metadata = metadata; catalog.metadataAt = catalog.observedAt = f.state.now;
    catalog.sites = metadata.sites.map(site => ({ ...site, terminals: site.terminals.map(terminal => terminalState(terminal, telemetry)) }));
    catalog.terminals = new Map(catalog.sites[0].terminals.map(terminal => [terminal.id, terminal]));
  };
  update();
  const login = async (subject = 42) => {
    const res = await f.call('/api/login', { method: 'POST', body: { username: String(subject), password: PASSWORD } });
    assert.equal(res.status, 200);
    return { cookie: res.headers.get('set-cookie').split(';')[0], csrfToken: res.body.csrfToken };
  };
  const member = await login();
  const [site] = (await f.call('/api/evsare/chargers', { session: member })).body.sites;
  const post = ({ session = member, body = { zoneId: site.zoneId, terminalId: 't99', connectorId: 7 }, ...rest } = {}) =>
    f.call('/api/evsare/start-charge', { method: 'POST', session, body, ...rest });
  return { f, login, member, site, post, replies, calls, metadata, telemetry, catalog, update };
}

test('remote charge flag alone does not enable dispatch or expose a connector ID', async t => {
  assert.equal(loadConfig({}).remoteCharge, false);
  assert.equal(loadConfig({ EVSARE_REMOTE_CHARGE: 'true' }).remoteCharge, false);
  const enabled = loadConfig({ EVSARE_REMOTE_CHARGE: '1', EVSARE_REMOTE_CHARGE_TARGETS: 'e1:t99:7' });
  assert.equal(enabled.remoteCharge, true);
  assert.deepEqual([...enabled.remoteChargeTargets], ['e1:t99:7']);
  assert.throws(() => loadConfig({ EVSARE_REMOTE_CHARGE_TARGETS: 'e1:t99:B' }), /EVSARE_REMOTE_CHARGE_TARGETS/);
  const { f, site, post, calls } = await chargeFixture(t, { remoteChargeTargets: new Set() });
  assert.equal((await f.call('/api/config')).body.remoteCharge, false);
  assert.equal(site.terminals[0].connectors[0].id, undefined);
  assert.equal((await post()).body.code, 'REMOTE_CHARGE_DISABLED');
  assert.deepEqual(calls, []);
});

test('remote charge refuses untrusted, stale, non-available or ambiguous selections before RFID lookup', async t => {
  const { f, login, post, site, metadata, telemetry, update, calls } = await chargeFixture(t);
  assert.equal((await f.call('/api/config')).body.remoteCharge, true);
  assert.deepEqual(site.terminals[0].parcels, ['10', '11']);
  assert.deepEqual(site.terminals[0].connectors.map(c => [c.id, c.label]), [[7, 'B'], [undefined, 'A']]);
  assert.equal((await post({ session: null })).status, 401);
  assert.equal((await post({ session: f.session('admin') })).status, 403);
  assert.equal((await post({ headers: { 'x-csrf-token': 'invalid' } })).body.code, 'CSRF_REJECTED');
  assert.equal((await post({ origin: false })).body.code, 'ORIGIN_REJECTED');
  const otherTerminalMember = await login(43);
  const [sameSite] = (await f.call('/api/evsare/chargers', { session: otherTerminalMember })).body.sites;
  assert.equal(sameSite.zoneId, site.zoneId);
  assert.deepEqual(sameSite.terminals.map(t => t.id), ['t98']);
  assert.equal((await post({ session: otherTerminalMember })).status, 404);
  const invalid = body => post({ body: { zoneId: site.zoneId, terminalId: 't99', connectorId: 7, ...body } });
  assert.equal((await invalid({ zoneId: site.zoneId + 1 })).status, 404);
  assert.equal((await invalid({ terminalId: 't98' })).status, 404);
  assert.equal((await invalid({ connectorId: 'B' })).status, 400);
  assert.equal((await invalid({ connectorId: 8 })).status, 404);
  assert.equal((await invalid({ parcel: '10' })).status, 400);
  assert.equal((await invalid({ cardId: 314159 })).status, 400);
  f.advance(40000);
  assert.equal((await post()).body.code, 'REMOTE_CHARGE_STALE');
  const terminal = metadata.sites[0].terminals[0];
  terminal.connectors[0].label = null; update();
  assert.equal((await post()).status, 404);
  terminal.connectors[0].label = 'A'; update();
  assert.equal((await post()).status, 404);
  terminal.connectors[0].label = 'B';
  terminal.connectors.push({ ...terminal.connectors[0] }); update();
  assert.equal((await post()).status, 404);
  terminal.connectors.pop();
  telemetry.t99.connectors.duplicate = { id: 7, state: 1 }; update();
  assert.equal((await post()).body.code, 'REMOTE_CHARGE_NOT_AVAILABLE');
  delete telemetry.t99.connectors.duplicate;
  telemetry.t99.connectors.unrelatedKey.state = 2; update();
  assert.equal((await post()).body.code, 'REMOTE_CHARGE_NOT_AVAILABLE');
  assert.deepEqual(calls, []);
});

test('remote charge uses the sole RFID server-side and revalidates session/telemetry after lookup', async t => {
  const { f, post, member, replies, calls, login, metadata, update } = await chargeFixture(t);
  for (const cards of [[], [{ idtarjetarfid: 314159 }, {}]]) {
    replies.card = cards;
    assert.equal((await post()).body.code, 'EVSARE_CHARGE_RFID_NOT_UNIQUE');
  }
  replies.card = [{ idtarjetarfid: 314159 }];
  replies.read = () => { f.advance(40000); return Response.json({ cards: replies.card }); };
  assert.equal((await post()).body.code, 'REMOTE_CHARGE_STALE');
  update();
  const [target] = metadata.sites[0].terminals[0].connectors;
  replies.read = () => { target.label = 'C'; update(); return Response.json({ cards: replies.card }); };
  assert.equal((await post()).body.code, 'REMOTE_CHARGE_TARGET_CHANGED');
  target.label = 'B'; update();
  replies.read = () => { metadata.permissions.get('t99').delete('42'); return Response.json({ cards: replies.card }); };
  assert.equal((await post()).body.code, 'REMOTE_CHARGE_TARGET_NOT_FOUND');
  metadata.permissions.get('t99').add('42');
  replies.read = async () => {
    await f.call('/api/logout', { method: 'POST', session: member });
    return Response.json({ cards: replies.card });
  };
  assert.equal((await post()).status, 401);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM remote_charge_attempts').get().n, 0);
  assert.ok(calls.every(call => call[1] === 'GET'));
  delete replies.read;
  const result = await post({ session: await login() });
  assert.deepEqual(result.body, { started: true });
  assert.deepEqual(calls.at(-1), ['/recargas/iniciarrecarga?broker_interop=IBILSARE', 'POST', { terminal: 99, conector: 7, idtarjetarfid: 314159 }]);
  assert.equal(f.app.db.prepare('SELECT status FROM remote_charge_attempts').get().status, 'ACCEPTED');
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM queue').get().n, 0);
});

test('remote charge excludes only concurrent account or terminal requests, not recorded attempts after reopen', async t => {
  const { f, login, post, replies, calls } = await chargeFixture(t);
  const other = await login(44);
  let markDispatch;
  const dispatched = new Promise(resolve => { markDispatch = resolve; });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  replies.send = async () => { markDispatch(); await pending; return Response.json({ error: 'SYNTHETIC-SECRET' }, { status: 401 }); };
  const first = post();
  try {
    await dispatched;
    assert.equal(f.app.db.prepare('SELECT status FROM remote_charge_attempts').get().status, 'UNCONFIRMED');
    assert.equal((await post({ session: other })).body.code, 'REMOTE_CHARGE_IN_PROGRESS');
    assert.equal((await post()).body.code, 'REMOTE_CHARGE_IN_PROGRESS');
  } finally { release(); }
  const uncertain = await first;
  assert.equal(uncertain.body.code, 'REMOTE_CHARGE_UNCONFIRMED');
  assert.doesNotMatch(uncertain.text, /SYNTHETIC|314159|test-provider-token/);
  await f.restart();
  assert.equal(calls.filter(call => call[1] === 'POST').length, 1);
  replies.send = () => Response.json({ iniciada: true }, { status: 201 });
  assert.deepEqual((await post()).body, { started: true });
  assert.deepEqual((await post({ session: other })).body, { started: true });
  assert.deepEqual(f.app.db.prepare('SELECT status FROM remote_charge_attempts ORDER BY sequence').all().map(row => row.status),
    ['UNCONFIRMED', 'ACCEPTED', 'ACCEPTED']);
  assert.equal(calls.filter(call => call[1] === 'POST').length, 3);
});

test('HTTP health/config/empty zones/session, cabeceras CSP estrictas y no exposición de VAPID privado', async t => {
  const f = await fixture(t);
  const health = await f.call('/api/health');
  assert.equal(health.status, 200); assert.deepEqual(health.body, { ok: true });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.match(health.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.doesNotMatch(health.headers.get('content-security-policy'), /unsafe-inline|unsafe-eval/);
  assert.equal(health.headers.get('access-control-allow-origin'), null);
  const config = (await f.call('/api/config')).body;
  assert.deepEqual(Object.keys(config).sort(), ['arrivalSeconds', 'authProvider', 'integrationStatus', 'mapStatus', 'offerSeconds', 'remoteCharge', 'rfidMode', 'source', 'staleSeconds', 'vapidPublicKey']);
  assert.equal(config.remoteCharge, false);
  assert.equal(config.rfidMode, 'read-only');
  assert.equal(config.vapidPublicKey.length, 87);
  assert.equal(config.integrationStatus, 'partial');
  assert.equal(config.authProvider, 'evsare'); assert.equal(config.mapStatus, 'unavailable');
  assert.deepEqual((await f.call('/api/zones')).body, { zones: [] });
  assert.deepEqual((await f.call('/api/session')).body, { user: null, csrfToken: null });
  assert.equal((await f.call('/api/me')).status, 401);
});

test('admin solo creado por CLI, scrypt y cookie HttpOnly/Secure; sesión hasheada persiste y caduca', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/register', { method: 'POST', body: { username: 'First_User', password: PASSWORD, role: 'admin' } })).status, 410);
  await createAdmin(f.app.db, { username: 'First_User', password: PASSWORD }, () => f.state.now);
  const response = await f.call('/api/admin/login', { method: 'POST', body: { username: 'First_User', password: PASSWORD, role: 'user', userId: 999 } });
  assert.equal(response.status, 200);
  assert.equal(response.body.user.role, 'admin'); assert.equal(response.body.user.provider, 'local');
  const header = response.headers.get('set-cookie');
  assert.match(header, /^__Host-alacarga_session=/);
  for (const flag of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/']) assert.ok(header.includes(flag));
  const session = { cookie: header.split(';')[0], csrfToken: response.body.csrfToken };
  const token = session.cookie.split('=')[1];
  const user = f.app.db.prepare('SELECT password_hash,role FROM users').get();
  assert.match(user.password_hash, /^scrypt\$32768\$8\$3\$/);
  assert.equal(user.password_hash.includes(PASSWORD), false);
  const persisted = f.app.db.prepare('SELECT token_hash FROM sessions').get();
  assert.equal(persisted.token_hash === token, false);
  assert.equal(persisted.token_hash === digest(token), true);
  await f.restart();
  assert.equal((await f.call('/api/session', { session })).body.user.username, 'First_User');
  await assert.rejects(createAdmin(f.app.db, { username: 'first_user', password: PASSWORD }), { code: 'USERNAME_EXISTS' });
  f.advance(f.config.sessionSeconds * 1000);
  assert.equal((await f.call('/api/session', { session })).body.user, null);
  assert.equal((await f.call('/api/logout', { method: 'POST', session })).status, 401);
});

test('Origin estricto también register/login/admin; CSRF exige sesión incluso al cambiar de cuenta; logout revoca', async t => {
  const f = await fixture(t);
  for (const endpoint of ['/api/register', '/api/login', '/api/admin/login']) {
    for (const origin of [undefined, 'https://evil.test', 'https://alacarga.test.evil.test', 'null']) {
      const headers = origin ? { origin } : {};
      const result = await f.call(endpoint, { method: 'POST', body: { username: 'origin_test', password: PASSWORD }, origin: false, headers });
      assert.equal(result.status, 403);
      assert.equal(result.body.code, 'ORIGIN_REJECTED');
    }
  }
  const session = await f.adminSession('origin_user');
  for (const path of ['/api/logout', '/api/login', '/api/admin/login', '/api/register', '/api/queue']) {
    const result = await f.call(path, { method: 'POST', session: { cookie: session.cookie }, body: { username: 'another', password: PASSWORD } });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'CSRF_REJECTED');
  }
  assert.equal((await f.call('/api/logout', { method: 'POST', session, headers: { 'x-csrf-token': 'wrong' } })).status, 403);
  assert.equal((await f.call('/api/logout', { method: 'POST', session, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const logout = await f.call('/api/logout', { method: 'POST', session });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await f.call('/api/session', { session })).body.user, null);
  const login = await f.call('/api/admin/login', { method: 'POST', body: { username: 'ORIGIN_USER', password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.notEqual(login.headers.get('set-cookie').split(';')[0] === session.cookie, true);
  const wrong = await f.call('/api/admin/login', { method: 'POST', body: { username: 'origin_user', password: 'not-the-right-password' } });
  assert.equal(wrong.status, 401); assert.equal(wrong.body.code, 'INVALID_CREDENTIALS');
});

test('validación credenciales, JSON, tamaños, métodos y cuerpo comprimido', async t => {
  const f = await fixture(t);
  for (const body of [{ username: 'ab', password: PASSWORD }, { username: 'a'.repeat(33), password: PASSWORD }, { username: 'user<script>', password: PASSWORD }, { username: 'valid_user', password: 'short' }, { username: 'valid_user', password: 'p'.repeat(129) }]) {
    assert.equal((await f.call('/api/admin/login', { method: 'POST', body })).status, 400);
  }
  for (const raw of ['[]', 'null', '{', '"str"']) assert.equal((await f.call('/api/login', { method: 'POST', raw })).status, 400);
  assert.equal((await f.call('/api/login', { method: 'POST', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.call('/api/login', { method: 'POST', headers: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await f.call('/api/login', { method: 'POST', raw: JSON.stringify({ data: 'x'.repeat(20000) }) })).status, 413);
  assert.equal((await f.call('/api/health', { method: 'DELETE' })).status, 405);
  assert.equal((await f.call('/api/missing')).status, 404);
  const chunked = await new Promise((resolve, reject) => {
    const req = httpRequest(f.base + '/api/login', { method: 'POST', headers: { origin: f.config.origin, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject); req.write('{"x":"' + 'x'.repeat(18000)); req.end('"}');
  });
  assert.equal(chunked, 413);
});

test('rate limit de autenticación persistido; XFF falso no lo evita', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 12; i++) {
    const result = await f.call('/api/admin/login', { method: 'POST', body: { username: `absent_${i}`, password: PASSWORD }, headers: { 'x-forwarded-for': `198.51.100.${i}` } });
    assert.equal(result.status, 401);
  }
  await f.restart();
  const limited = await f.call('/api/admin/login', { method: 'POST', body: { username: 'one_more', password: PASSWORD }, headers: { 'x-forwarded-for': '8.8.8.8' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.ok(limited.headers.get('retry-after'));
  f.advance(15 * 60000);
  assert.equal((await f.call('/api/admin/login', { method: 'POST', body: { username: 'one_more', password: PASSWORD } })).status, 401);
});

test('XFF solo desde proxies explícitos y hacia primer salto no confiable', () => {
  const request = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '1.1.1.1, 10.0.0.2' } };
  assert.equal(clientIp(request), '127.0.0.1');
  assert.equal(clientIp(request, new Set(['127.0.0.1'])), '10.0.0.2');
  assert.equal(clientIp(request, new Set(['127.0.0.1', '10.0.0.2'])), '1.1.1.1');
  request.headers['x-forwarded-for'] = 'invalid, 10.0.0.2';
  assert.equal(clientIp(request, new Set(['127.0.0.1'])), '127.0.0.1');
});

test('API admin y lifecycle completo comunitario, IDOR, source y fin manual', async t => {
  const f = await fixture(t), admin = f.session('admin'), owner = f.session(), waiting = f.session();
  const post = (path, body, session = admin) => f.call(path, { method: 'POST', body, session });
  assert.equal((await post('/api/admin/zones', { name: 'Not allowed' }, owner)).status, 403);
  const zone = await post('/api/admin/zones', { name: 'Zona comunidad', description: 'Prueba', latitude: 40.4, longitude: -3.7, radiusMeters: 500 });
  assert.equal(zone.status, 200);
  const resource = await post('/api/admin/resources', { zoneId: zone.body.zone.id, name: 'Plaza 1', connector: 'TYPE2', powerKw: 22 });
  assert.equal(resource.status, 200); assert.equal(resource.body.resource.status, 'UNKNOWN');
  const rid = resource.body.resource.id;
  const claimed = await post(`/api/resources/${rid}/claim`, { expectedReleaseAt: f.state.now + 2000 }, owner);
  assert.equal(claimed.status, 200); assert.equal(claimed.body.queue.state, 'CHARGING');
  const qid = claimed.body.queue.id;
  const queued = await post('/api/queue', { zoneId: zone.body.zone.id, connector: 'ANY', userId: owner.user.id }, waiting);
  assert.equal(queued.status, 200); assert.equal(queued.body.queue.state, 'WAITING');
  assert.equal((await post(`/api/queue/${qid}/release`, {}, waiting)).status, 404);
  assert.equal((await post(`/api/admin/resources/${rid}/charge-finished`, {}, owner)).status, 403);
  assert.equal((await post(`/api/admin/resources/${rid}/charge-finished`, {})).status, 200);
  const before = await f.call('/api/me', { session: owner });
  assert.equal(before.body.queue.chargeFinishedAt, f.state.now);
  assert.equal(before.body.queue.state, 'CHARGING');
  assert.equal((await post(`/api/queue/${qid}/release`, {}, owner)).status, 200);
  const next = (await f.call('/api/me', { session: waiting })).body.queue;
  assert.equal(next.state, 'OFFERED');
  assert.equal((await post(`/api/queue/${next.id}/accept`, {}, waiting)).body.queue.state, 'ACCEPTED');
  assert.equal((await post(`/api/queue/${next.id}/start`, {}, waiting)).body.queue.state, 'CHARGING');
  assert.equal((await post(`/api/queue/${next.id}/estimate`, { expectedReleaseAt: f.state.now + 10000 }, waiting)).status, 200);
  assert.equal((await post(`/api/queue/${qid}/release`, {}, owner)).status, 200);
  const current = (await f.call('/api/me', { session: waiting })).body.queue;
  assert.equal(current.state, 'CHARGING');
  assert.equal((await post(`/api/admin/resources/${rid}/status`, { status: 'STALE' })).status, 400);
  assert.equal((await post('/api/admin/resources', { zoneId: '1', name: 'Bad', connector: 'ANY', powerKw: -1 })).status, 400);
});

test('API suscripción de zona separada de cola, push ownership y límite de pruebas', async t => {
  const f = await fixture(t), a = f.session(), b = f.session();
  const z = f.app.service.createZone({ name: 'Zona', description: '' }).zone.id;
  const post = (path, body, session = a) => f.call(path, { method: 'POST', body, session });
  assert.equal((await post('/api/subscriptions', { zoneId: z, enabled: true })).status, 200);
  assert.equal((await f.call('/api/me', { session: a })).body.queue, null);
  const sub = subscription();
  assert.equal((await post('/api/push/subscribe', sub)).status, 200);
  assert.equal((await post('/api/push/subscribe', sub, b)).status, 409);
  assert.equal((await post('/api/push/unsubscribe', { endpoint: sub.endpoint }, b)).status, 404);
  for (let i = 0; i < 3; i++) assert.equal((await post('/api/push/test', {})).status, 200);
  assert.equal((await post('/api/push/test', {})).status, 429);
  assert.equal((await post('/api/push/unsubscribe', { endpoint: sub.endpoint })).status, 200);
  assert.equal((await f.call('/api/me', { session: a })).body.pushEnabled, false);
});

test('errores saneados: ni stack, SQL ni cuerpos/tokens del proveedor llegan al cliente/log', async t => {
  const f = await fixture(t), admin = f.session('admin');
  const canary = 'synthetic-secret-canary-must-not-be-logged';
  f.app.service.createZone = () => { throw new Error(`SQL failed: ${canary}`); };
  const result = await f.call('/api/admin/zones', { method: 'POST', session: admin, body: { name: 'test' } });
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: 'Error interno del servicio.', code: 'INTERNAL_ERROR' });
  assert.deepEqual(f.logs, ['HTTP_INTERNAL_ERROR']);
  assert.equal(JSON.stringify(f.logs).includes(canary), false);
});

test('estáticos solo allowlist public, sin traversal/symlink/APK/docs/secretos; HEAD y SW', async t => {
  const f = await fixture(t);
  mkdirSync(f.config.publicDir);
  writeFileSync(join(f.config.publicDir, 'index.html'), '<!doctype html><title>A la caaarga!! test</title>');
  writeFileSync(join(f.config.publicDir, 'app.js'), 'export {};');
  writeFileSync(join(f.config.publicDir, 'proximity.js'), 'export {};');
  writeFileSync(join(f.config.publicDir, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(join(f.config.publicDir, 'hidden.txt'), 'not public');
  writeFileSync(join(f.directory, 'private.txt'), 'synthetic private content');
  symlinkSync(join(f.directory, 'private.txt'), join(f.config.publicDir, 'icon.svg'));
  assert.equal((await f.call('/')).status, 200);
  const head = await f.call('/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.text, '');
  assert.match(head.headers.get('content-type'), /javascript/);
  assert.match((await f.call('/proximity.js')).headers.get('content-type'), /javascript/);
  const sw = await f.call('/sw.js');
  assert.equal(sw.status, 200); assert.equal(sw.headers.get('cache-control'), 'no-store');
  for (const path of ['/src/server.mjs', '/docs/api.md', '/.env', '/vapid.json', '/data/alacarga.sqlite', '/EVsare.xapk', '/hidden.txt', '/icon.svg', '/%2e%2e/private.txt', '/..%2fprivate.txt']) assert.equal((await f.call(path)).status, 404);
});

test('worker independiente del navegador expira ofertas sin nuevas peticiones HTTP', async t => {
  const f = await fixture(t, { workerInterval: 10, offerSeconds: 1 });
  const a = f.session(), b = f.session(), s = f.app.service;
  const z = s.createZone({ name: 'Worker zone', description: '' }).zone.id;
  const r = s.createResource({ zoneId: z, name: 'Worker resource', connector: 'TYPE2', powerKw: 11 }).resource.id;
  s.setStatus(r, { status: 'AVAILABLE' });
  s.join(a.user.id, { zoneId: z, connector: 'ANY' }); s.join(b.user.id, { zoneId: z, connector: 'ANY' });
  f.app.startWorkers(); f.advance(1000);
  await delay(50);
  // Consulta SQL, no /me: la aserción no puede disparar la caducidad por sí misma.
  assert.equal(f.app.db.prepare('SELECT state FROM queue WHERE user_id=?').get(a.user.id).state, 'EXPIRED');
  assert.equal(f.app.db.prepare('SELECT state FROM queue WHERE user_id=?').get(b.user.id).state, 'OFFERED');
});

test('HTTP local no marca Secure por X-Forwarded-Proto y push sin sujeto falla cerrado', async t => {
  const f = await fixture(t, { origin: 'http://localhost:3000', secureCookies: false, vapidSubject: null });
  const session = f.session();
  assert.match(f.app.auth.cookie('example'), /^alacarga_session=/);
  assert.doesNotMatch(f.app.auth.cookie('example'), /Secure/);
  const config = await f.call('/api/config', { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(config.body.vapidPublicKey, null);
  assert.equal((await f.call('/api/push/subscribe', { method: 'POST', session, body: subscription() })).status, 503);
});

test('HTTP plannedMinutes se valida y persiste; /me informa personas delante y duración faltante sin precisión falsa', async t => {
  const f = await fixture(t), a = f.session(), b = f.session(), occupant = f.session();
  const s = f.app.service, z = s.createZone({ name: 'Plan de espera', description: '' }).zone.id;
  const r = s.createResource({ zoneId: z, name: 'Plaza', connector: 'TYPE2', powerKw: 22 }).resource.id;
  const eta = f.state.now + 3600000;
  s.claim(occupant.user.id, r, { expectedReleaseAt: eta });
  for (const plannedMinutes of [0, -1, 721, 1.5, '30', true, {}, []]) {
    const response = await f.call('/api/queue', { method: 'POST', session: a, body: { zoneId: z, connector: 'ANY', plannedMinutes } });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'INVALID_PLANNED_MINUTES');
  }
  const first = await f.call('/api/queue', { method: 'POST', session: a, body: { zoneId: z, connector: 'ANY', plannedMinutes: null } });
  assert.equal(first.status, 200);
  assert.equal(first.body.queue.plannedMinutes, null);
  assert.equal(first.body.queue.peopleAhead, 0);
  assert.equal(first.body.queue.estimatedTurnAt, eta);
  const second = await f.call('/api/queue', { method: 'POST', session: b, body: { zoneId: z, connector: 'ANY', plannedMinutes: 45 } });
  assert.equal(second.status, 200);
  assert.equal(second.body.queue.plannedMinutes, 45);
  await f.restart();
  const me = (await f.call('/api/me', { session: b })).body;
  assert.equal(me.queue.plannedMinutes, 45);
  assert.equal(me.queue.peopleAhead, 1); assert.equal(me.queue.position, 2);
  assert.equal(me.queue.estimatedTurnAt, null);
  assert.equal(me.queue.estimateReason, 'missing_duration');
  assert.equal(me.queue.estimateBasis, 'insufficient');
});

test('HTTP start deriva ETA de plannedMinutes; estados no WAITING y reintentos no inventan nueva espera', async t => {
  const f = await fixture(t), session = f.session(), s = f.app.service;
  const z = s.createZone({ name: 'Start de plan', description: '' }).zone.id;
  const r = s.createResource({ zoneId: z, name: 'Plaza', connector: 'TYPE2', powerKw: 22 }).resource.id;
  s.setStatus(r, { status: 'AVAILABLE' });
  const joined = await f.call('/api/queue', { method: 'POST', session, body: { zoneId: z, connector: 'ANY', plannedMinutes: 90 } });
  const qid = joined.body.queue.id;
  assert.equal(joined.body.queue.state, 'OFFERED');
  assert.equal(joined.body.queue.peopleAhead, 0);
  assert.equal(joined.body.queue.estimatedTurnAt, null);
  assert.equal(joined.body.queue.estimateReason, 'not_waiting');
  assert.equal((await f.call(`/api/queue/${qid}/accept`, { method: 'POST', session })).status, 200);
  f.advance(1000);
  const expected = f.state.now + 90 * 60000;
  const start = await f.call(`/api/queue/${qid}/start`, { method: 'POST', session });
  assert.equal(start.status, 200);
  assert.equal(start.body.queue.expectedReleaseAt, expected);
  assert.equal(start.body.queue.plannedMinutes, 90);
  f.advance(30000);
  const retried = await f.call(`/api/queue/${qid}/start`, { method: 'POST', session });
  assert.equal(retried.body.queue.expectedReleaseAt, expected);
  const me = (await f.call('/api/me', { session })).body.queue;
  assert.equal(me.peopleAhead, 0); assert.equal(me.estimatedTurnAt, null);
  assert.equal(me.estimateReason, 'not_waiting');
});
