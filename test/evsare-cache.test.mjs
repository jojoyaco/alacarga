import test from 'node:test';
import assert from 'node:assert/strict';
import { EvsareAccess, EvsareClient } from '../src/evsare.mjs';
import { reauthenticate } from '../src/token-vault.mjs';

const start = '2026-08-03T07:00:00Z';
const end = '2026-08-03T07:30:00Z';
const now = Date.parse('2026-08-03T08:00:00Z');
const ttl = 12 * 60_000;
const row = (id, fints = end) => ({ idRecarga: id, iniciots: start, fints });
const session = (n, userId = 1) => ({ tokenHash: `synthetic-hash-${n}`, user: { id: userId, provider: 'evsare' } });

function fixture(handler) {
  const calls = [];
  const revoked = new Set();
  let time = now;
  const client = new EvsareClient({ fetchImpl: async (url, options) => {
    const { pathname, searchParams, search } = new URL(url);
    const path = pathname + search;
    const token = options.headers['X-IBIL-TOKEN'];
    calls.push(pathname === '/recargas' && !searchParams.has('idTerminal') ? pathname : path);
    if (options.method === 'GET') assert.equal(options.cache, 'no-store');
    const data = await handler(pathname, { path, searchParams, token });
    return data instanceof Response ? data : Response.json(data);
  } });
  const vault = {
    active(s) { if (revoked.has(s.tokenHash)) reauthenticate(); },
    getToken(s) { this.active(s); return `synthetic-token-${s.tokenHash}`; },
    forget(s) { revoked.add(s.tokenHash); },
  };
  return { access: new EvsareAccess(client, vault, () => time), calls, revoked, advance: ms => { time += ms; } };
}

test('display data is projected, cached per session for 12 minutes and replaced only by successful refresh', async () => {
  let version = 1;
  let profileStatus = 200;
  const { access, calls, advance } = fixture((path, { token }) => {
    if (path === '/user/datosusuario') return profileStatus === 200
      ? { nombre: `Name ${version}`, email: `${token.endsWith('-1') ? 'first' : 'second'}@example.invalid`, politicaAceptada: 1, ignored: 'unprojected' }
      : new Response(null, { status: profileStatus });
    if (path === '/user/cards') return { cards: [{ idtarjetarfid: 55, codigotarjetarfid: `TEST000${version}` }] };
    return { recargas: [row(version)], ignored: 'unprojected' };
  });
  const s = session(1);
  const readAll = options => Promise.all([access.profile(s, options), access.rfidCards(s, '9', options), access.recharges(s, options)]);
  const [profile, cards, history] = await readAll();
  assert.deepEqual(profile, { profile: { name: 'Name 1', email: 'first@example.invalid', privacyAccepted: true } });
  assert.deepEqual(cards, { cards: [{ label: 'Tarjeta RFID', ending: '0001' }] });
  assert.equal(history.recharges[0].id, 1);
  assert.equal(Object.hasOwn(history, 'ignored'), false);
  profile.profile.name = 'mutated'; cards.cards[0].ending = 'oops'; history.recharges.length = 0;
  version++;
  advance(ttl - 1);
  const [oldProfile, oldCards, oldHistory] = await readAll();
  assert.equal(oldProfile.profile.name, 'Name 1');
  assert.equal(oldCards.cards[0].ending, '0001');
  assert.equal(oldHistory.recharges[0].id, 1);
  assert.equal(calls.length, 3);
  assert.equal((await access.profile(session(2))).profile.email, 'second@example.invalid'); // Same account, new login.
  advance(1);
  const [nextProfile, nextCards, nextHistory] = await readAll();
  assert.equal(nextProfile.profile.name, 'Name 2');
  assert.equal(nextCards.cards[0].ending, '0002');
  assert.equal(nextHistory.recharges[0].id, 2);
  assert.equal(calls.length, 7);
  profileStatus = 503;
  await assert.rejects(access.profile(s, { fresh: true }), { code: 'EVSARE_UNAVAILABLE' });
  assert.equal((await access.profile(s)).profile.name, 'Name 2');
  profileStatus = 200;
  version++;
  const refreshed = await readAll({ fresh: true });
  assert.equal(refreshed[0].profile.name, 'Name 3');
  assert.equal(refreshed[1].cards[0].ending, '0003');
  assert.equal(refreshed[2].recharges[0].id, 3);
  assert.deepEqual(await readAll(), refreshed);
  assert.equal(calls.length, 11);
});

test('cache hits require a live session and provider token; logout during refresh cannot repopulate its cache', async () => {
  let nextProfile = 'Cached';
  let release;
  const { access, calls, revoked } = fixture(async () => ({ nombre: await nextProfile }));
  const s = session(1);
  await access.profile(s);
  nextProfile = new Promise(resolve => { release = resolve; });
  const refresh = access.profile(s, { fresh: true });
  const joined = access.profile(s, { fresh: true });
  assert.equal((await access.profile(s)).profile.name, 'Cached');
  assert.equal(calls.length, 2);
  revoked.add(s.tokenHash);
  access.invalidateSession(s);
  release('Old request');
  await Promise.all([refresh, joined, access.profile(s)].map(pending => assert.rejects(pending, { code: 'EVSARE_REAUTH_REQUIRED' })));
  assert.equal(calls.length, 2);
  nextProfile = 'Another session';
  assert.equal((await access.profile(session(2))).profile.name, 'Another session');
  revoked.add(session(2).tokenHash);
  await assert.rejects(access.profile(session(2)), { code: 'EVSARE_REAUTH_REQUIRED' });
  assert.equal(calls.length, 3);
});

test('masked cards never stand in for live reveal/charging cards, and reconciliation uses live terminal history and readings', async () => {
  const { access, calls } = fixture((path, { searchParams }) => {
    if (path === '/user/cards') return { cards: searchParams.has('soloActivas')
      ? [{ idtarjetarfid: 999 }]
      : [{ idtarjetarfid: 55, codigotarjetaibil: 'DISPLAY4321', codigotarjetarfid: 'RFID123456789' }] };
    if (path === '/recargas' && searchParams.has('idTerminal')) return { recargas: [{ ...row(42, null), idTerminal: 7 }] };
    if (path === '/recargas') return { recargas: [row(42)] };
    return { isCharging: true, charges: [] };
  });
  const s = session(1);
  assert.deepEqual(await access.rfidCards(s, '9'), { cards: [{ label: 'Tarjeta RFID', ending: '4321' }] });
  await access.rfidCards(s, '9');
  assert.deepEqual(await access.revealRfidCard(s, '9', '4321'), { number: 'RFID123456789' });
  assert.equal(await access.chargeCard(s), 999);
  assert.deepEqual(calls, ['/user/cards', '/user/cards', '/user/cards?soloActivas=true']);
  await access.recharges(s);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await access.terminalChargeEvidence(s, { terminal: 7, earliest: Date.parse(start), latest: now, now }, id => id === 42),
      { state: 'ACTIVE', rechargeId: 42 });
  }
  assert.equal(calls.filter(path => path.includes('idTerminal=7')).length, 2);
  assert.equal(calls.filter(path => path === '/recargas/lecturas/42').length, 2);
});

test('finalized curves skip only the readings call, with fresh ownership and token checks even on cache hits', async () => {
  let history = [row(42)];
  let lecture = 1000;
  let ownershipStatus = 200;
  const { access, calls, revoked, advance } = fixture(path => path === '/recargas'
    ? ownershipStatus === 200 ? { recargas: history } : new Response(null, { status: ownershipStatus })
    : { charging: false, charges: [{ date: Date.parse(start), lecture, ignored: 999 }] });
  const s = session(1);
  const readings = '/recargas/lecturas/42';
  const expected = kwh => ({ points: [{ time: Date.parse(start), energyKwh: kwh }] });
  await access.recharges(s);
  const first = await access.rechargeCurve(s, 42);
  assert.deepEqual(first, expected(1));
  first.points.length = 0;
  lecture++;
  assert.deepEqual(await access.rechargeCurve(s, 42), expected(1));
  assert.deepEqual(calls, ['/recargas', '/recargas', readings, '/recargas']);
  assert.deepEqual(await access.rechargeCurve(s, 42, { fresh: true }), expected(1.001));
  assert.deepEqual(await access.rechargeCurve(session(2), 42), expected(1.001));
  advance(ttl);
  lecture++;
  assert.deepEqual(await access.rechargeCurve(s, 42), expected(1.002));
  assert.equal(calls.filter(path => path === readings).length, 4);
  history = [];
  await assert.rejects(access.rechargeCurve(s, 42), { code: 'EVSARE_RECHARGE_NOT_FOUND' });
  assert.equal(calls.at(-1), '/recargas');
  history = [row(42)];
  ownershipStatus = 503;
  await assert.rejects(access.rechargeCurve(session(2), 42), { code: 'EVSARE_UNAVAILABLE' });
  revoked.add(session(2).tokenHash);
  const count = calls.length;
  await assert.rejects(access.rechargeCurve(session(2), 42), { code: 'EVSARE_REAUTH_REQUIRED' });
  assert.equal(calls.length, count);
});

test('no readings cache for open, malformed, contradictory, future, or empty curves', async () => {
  const point = { date: Date.parse(start), lecture: 1 };
  const cases = [
    [row(42, null), { charges: [point] }],
    [row(42, '2026-02-31T07:30:00Z'), { charges: [point] }],
    [row(42, '2026-08-03T08:01:00Z'), { charges: [point] }],
    [row(42), { charging: false, isCharging: true, charges: [point] }],
    [row(42), { charging: 'false', charges: [point] }],
    [row(42), { charging: false, charges: [] }],
  ];
  for (const [history, curve] of cases) {
    const { access, calls } = fixture(path => path === '/recargas' ? { recargas: [history] } : curve);
    await access.rechargeCurve(session(1), 42);
    await access.rechargeCurve(session(1), 42);
    assert.deepEqual(calls, ['/recargas', '/recargas/lecturas/42', '/recargas', '/recargas/lecturas/42']);
  }
});

test('cache evicts least-recently-used sessions and curves at their bounds', async () => {
  let id = 1;
  const { access, calls } = fixture(path => path === '/user/datosusuario' ? { nombre: 'Cached' }
    : path === '/recargas' ? { recargas: [row(id)] } : { charges: [{ date: Date.parse(start), lecture: 1 }] });
  for (let i = 1; i <= 64; i++) await access.profile(session(i));
  await access.profile(session(1)); // Keep the first session; adding another evicts the second.
  await access.profile(session(65));
  await access.profile(session(1));
  await access.profile(session(2));
  assert.equal(calls.length, 66);
  const s = session(100);
  for (; id <= 20; id++) await access.rechargeCurve(s, id);
  id = 1;
  await access.rechargeCurve(s, id);
  id = 21;
  await access.rechargeCurve(s, id);
  id = 1;
  await access.rechargeCurve(s, id);
  id = 2;
  await access.rechargeCurve(s, id);
  assert.equal(calls.filter(path => path === '/recargas/lecturas/1').length, 1);
  assert.equal(calls.filter(path => path === '/recargas/lecturas/2').length, 2);
});
