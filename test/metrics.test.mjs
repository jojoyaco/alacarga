import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication } from '../src/http.mjs';
import { loadConfig } from '../src/config.mjs';
import { createMetrics, createMetricsServer } from '../src/metrics.mjs';
import { fixture, temporary, testConfig } from './helpers.mjs';

test('committed actions count once; idempotent calls and rollbacks do not', t => {
  const f = fixture(t);
  const m = createMetrics(f.db, { observedAt: 123000 });
  const user = f.user();
  const next = f.user();
  const zoneId = f.zone();
  const resourceId = f.resource(zoneId);
  f.available(resourceId);
  f.service.subscribeZone(user, { zoneId, enabled: true });
  f.service.subscribeZone(user, { zoneId, enabled: true });
  f.db.exec('BEGIN');
  f.db.prepare('INSERT INTO charger_favorites(user_id,zone_id) VALUES (?,?)').run(user, zoneId);
  f.db.exec('ROLLBACK');
  const { queue } = f.service.join(user, { zoneId, connector: 'ANY' });
  f.service.join(user, { zoneId, connector: 'ANY' });
  f.service.accept(user, queue.id);
  f.service.accept(user, queue.id);
  f.service.leave(user, queue.id);
  f.service.leave(user, queue.id);
  f.available(resourceId);
  f.service.join(next, { zoneId, connector: 'ANY' });
  f.advance((f.config.offerSeconds + 1) * 1000);
  f.service.tick();
  const text = m.render();
  for (const [kind, count] of Object.entries({ alert_enabled: 1, favorite_added: 0, queue_joined: 2, queue_accepted: 1, queue_cancelled: 1, queue_expired: 1 })) {
    assert.ok(text.includes(`alacarga_events_total{event="${kind}"} ${count}\n`));
  }
  assert.ok(text.includes('alacarga_catalog_last_success_timestamp_seconds 123\n'));
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('only the private listener returns aggregate, bounded metrics', async t => {
  const config = testConfig(temporary(t), { metricsPort: 9406, metricsPeers: new Set(['127.0.0.1']) });
  mkdirSync(config.publicDir);
  writeFileSync(join(config.publicDir, 'index.html'), 'synthetic');
  const app = createApplication({ config, sendPush: null });
  t.after(() => app.close());
  const site = await listen(app.server);
  const scrape = await listen(app.metricsServer);
  assert.equal((await fetch(`${site}/metrics`)).status, 404);
  assert.equal((await fetch(`${scrape}/api/session`)).status, 404);
  assert.equal((await fetch(`${site}/`)).status, 200);
  assert.equal((await fetch(`${site}/app.js`)).status, 404);
  await fetch(`${site}/api/health`);
  await fetch(`${site}/api/evsare/recharges/123456789/curve?secret=do-not-export`);
  await fetch(`${site}/api/login`, { method: 'POST', headers: { Origin: 'https://unrelated.test' } });
  const res = await fetch(`${scrape}/metrics`);
  assert.match(res.headers.get('content-type'), /^text\/plain; version=0\.0\.4/);
  const text = await res.text();
  assert.match(text, /alacarga_page_loads_total 1\n/);
  assert.match(text, /alacarga_logins_total\{outcome="failure"\} 1\n/);
  assert.match(text, /alacarga_api_request_duration_seconds_count 2\n/);
  assert.doesNotMatch(text, /123456789|do-not-export|unrelated\.test|127\.0\.0\.1/);
});

test('the private listener ignores forwarded IPs and is opt-in', async t => {
  assert.equal(loadConfig({}).metricsPort, 0);
  for (const env of [{ METRICS_PORT: '3000' }, { METRICS_PORT: '9406' }, { METRICS_PORT: '9406', METRICS_PEERS: '0.0.0.0/0' }]) assert.throws(() => loadConfig(env), /METRICS/);
  const server = createMetricsServer({ render: () => assert.fail('unauthorized') }, new Set(['192.0.2.10']));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = await listen(server);
  const response = await fetch(`${base}/metrics`, { headers: { 'X-Forwarded-For': '192.0.2.10', 'X-Real-IP': '192.0.2.10' } });
  assert.equal(response.status, 404);
});
