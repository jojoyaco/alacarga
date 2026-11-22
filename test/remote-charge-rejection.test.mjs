import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../src/http.mjs';
import { openDatabase } from '../src/db.mjs';
import { EvsareClient } from '../src/evsare.mjs';
import { temporary, testConfig } from './helpers.mjs';

const statusPath = '/api/evsare/start-charge/status';
const startPath = '/api/evsare/start-charge';
const checkPath = `${startPath}/check`, releasePath = `${startPath}/release`, finishPath = `${startPath}/finish`;
const startedAt = 1800000000000;
const iso = offset => new Date(startedAt + offset).toISOString();
const recharge = (extra = {}) => ({ idRecarga: 42, idTerminal: 99, iniciots: iso(0), fints: null, ...extra });
const ambiguous = { state: 'AMBIGUOUS' };
const refusal = () => Response.json({ iniciada: false, motivoRechazo: 7, sessionid: null }, { status: 201 });

async function preview(t) {
  let now = startedAt;
  const clock = () => now;
  const terminal = { id: 't99', name: 'Prueba', state: 'AVAILABLE', remoteCompatible: true, tariffSegments: [],
    connectors: [{ id: 7, label: 'A', name: 'Tipo 2', kind: 'TYPE2', power: 22, state: 'AVAILABLE', chargeAvailable: true }] };
  const sites = [{ id: 'e1', name: 'Sitio de prueba', terminals: [terminal] }];
  const catalog = { sites, observedAt: clock(), fresh: () => true, refresh: async () => {}, allows: () => true,
    terminals: new Map([[terminal.id, terminal]]), view: () => ({ status: 'fresh', sites }) };
  const config = testConfig(temporary(t), { remoteCharge: true, remoteChargeTargets: new Set(['e1:t99:7']) });
  const mock = { start: refusal, profile: () => Response.json({ nombre: 'Test' }), renew: () => Response.json({}, { status: 401 }) };
  mock.history = () => Response.json({ recargas: [] });
  mock.curve = () => Response.json({ charging: true, charges: [] });
  mock.finish = () => Response.json('synthetic acknowledgment');
  const paths = [];
  const app = createApplication({ config, clock, catalog, sendPush: null, evsareFetch: async (url, req) => {
    const { pathname, search } = new URL(url);
    paths.push(pathname);
    if (pathname === '/user/login2') return Response.json({ valid: true, user: { userId: Number(JSON.parse(req.body).idUsuario) }, token: 'test-only-token' });
    if (pathname === '/user/cards' && search === '?soloActivas=true') return Response.json({ cards: [{ idtarjetarfid: 123 }] });
    if (pathname === '/recargas/iniciarrecarga') return mock.start();
    if (pathname === '/recargas') {
      assert.equal(search, '?broker_interop=IBILSARE&todosUsuarios=false&descripcionesLocalizacion=false&rowsLimit=20&rowsOffset=0&idTerminal=99');
      assert.equal(req.method, 'GET');
      assert.equal(req.headers['X-IBIL-TOKEN'], 'test-only-token');
      return mock.history();
    }
    if (pathname === '/recargas/lecturas/42') return mock.curve();
    if (pathname === '/recargas/finalizarrecarga/42') {
      assert.equal(search, '');
      assert.equal(req.method, 'GET');
      assert.equal(req.redirect, 'error');
      assert.equal(req.headers['X-IBIL-TOKEN'], 'test-only-token');
      assert.equal(req.body, undefined);
      return mock.finish();
    }
    if (pathname === '/user/datosusuario') return mock.profile();
    if (pathname === '/user/renewtoken') return mock.renew();
    throw new Error('Unexpected mock route');
  } });
  t.after(() => app.close());
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, session, body) => {
    const headers = session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {};
    const response = await fetch(base + path, { headers: body ? { ...headers, origin: config.origin, 'content-type': 'application/json' } : headers,
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async (subject = 42) => {
    const response = await call('/api/login', null, { username: String(subject), password: 'synthetic-test-only' });
    assert.equal(response.status, 200);
    return { cookie: response.cookie, csrfToken: response.body.csrfToken };
  };
  const member = await login();
  const { zoneId } = (await call('/api/evsare/chargers', member)).body.sites[0];
  const body = { zoneId, terminalId: terminal.id, connectorId: 7 };
  return { app, call, paths, mock, member, login, start: session => call(startPath, session ?? member, body),
    advance: ms => { now += ms; catalog.observedAt = now; },
    check: () => call(checkPath, member),
    finish: (id = 42) => call(finishPath, member, { rechargeId: id }) };
}

test('an explicit documented EVsare rejection is recorded without retry or exclusion of a later start', async t => {
  const { app, mock, paths, start, call, member, check } = await preview(t);
  mock.start = () => {
    assert.equal(app.db.prepare('SELECT status FROM remote_charge_attempts').get().status, 'UNCONFIRMED');
    return refusal();
  };
  const result = await start();
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'REMOTE_CHARGE_REJECTED');
  assert.deepEqual((await call(statusPath, member)).body, { status: 'REJECTED' });
  assert.deepEqual((await check()).body, { state: 'NOT_FOUND' });
  assert.ok(!paths.includes('/recargas'));
  assert.equal(paths.filter(path => path === '/recargas/iniciarrecarga').length, 1);
  assert.doesNotMatch(JSON.stringify(result.body), /motivoRechazo|sessionid|test-only-token/);
  mock.start = () => Response.json({ iniciada: true, sessionid: 'test-only-session' }, { status: 201 });
  assert.deepEqual((await start()).body, { started: true });
  assert.deepEqual((await call(statusPath, member)).body, { status: 'ACCEPTED' });
  assert.deepEqual(app.db.prepare('SELECT status FROM remote_charge_attempts ORDER BY sequence').all().map(x => x.status), ['REJECTED', 'ACCEPTED']);
});

test('uncertain upstream outcomes are recorded and never cause an automatic retry', async t => {
  for (const [label, reply] of [
    ['non-201 with rejection fields', () => Response.json({ iniciada: false, motivoRechazo: 7 }, { status: 400 })],
    ['401', () => Response.json({ iniciada: false, motivoRechazo: 7 }, { status: 401 })],
    ['malformed JSON', () => new Response('{', { status: 201, headers: { 'content-type': 'application/json' } })],
    ['no rejection detail', () => Response.json({ iniciada: false }, { status: 201 })],
    ['non-boolean start field', () => Response.json({ iniciada: 'false', motivoRechazo: 7 }, { status: 201 })],
    ['contradictory session ID', () => Response.json({ iniciada: false, motivoRechazo: 7, sessionid: 'test-only-session' }, { status: 201 })],
    ['transport failure', () => { throw new Error('test-only-transport'); }],
  ]) await t.test(label, async t => {
    const { app, mock, paths, start } = await preview(t);
    mock.start = reply;
    assert.equal((await start()).body.code, 'REMOTE_CHARGE_UNCONFIRMED');
    assert.equal(app.db.prepare('SELECT status FROM remote_charge_attempts').get().status, 'UNCONFIRMED');
    assert.equal(paths.filter(path => path === '/recargas/iniciarrecarga').length, 1);
    assert.ok(!paths.includes('/user/renewtoken'));
    mock.start = refusal;
    assert.equal((await start()).body.code, 'REMOTE_CHARGE_REJECTED');
    assert.equal(paths.filter(path => path === '/recargas/iniciarrecarga').length, 2);
  });
});

test('only the local EVsare account can see its own persisted status; token invalidation and relogin do not clear it', async t => {
  const { app, call, paths, start, login, mock, member } = await preview(t);
  assert.equal((await call(statusPath)).status, 401);
  assert.deepEqual((await call(statusPath, member)).body, { status: null });
  mock.start = () => Response.json({}, { status: 503 });
  assert.equal((await start()).body.code, 'REMOTE_CHARGE_UNCONFIRMED');
  const other = await login(43);
  const before = paths.length;
  assert.deepEqual((await call(statusPath, other)).body, { status: null });
  const status = await call(statusPath, member);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.deepEqual(status.body, { status: 'UNCONFIRMED' });
  assert.equal(paths.length, before);
  mock.profile = () => Response.json({}, { status: 401 });
  assert.equal((await call('/api/evsare/profile', member)).body.code, 'EVSARE_REAUTH_REQUIRED');
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM provider_sessions').get().n, 1);
  assert.equal((await call(statusPath, member)).body.status, 'UNCONFIRMED');
  const relogin = await login();
  assert.equal((await call(statusPath, relogin)).body.status, 'UNCONFIRMED');
  mock.start = refusal;
  assert.equal((await start(relogin)).body.code, 'REMOTE_CHARGE_REJECTED');
});

test('check reports own latest order without mutating start eligibility, and the obsolete release route is gone', async t => {
  const f = await preview(t);
  assert.equal((await f.call(checkPath)).status, 401);
  assert.deepEqual((await f.check()).body, { state: 'NONE' });
  f.mock.start = () => Response.json({}, { status: 503 });
  await f.start();
  f.advance(119999);
  assert.deepEqual((await f.check()).body, { state: 'NOT_FOUND' });
  f.advance(1);
  assert.deepEqual((await f.check()).body, { state: 'NOT_FOUND' });
  assert.equal((await f.call(statusPath, f.member)).body.status, 'UNCONFIRMED');
  const removed = await f.call(releasePath, f.member, { confirmed: true });
  assert.equal(removed.status, 404);
  assert.equal(removed.body.code, 'NOT_FOUND');
  const other = await f.login(43);
  const before = f.paths.length;
  assert.deepEqual((await f.call(checkPath, other)).body, { state: 'NONE' });
  assert.equal((await f.call(finishPath, other, { rechargeId: 42 })).body.code, 'REMOTE_CHARGE_FINISH_BLOCKED');
  assert.equal((await f.call(`${checkPath}?idTerminal=42`, f.member)).status, 400);
  assert.equal(f.paths.length, before);
  f.mock.history = () => Response.json({}, { status: 503 });
  assert.deepEqual((await f.check()).body, ambiguous);
  f.mock.start = refusal;
  assert.equal((await f.start()).body.code, 'REMOTE_CHARGE_REJECTED');
});

test('terminal/time corroboration, bounded history and explicit positive activity evidence veto unsafe finish', async t => {
  const f = await preview(t);
  f.mock.start = () => Response.json({ iniciada: true }, { status: 201 });
  await f.start();
  f.advance(180000);
  for (const rows of [
    [recharge({ idTerminal: 100 })], [recharge({ idTerminal: undefined })], [recharge({ iniciots: iso(-1001) })],
    [recharge({ iniciots: iso(120001) })], [recharge({ idRecarga: 2147483648 })], [recharge({ fints: iso(-1000) })],
    [recharge(), recharge({ idRecarga: 43 })], Array.from({ length: 20 }, () => recharge()),
  ]) {
    const before = f.paths.length;
    f.mock.history = () => Response.json({ recargas: rows });
    assert.deepEqual((await f.check()).body, ambiguous);
    assert.deepEqual(f.paths.slice(before), ['/recargas']);
  }
  f.mock.history = () => Response.json({ recargas: [recharge()] });
  for (const curve of [{ charges: [] }, { charging: false }, { charging: 'true' }, { charging: true, isCharging: false }]) {
    f.mock.curve = () => Response.json(curve);
    assert.equal((await f.finish()).body.code, 'REMOTE_CHARGE_FINISH_BLOCKED');
  }
  f.mock.history = () => Response.json({ recargas: [] });
  assert.deepEqual((await f.check()).body, ambiguous);
  assert.equal((await f.finish()).body.code, 'REMOTE_CHARGE_FINISH_BLOCKED');
  assert.ok(!f.paths.some(path => path.includes('finalizarrecarga')));
});

test('finish rechecks fresh evidence, matches exact ID only, and concurrent requests commit just one dispatch', async t => {
  const f = await preview(t);
  f.mock.start = () => Response.json({ iniciada: true }, { status: 201 });
  await f.start();
  f.advance(60000);
  f.mock.history = () => Response.json({ recargas: [recharge()] });
  f.mock.curve = () => Response.json({ isCharging: true });
  assert.deepEqual((await f.check()).body, { state: 'ACTIVE', rechargeId: 42 });
  assert.equal((await f.finish(43)).body.code, 'REMOTE_CHARGE_FINISH_BLOCKED');
  assert.equal((await f.finish('42')).body.code, 'REMOTE_CHARGE_INVALID_RECHARGE');
  f.mock.curve = () => Response.json({ isCharging: false });
  assert.equal((await f.finish()).body.code, 'REMOTE_CHARGE_FINISH_BLOCKED');
  f.mock.curve = () => Response.json({ isCharging: true });
  f.mock.finish = () => {
    assert.equal(f.app.db.prepare('SELECT finish_requested_at FROM remote_charge_lifecycle').get().finish_requested_at, startedAt + 60000);
    return Response.json('request received');
  };
  const results = await Promise.all([f.finish(), f.finish()]);
  assert.deepEqual(results.map(x => x.status).sort(), [200, 409]);
  assert.deepEqual(results.find(x => x.status === 200).body, { submitted: true });
  assert.equal(f.paths.filter(path => path.includes('finalizarrecarga')).length, 1);
  assert.deepEqual((await f.check()).body, { state: 'ACTIVE' });
  f.mock.history = () => Response.json({ recargas: [recharge({ fints: iso(30000) })] });
  assert.deepEqual((await f.check()).body, { state: 'FINISHED', rechargeId: 42 });
  assert.equal(f.app.db.prepare('SELECT finished_seen FROM remote_charge_lifecycle').get().finished_seen, 1);
});

test('a finish in flight excludes starts for the same terminal as well as another finish', async t => {
  const f = await preview(t);
  const other = await f.login(43);
  f.mock.start = () => Response.json({ iniciada: true }, { status: 201 });
  assert.deepEqual((await f.start()).body, { started: true });
  f.mock.history = () => Response.json({ recargas: [recharge()] });
  const entered = Promise.withResolvers(), unblock = Promise.withResolvers();
  f.mock.finish = async () => {
    entered.resolve();
    await unblock.promise;
    return Response.json('request received');
  };
  const finishing = f.finish();
  try {
    await entered.promise;
    assert.equal((await f.start(other)).body.code, 'REMOTE_CHARGE_IN_PROGRESS');
    assert.equal((await f.finish()).body.code, 'REMOTE_CHARGE_IN_PROGRESS');
    assert.equal(f.paths.filter(path => path === '/user/cards').length, 1);
  } finally { unblock.resolve(); }
  assert.deepEqual((await finishing).body, { submitted: true });
  assert.deepEqual((await f.start(other)).body, { started: true });
});

test('v8 migration preserves exact attempt identity, finish evidence, and released history without old exclusivity', t => {
  const dir = temporary(t);
  const old = openDatabase(dir);
  old.exec(`DROP TABLE remote_charge_attempts;
    CREATE TABLE remote_charge_attempts (
      terminal_key TEXT PRIMARY KEY NOT NULL, user_id INTEGER NOT NULL UNIQUE, connector_id INTEGER NOT NULL,
      started_at INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('UNCONFIRMED','ACCEPTED'))
    ) STRICT;
    INSERT INTO remote_charge_attempts(rowid,terminal_key,user_id,connector_id,started_at,status)
      VALUES (9007199254740993,'t99',42,7,1000,'UNCONFIRMED');
    INSERT INTO remote_charge_lifecycle(attempt_id,user_id,terminal_key,started_at,recharge_id,finish_requested_at)
      VALUES (9007199254740993,42,'t99',1000,42,2000);
    INSERT INTO remote_charge_lifecycle(attempt_id,user_id,terminal_key,started_at,released_at,release_reason)
      VALUES (1,42,'t99',500,900,'USER_CONFIRMED_NO_MATCH');
    PRAGMA user_version=8;`);
  old.close();
  const db = openDatabase(dir);
  t.after(() => db.close());
  assert.deepEqual({ ...db.prepare(`SELECT CAST(a.attempt_id AS TEXT) AS id,a.status,l.recharge_id,l.finish_requested_at
    FROM remote_charge_attempts a JOIN remote_charge_lifecycle l USING(attempt_id)`).get() },
  { id: '9007199254740993', status: 'UNCONFIRMED', recharge_id: 42, finish_requested_at: 2000 });
  assert.equal(db.prepare('SELECT release_reason FROM remote_charge_lifecycle WHERE attempt_id=1').get().release_reason, 'USER_CONFIRMED_NO_MATCH');
  db.exec(`INSERT INTO remote_charge_attempts(attempt_id,terminal_key,user_id,connector_id,started_at,status)
    VALUES (2,'t99',42,7,1000,'REJECTED'), (3,'t99',43,7,1000,'ACCEPTED');`);
  assert.equal(db.prepare('SELECT status FROM remote_charge_attempts WHERE user_id=42 ORDER BY sequence DESC LIMIT 1').get().status, 'REJECTED');
});

test('a finish HTTP 401 or redirect is uncertain, leaves a durable marker, and never renews or retries', async t => {
  for (const [label, reply] of [['401', () => Response.json({}, { status: 401 })], ['redirect', () => Response.redirect('https://invalid.test', 302)],
    ['network error', () => { throw new Error('mock transport error'); }]]) await t.test(label, async t => {
    const f = await preview(t);
    f.mock.start = () => Response.json({}, { status: 503 });
    await f.start();
    f.mock.history = () => Response.json({ recargas: [recharge()] });
    f.mock.finish = reply;
    assert.equal((await f.finish()).body.code, 'REMOTE_CHARGE_FINISH_UNCONFIRMED');
    const reopened = openDatabase(f.app.config.dataDir);
    try { assert.equal(reopened.prepare('SELECT finish_requested_at FROM remote_charge_lifecycle').get().finish_requested_at, startedAt); }
    finally { reopened.close(); }
    assert.equal((await f.finish()).body.code, 'REMOTE_CHARGE_FINISH_BLOCKED');
    f.mock.start = () => Response.json({ iniciada: true }, { status: 201 });
    // A new order is permitted, but the same recharge ID cannot be rebound and finished again.
    assert.deepEqual((await f.start()).body, { started: true });
    assert.deepEqual((await f.check()).body, ambiguous);
    assert.equal((await f.finish()).body.code, 'REMOTE_CHARGE_FINISH_BLOCKED');
    assert.ok(!f.paths.includes('/user/renewtoken'));
    assert.equal(f.paths.filter(path => path.includes('finalizarrecarga')).length, 1);
  });
});

test('upstream finish cannot use generic request, and terminal history accepts only the fixed own-scope query', async () => {
  const client = new EvsareClient({ fetchImpl: async () => assert.fail('unsafe route dispatched') });
  for (const path of ['/recargas/finalizarrecarga/42', '/recargas/finalizarrecarga/42?broker_interop=IBILSARE',
    '/recargas?broker_interop=IBILSARE&todosUsuarios=true&descripcionesLocalizacion=false&rowsLimit=20&rowsOffset=0&idTerminal=99',
    '/recargas?broker_interop=IBILSARE&todosUsuarios=false&descripcionesLocalizacion=false&rowsLimit=20&rowsOffset=0&idTerminal=2147483648',
    '/recargas?broker_interop=IBILSARE&todosUsuarios=false&descripcionesLocalizacion=false&rowsLimit=20&rowsOffset=0&idTerminal=99&rowsOffset=100']) {
    await assert.rejects(client.request(path, { token: 'mock', beforeSend: () => {} }), { code: 'EVSARE_ROUTE_UNSUPPORTED' });
  }
});
