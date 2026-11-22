import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { EvsareAccess, EvsareClient } from '../src/evsare.mjs';

test('curve verifies ownership first and returns bounded, sorted energy readings only', async () => {
  const calls = [];
  const start = 1785600000000;
  const client = new EvsareClient({ fetchImpl: async (raw, request) => {
    const url = new URL(raw);
    calls.push(url.pathname);
    assert.equal(request.method, 'GET');
    assert.equal(request.headers['X-IBIL-TOKEN'], 'synthetic');
    if (url.pathname === '/recargas') {
      assert.equal(url.searchParams.get('todosUsuarios'), 'false');
      return Response.json({ recargas: [{ idRecarga: 42 }] });
    }
    assert.equal(url.pathname, '/recargas/lecturas/42');
    return Response.json({ charges: [ { date: start + 60000, lecture: 1000, power: 9999 }, { date: start, lecture: 0 }, { date: 10, lecture: 999 } ] });
  } });
  const access = new EvsareAccess(client, { getToken: () => 'synthetic', active: () => {} });
  await assert.rejects(access.rechargeCurve({}, 43), { code: 'EVSARE_RECHARGE_NOT_FOUND' });
  assert.deepEqual(calls, ['/recargas']);
  assert.deepEqual(await access.rechargeCurve({}, 42), { points: [ { time: start, energyKwh: 0 }, { time: start + 60000, energyKwh: 1 } ] });
  assert.deepEqual(calls, ['/recargas', '/recargas', '/recargas/lecturas/42']);
  await assert.rejects(client.request('/recargas/lecturas/2147483648'), { code: 'EVSARE_ROUTE_UNSUPPORTED' });
});

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const rechargeUI = app.slice(app.indexOf('function renderEVsareAccount()'), app.indexOf('async function loadEVsareData('));

function rechargeFixture() {
  let focused;
  function element(tag) {
    return {
      tag, dataset: {}, attributes: new Map(), handlers: {}, children: [], isConnected: true, rect: { top: 0, bottom: 200 },
      append(...nodes) { this.children.push(...nodes.flatMap(node => node.tag === '#fragment' ? node.children : [node])); },
      replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
      setAttribute(key, value) { this.attributes.set(key, String(value)); },
      removeAttribute(key) { this.attributes.delete(key); },
      getAttribute(key) { return this.attributes.get(key); },
      addEventListener(key, handler) { this.handlers[key] = handler; },
      getBoundingClientRect() { return this.rect; },
      focus(options) { focused = this; this.focusOptions = options; },
      scrollIntoView(options) { this.scrollOptions = options; },
    };
  }
  let observer;
  class FakeObserver {
    targets = new Set();
    constructor(notify) { this.notify = notify; observer = this; }
    observe(node) { this.targets.add(node); }
    unobserve(node) { this.targets.delete(node); }
    disconnect() { this.targets.clear(); }
  }
  const nodes = new Map();
  const byId = id => {
    if (id.startsWith('recharge-row-')) return byId('recharges-list').children.find(row => row.id === id);
    if (!nodes.has(id)) nodes.set(id, element(id));
    return nodes.get(id);
  };
  const owner = { user: { id: 1, provider: 'evsare' }, csrfToken: 'test' };
  const state = { ...owner, evsareProfile: {}, evsareRecharges: {}, busy: new Set() };
  const calls = [];
  const pending = [];
  const session = { ...owner };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const context = {
    document: { createElement: element, createElementNS: (_, tag) => element(tag), createDocumentFragment: () => element('#fragment') },
    window: { innerHeight: 750 }, IntersectionObserver: FakeObserver, state, byId, rechargeSignature: '',
    $$: () => [], text: (node, value) => { node.textContent = value ?? ''; }, visible: (node, show) => { node.hidden = !show; },
    disabled: (node, value) => { node.disabled = value; }, renderEVsareControls: () => {}, shortTime: () => '10:00', fullTime: () => '10:00',
    dataFresh: () => true, sameSession: (a, b) => a.user?.id === b.user?.id && a.csrfToken === b.csrfToken,
    applySession: newSession => { Object.assign(state, newSession); byId('recharges-list').replaceChildren(); stop(); }, refresh: () => {},
    isEVsareError: () => false, needsOfficialAction: () => false,
    api: async path => {
      if (path === '/api/session') return session;
      calls.push(path);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  const { render, stop, setCost } = runInNewContext(`${rechargeUI}\n({ render: renderEVsareAccount, stop: stopRechargeCurves, setCost: () => { rechargeMetric = 'cost'; } })`, context);
  function showHistory(...costs) {
    state.evsareRecharges = { status: 'ready', data: costs.map((cost, i) => ({
      id: 41 + i, siteName: `Site ${i}`, startedAt: '2026-08-01T08:00:00Z', endedAt: '2026-08-01T08:15:00Z', ...cost,
    })) };
    render();
    return byId('recharges-list').children.map(row => row.children[1]);
  }
  function intersect(...nodes) {
    observer.notify(nodes.map(target => ({ target, isIntersecting: true, intersectionRatio: 0.5 })));
  }
  return { calls, byId, pending, session, state, flush, showHistory, intersect, setCost, get focused() { return focused; } };
}

test('recharge rows and the cost chart use the same EUR format, including zero and reported EUR', () => {
  const env = rechargeFixture();
  env.setCost();
  const rows = env.showHistory({ reportedCost: 12.5 }, { costEur: 0, reportedCost: 30 }, {});
  const fmt = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
  assert.equal(rows[0].children.at(-2).textContent, `Importe: ${fmt.format(12.5)}`);
  assert.equal(rows[1].children.at(-2).textContent, `Importe: ${fmt.format(0)}`);
  assert.equal(rows[2].children.at(-2).textContent, 'Coste no informado');
  assert.equal(env.byId('recharges-total').textContent, fmt.format(12.5));
  assert.deepEqual(env.byId('recharges-plot').children[0].children.map(row => row.children[0].children[0].textContent), [fmt.format(12.5), fmt.format(0)]);
  assert.equal(rows[0].children.at(-1).tag, 'div');
  assert.equal(rows[0].children.at(-1).children[0].getAttribute('role'), 'status');
});

test('a chart button opens history and focuses the matching recharge by ID without requesting its curve directly', () => {
  const env = rechargeFixture();
  const [newer, older] = env.showHistory(
    { id: 99, energyKwh: 0, siteName: 'Same site', terminalName: 'A', startedAt: '2026-08-02T08:00:00Z', endedAt: '2026-08-02T08:15:00Z' },
    { id: 25, energyKwh: 0, siteName: 'Same site', terminalName: 'B' },
  ).map(row => row.children.at(-1));
  const history = env.byId('recharges-history');
  history.open = false;
  const bar = env.byId('recharges-plot').children[0].children[0].children[0];
  assert.equal(bar.tag, 'button');
  assert.equal(bar.type, 'button');
  assert.equal(bar.getAttribute('aria-controls'), 'recharge-row-25');
  assert.match(bar.getAttribute('aria-label'), /Ver recarga: 0 kWh · Same site · B/);
  bar.handlers.click();
  assert.equal(history.open, true);
  assert.equal(env.focused.id, 'recharge-row-25');
  assert.equal(env.focused.tabIndex, -1);
  assert.equal(env.focused.focusOptions.preventScroll, true);
  assert.equal(env.focused.scrollOptions.block, 'center');
  assert.deepEqual(env.calls, []);
  newer.rect = { top: 201, bottom: 240 };
  env.intersect(newer, older);
  assert.deepEqual(env.calls, ['/api/evsare/recharges/25/curve']);
});

test('only visible history curves load, one request at a time; failure retries only on demand', async () => {
  const env = rechargeFixture();
  const [first, second, belowFold] = env.showHistory({}, {}, {}).map(row => row.children.at(-1));
  belowFold.rect = { top: 201, bottom: 240 };
  env.intersect(first, second, belowFold);
  assert.deepEqual(env.calls, []);
  env.byId('recharges-history').open = true;
  env.state.busy.add('auth');
  env.intersect(first, second, belowFold);
  assert.deepEqual(env.calls, []);
  env.state.busy.delete('auth');
  env.intersect(first, second, belowFold);
  env.intersect(first);
  assert.deepEqual(env.calls, ['/api/evsare/recharges/41/curve']);
  assert.equal(first.getAttribute('aria-busy'), 'true');
  env.pending[0].reject(new Error('temporary failure'));
  await env.flush();
  assert.equal(first.getAttribute('aria-busy'), undefined);
  assert.deepEqual(env.calls, ['/api/evsare/recharges/41/curve', '/api/evsare/recharges/42/curve']);
  env.pending[1].resolve({ points: [{ time: 1000, energyKwh: 2.5 }] });
  await env.flush();
  const svg = second.children[1].children[0];
  assert.equal(svg.getAttribute('role'), 'img');
  assert.match(svg.getAttribute('aria-label'), /2,5 kWh/);
  env.intersect(first, second);
  assert.equal(env.calls.length, 2);
  const retry = first.children[2];
  assert.equal(retry.hidden, false);
  retry.handlers.click();
  retry.handlers.click();
  assert.equal(env.calls.length, 3);
  env.pending[2].resolve({ points: [] });
  await env.flush();
  assert.equal(retry.hidden, true);
  assert.match(first.children[0].textContent, /no ha devuelto lecturas/);
});

test('changing the server session prevents rendering old readings or starting another private request', async () => {
  const env = rechargeFixture();
  const [first, second] = env.showHistory({}, {}).map(row => row.children.at(-1));
  env.byId('recharges-history').open = true;
  env.intersect(first, second);
  env.session.user = { id: 2, provider: 'evsare' };
  env.pending[0].resolve({ points: [{ time: 1000, energyKwh: 2.5 }] });
  await env.flush();
  assert.deepEqual(first.children[1].children, []);
  assert.deepEqual(env.byId('recharges-list').children, []);
  assert.deepEqual(env.calls, ['/api/evsare/recharges/41/curve']);
});

test('authorization and rate-limit failures suppress additional automatic curve requests', async () => {
  for (const status of [401, 429]) {
    const env = rechargeFixture();
    const [first, second] = env.showHistory({}, {}).map(row => row.children.at(-1));
    env.byId('recharges-history').open = true;
    env.intersect(first, second);
    env.pending[0].reject(Object.assign(new Error('server rejected request'), { status }));
    await env.flush();
    env.intersect(second);
    assert.deepEqual(env.calls, ['/api/evsare/recharges/41/curve']);
    if (status === 401) assert.equal(env.byId('profile-reconnect').hidden, false);
    else assert.match(first.children[0].textContent, /Espera un minuto/);
  }
});
