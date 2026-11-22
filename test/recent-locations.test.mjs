import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

// Keep the browser cache in app.js so no new static asset needs allowlisting.
// Evaluate the actual session/recharge/scoring handlers with a minimal browser stub.
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function section(from, to) {
  const start = app.indexOf(from), end = app.indexOf(to, start + from.length);
  assert(start >= 0 && end > start, `missing app.js section: ${from}`);
  return app.slice(start, end);
}
const functions = [
  section('function identityKey(', 'function isEVsareError('),
  section('function applySession(', 'async function readSnapshot('),
  section('async function loadEVsareData(', 'async function loadEVsareAccount('),
  section('const normalizeSiteText', 'function chargerSiteItem('),
].join('\n');
const end = '2026-11-21T10:00:00Z';
const now = Date.parse('2026-11-22T12:00:00Z');
const owner = { user: { id: 1, provider: 'evsare', username: 'private-account', role: 'user' }, csrfToken: 'fixture-csrf-a' };
const loggedOut = { user: null, csrfToken: null };
const older = { name: 'Ría Norte' };
const newest = { name: 'La Plaza' };
const charge = (id, siteName, endedAt = end) => ({ id, siteName, endedAt, startedAt: '2026-11-21T09:00:00Z', terminalName: 'private-terminal', costEur: 199 });

function browser({ storage = new Map(), session = owner, start = now, sites = [older, newest] } = {}) {
  const state = { ...loggedOut, sessionKnown: false, evsareRecharges: { status: 'idle' } };
  let clock = start, onExpiry, storeWrite;
  const context = createContext({
    state, AUTH_MODES: [], accountRevision: 0, chargers: { data: { sites } },
    Date: class extends Date { static now() { return clock; } },
    crypto: globalThis.crypto, TextEncoder,
    sessionStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); storeWrite?.(v); }, removeItem: k => storage.delete(k) },
    setTimeout: fn => { onExpiry = fn; return 1; }, clearTimeout: () => { onExpiry = null; },
    dataFresh: () => true, serverNow: () => clock, render: () => {}, hideFeedback: () => {}, text: () => {},
    renderEVsareAccount: () => {}, renderChargerResults: () => {}, refresh: () => {},
    resetEVsareAccount: () => { context.accountRevision++; state.evsareRecharges = { status: 'idle' }; },
    byId: () => ({ reset() {}, replaceChildren() {}, dataset: {}, open: false }), adminNodes: new Map(), formMessage: () => {},
    notificationSignature: '', lastAnnouncement: '', lastExpiryRefresh: '',
    readEVsareData: (_kind, value) => value, ApiError: Error, evsareErrorMessage: error => error.message, needsOfficialAction: () => false,
  });
  context.api = async path => { assert.equal(path, '/api/session'); return session; };
  runInContext(functions, context);
  const apply = value => context.applySession(value);
  apply(session);
  return {
    state, storage, apply, context,
    nextWrite: () => new Promise(resolve => { storeWrite = resolve; }),
    scores: () => [...context.chargerUseScores().recent].map(site => site.name),
    expire: duration => { clock += duration; onExpiry?.(); },
    load(fetchHistory) {
      context.api = path => path === '/api/session' ? Promise.resolve(session) : fetchHistory(path);
      return context.loadEVsareData('recharges');
    },
  };
}

async function seed(b = browser()) {
  const saved = b.nextWrite();
  await b.load(async path => {
    assert.equal(path, '/api/evsare/recharges');
    return [charge(3211, ' RÍA   Norte '), charge(3211, 'Ría Norte'), charge(4444, 'Ría Norte'), charge(5555, 'La Plaza', '2026-11-21T12:00:00Z'),
      charge(7777, 'ongoing', null), charge(8888, 'future', '2026-11-23T10:00:00Z'), charge(9999, 'reversed', '2026-11-21T08:00:00Z')];
  });
  return { b, raw: await saved };
}

test('stores only aggregate location summaries from finalized recargas', async () => {
  const { raw, b } = await seed();
  const { payload, tag } = JSON.parse(raw);
  assert.deepEqual(payload, [now, [['ria norte', 2, Date.parse(end)], ['la plaza', 1, Date.parse('2026-11-21T12:00:00Z')]]]);
  assert.match(tag, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(raw, /private-|fixture-csrf|3211|terminalName|costEur|startedAt/);
  assert.deepEqual(b.scores(), ['La Plaza', 'Ría Norte']);
});

test('restores only after session verification, revalidates in the background, and replaces on empty success', async () => {
  const { b } = await seed();
  const reload = browser({ storage: b.storage });
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  assert.deepEqual(reload.scores(), []);
  const load = reload.load(async () => { started.resolve(); return finish.promise; });
  await started.promise;
  assert.deepEqual(reload.scores(), ['La Plaza', 'Ría Norte']);
  assert.equal(reload.state.evsareRecharges.data, null);
  finish.resolve([]);
  await load;
  assert.deepEqual(reload.scores(), []);
  assert.equal(reload.storage.size, 0);
});

test('expiry, a different account, and a new login for the same account reject the cache', async () => {
  const { b } = await seed();
  for (const options of [
    { start: now + 15 * 60 * 1000 },
    { session: { ...owner, user: { ...owner.user, id: 2 } } },
    { session: { ...owner, csrfToken: 'fixture-csrf-b' } },
    { session: loggedOut },
  ]) {
    const reload = browser({ ...options, storage: new Map(b.storage) });
    await reload.load(async () => { throw new Error('offline history'); });
    assert.deepEqual(reload.scores(), []);
    assert.equal(reload.storage.size, 0);
  }
  const reload = browser({ storage: b.storage });
  await reload.load(async () => { throw new Error('offline history'); });
  assert.deepEqual(reload.scores(), ['La Plaza', 'Ría Norte']);
  reload.expire(15 * 60 * 1000);
  assert.deepEqual(reload.scores(), []);
  assert.equal(reload.storage.size, 0);
});

test('tampered summaries are purged and ambiguous catalog names never get a score', async () => {
  const { b, raw } = await seed();
  const ambiguous = browser({ storage: new Map(b.storage), sites: [older, { name: 'ria norte' }, newest] });
  await ambiguous.load(async () => { throw new Error('offline history'); });
  assert.deepEqual(ambiguous.scores(), ['La Plaza']);

  const tampered = JSON.parse(raw);
  tampered.payload[1][0][1] = 3;
  const storage = new Map([[b.storage.keys().next().value, JSON.stringify(tampered)]]);
  const reload = browser({ storage });
  await reload.load(async () => { throw new Error('offline history'); });
  assert.deepEqual(reload.scores(), []);
  assert.equal(reload.storage.size, 0);
});

test('a logout erases the cache and late responses cannot restore it', async () => {
  const { b } = await seed();
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  const load = b.load(async () => { started.resolve(); return finish.promise; });
  await started.promise;
  b.apply(loggedOut);
  finish.resolve([charge(1, 'La Plaza')]);
  await load;
  assert.equal(b.storage.size, 0);
  assert.deepEqual(b.scores(), []);
  assert.equal(b.state.evsareRecharges.status, 'idle');
});
