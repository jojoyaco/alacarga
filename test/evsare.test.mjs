import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication } from '../src/http.mjs';
import { temporary, testConfig } from './helpers.mjs';

const PASSWORD = 'short synthetic password';
const TOKEN = 'synthetic-evsare-token-never-public';
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const login = (userId = 73, token = TOKEN) => ({ valid: true, changePassword: false, token, tokenexp: 123, user: { userId, firstName: 'Cuenta de prueba', emailAddress: 'person@example.test', userRoles: [{ name: 'ADMIN' }], password: PASSWORD } });

async function fixture(t, responder = () => response(login())) {
  const directory = temporary(t), config = testConfig(directory), calls = [], logs = [];
  let now = 1800000000000;
  const f = { config, calls, logs, responder, advance: ms => { now += ms; } };
  const start = async () => {
    f.app = createApplication({ config, clock: () => now, sendPush: null, log: code => logs.push(code), evsareFetch: async (url, init) => {
      const call = { url: String(url), ...init }; calls.push(call); return f.responder(call);
    } });
    await new Promise(resolve => f.app.server.listen(0, '127.0.0.1', resolve));
    f.base = `http://127.0.0.1:${f.app.server.address().port}`;
  };
  await start();
  t.after(() => f.app.close());
  f.restart = async () => { await f.app.close(); await start(); };
  f.call = async (path, { body, session, headers = {} } = {}) => {
    const res = await fetch(f.base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json', origin: config.origin }),
      ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}), ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  f.signin = async (username = 'person+tag@example.test', password = PASSWORD) => {
    const r = await f.call('/api/login', { body: { username, password } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { ...r, cookie: r.headers.get('set-cookie').split(';')[0], csrfToken: r.body.csrfToken };
  };
  return f;
}

test('EVsare login acepta correo/contraseña corta exacta, contrato oficial y roles locales aislados', async t => {
  const f = await fixture(t);
  const signed = await f.signin('person+tag@example.test', ' x ');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://appkbs.ibilcloud.com/user/login2');
  assert.equal(f.calls[0].method, 'POST'); assert.equal(f.calls[0].redirect, 'error');
  assert.deepEqual(JSON.parse(f.calls[0].body), { idUsuario: 'person+tag@example.test', password: ' x ', idsubop: 1 });
  assert.equal(f.calls[0].headers['Ibil-Language'], 'es');
  assert.equal(f.calls[0].headers['X-IBIL-TOKEN'], undefined);
  assert.equal(signed.body.user.role, 'user'); assert.equal(signed.body.user.provider, 'evsare');
  assert.match(signed.headers.get('set-cookie'), /HttpOnly.*Secure/);
  assert.doesNotMatch(JSON.stringify(signed.body), /synthetic-evsare-token|userRoles|password|tokenexp/);
  assert.equal((await f.call('/api/admin/zones', { body: { name: 'Denied' }, session: signed })).status, 403);
});

test('EVsare identidad estable por userId, sin enlazar por correo ni usuario local', async t => {
  const f = await fixture(t);
  f.app.db.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES ('person@example.test','local','admin',1)").run();
  const a = await f.signin(), b = await f.signin('other-name@example.test');
  assert.equal(a.body.user.id, b.body.user.id); assert.notEqual(a.body.user.id, 1);
  f.responder = () => response(login(74, 'synthetic-second-token'));
  const c = await f.signin();
  assert.notEqual(c.body.user.id, a.body.user.id);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM users').get().n, 3);
  assert.equal((await f.call('/api/register', { body: { username: 'someone', password: PASSWORD } })).status, 410);
});

test('EVsare secretos cifrados por sesión, reinicio conserva acceso, no guarda contraseña/perfil completo', async t => {
  const f = await fixture(t);
  const a = await f.signin();
  const data = f.app.db.prepare('SELECT * FROM provider_sessions').all();
  assert.equal(data.length, 1); assert.doesNotMatch(JSON.stringify(data), new RegExp(`${TOKEN}|${PASSWORD}`));
  assert.equal(statSync(join(f.config.dataDir, 'evsare-token.key')).mode & 0o777, 0o600);
  for (const file of readdirSync(f.config.dataDir).filter(x => /sqlite/.test(x))) {
    const bytes = readFileSync(join(f.config.dataDir, file));
    assert.equal(bytes.includes(Buffer.from(TOKEN)), false); assert.equal(bytes.includes(Buffer.from(PASSWORD)), false);
  }
  await f.restart();
  f.responder = call => {
    assert.equal(call.headers['X-IBIL-TOKEN'], TOKEN);
    return response({ nombre: 'Nombre', email: 'person@example.test', politicaAceptada: 1, nif: 'private-tax-id', direccion: 'private-address', token: TOKEN });
  };
  const r = await f.call('/api/evsare/profile', { session: a });
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(r.body, { profile: { name: 'Nombre', email: 'person@example.test', privacyAccepted: true } });
  await f.call('/api/logout', { body: {}, session: a });
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM provider_sessions').get().n, 0);
  assert.equal((await f.call('/api/evsare/profile', { session: a })).status, 401);
});

test('EVsare renovación en 401 una sola vez, token nuevo solo en servidor', async t => {
  const f = await fixture(t), a = await f.signin();
  let renews = 0;
  f.responder = call => {
    if (call.url.endsWith('/renewtoken')) { renews++; assert.equal(call.method, 'POST'); return response({ token: 'synthetic-renewed', tokenexp: 999 }); }
    return call.headers['X-IBIL-TOKEN'] === TOKEN ? response({}, 401) : response({ nombre: 'Nombre' });
  };
  const results = await Promise.all([f.call('/api/evsare/profile', { session: a }), f.call('/api/evsare/profile', { session: a })]);
  assert.ok(results.every(r => r.status === 200)); assert.equal(renews, 1);
  assert.doesNotMatch(JSON.stringify(results.map(r => r.body)), /synthetic-renewed/);
});

test('histórico IBILSARE convierte consumo a kWh sin inferir moneda ni completar datos ausentes', async t => {
  const f = await fixture(t), a = await f.signin();
  const startedAt = '2026-11-21T09:00:00Z', endedAt = '2026-11-21T09:30:00Z';
  const row = (idRecarga, consumo, importe, fints = endedAt) => ({ idRecarga, consumo, importe, fints,
    iniciots: startedAt, idEmplazamiento: 1, idTerminal: 2, privateCard: 'never-projected' });
  f.responder = call => {
    const url = new URL(call.url);
    assert.equal(call.method, 'GET');
    assert.equal(url.pathname, '/recargas');
    assert.equal(url.searchParams.get('broker_interop'), 'IBILSARE');
    assert.equal(url.searchParams.get('todosUsuarios'), 'false');
    assert.equal(url.searchParams.get('rowsLimit'), '20');
    return response({ emplazamiento: { 1: 'Sitio' }, terminal: { 2: 'Terminal' }, recharges: [{ id: 'another-broker', energy: 600 }],
      recargas: [row(1, 12345, 6.25), row(2, 0, 0), row(3, '1200', '6.25'), row(4, -1),
        row(5, null), row(6, 2.5), row(7, 2147483648), row(8, 650, 4, null)] });
  };
  const history = await f.call('/api/evsare/recharges', { session: a });
  assert.equal(history.status, 200);
  const fields = { siteName: 'Sitio', terminalName: 'Terminal', startedAt };
  assert.deepEqual(history.body, { source: 'evsare', scope: 'own-IBILSARE', limit: 20, coverage: 'partial', unitsVerified: false,
    recharges: [
      { ...fields, id: 1, endedAt, energyKwh: 12.345, reportedCost: 6.25 },
      { ...fields, id: 2, endedAt, energyKwh: 0, reportedCost: 0 },
      ...[3, 4, 5, 6, 7].map(id => ({ ...fields, id, endedAt })),
      { ...fields, id: 8, endedAt: null },
    ] });
});

test('EVsare sesión rechazada requiere reautenticación sin loops ni borrar cola propia', async t => {
  const f = await fixture(t), a = await f.signin();
  f.responder = () => response({ secret: TOKEN }, 401);
  const r = await f.call('/api/evsare/profile', { session: a });
  assert.equal(r.status, 401); assert.equal(r.body.code, 'EVSARE_REAUTH_REQUIRED');
  assert.equal(f.calls.length, 3); // login, perfil, renovación fallida
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM provider_sessions').get().n, 0);
  assert.equal((await f.call('/api/session', { session: a })).body.user.id, a.body.user.id);
  assert.equal((await f.call('/api/evsare/profile', { session: a })).status, 401);
  assert.equal(f.calls.length, 3);
});

test('EVsare errores saneados, changePassword y formas inválidas no crean usuarios ni sesiones', async t => {
  for (const [body, status, code] of [
    [{ valid: false }, 200, 'INVALID_CREDENTIALS'],
    [{ ...login(), changePassword: true }, 200, 'EVSARE_ACTION_REQUIRED'],
    [{ ...login(), user: { emailAddress: 'person@example.test' } }, 200, 'EVSARE_BAD_RESPONSE'],
    [{ ...login(), token: 'bad\r\nheader' }, 200, 'EVSARE_BAD_RESPONSE'],
    [{ secret: TOKEN, password: PASSWORD }, 500, 'EVSARE_UNAVAILABLE'],
    [{ secret: TOKEN }, 403, 'EVSARE_FORBIDDEN'],
  ]) {
    const f = await fixture(t, () => response(body, status));
    const r = await f.call('/api/login', { body: { username: 'person@example.test', password: PASSWORD } });
    assert.equal(r.body.code, code); assert.ok(r.status >= 400);
    assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
    assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
    assert.doesNotMatch(JSON.stringify([r.body, f.logs]), new RegExp(`${TOKEN}|${PASSWORD}`));
  }
});

test('EVsare aislamiento de tokens entre cuentas, expiración y rutas cerradas', async t => {
  const f = await fixture(t), a = await f.signin();
  f.responder = () => response(login(74, 'synthetic-token-b'));
  const b = await f.signin();
  f.responder = call => response({ nombre: call.headers['X-IBIL-TOKEN'] === TOKEN ? 'A' : 'B' });
  assert.equal((await f.call('/api/evsare/profile', { session: a })).body.profile.name, 'A');
  assert.equal((await f.call('/api/evsare/profile', { session: b })).body.profile.name, 'B');
  const n = f.calls.length;
  for (const path of ['/api/evsare/proxy?url=https://evil.test', '/api/evsare/user/delete', '/api/evsare/recargas/iniciarrecarga']) assert.equal((await f.call(path, { session: a })).status, 404);
  assert.equal(f.calls.length, n);
  f.advance(f.config.sessionSeconds * 1000);
  assert.equal((await f.call('/api/evsare/profile', { session: a })).status, 401);
  assert.equal(f.calls.length, n);
});
