import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, isCode } from './helpers.mjs';
import { estimateTurn } from '../src/wait-estimate.mjs';

const estimateFields = queue => ({ peopleAhead: queue.peopleAhead, estimatedTurnAt: queue.estimatedTurnAt,
  estimateReason: queue.estimateReason, estimateBasis: queue.estimateBasis });

test('plannedMinutes valida entero 1–720 o null, persiste sin duración por defecto y respeta reintento', t => {
  const f = fixture(t), s = f.service, z = f.zone(), u = f.user();
  for (const plannedMinutes of [0, -1, 721, 1.5, '60', true, false, {}, [], NaN, Infinity]) {
    assert.throws(() => s.join(u, { zoneId: z, connector: 'ANY', plannedMinutes }), isCode('INVALID_PLANNED_MINUTES'));
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM queue').get().n, 0);
  const q = s.join(u, { zoneId: z, connector: 'ANY', plannedMinutes: 45 }).queue;
  assert.equal(q.plannedMinutes, 45);
  assert.equal(s.join(u, { zoneId: z, connector: 'ANY', plannedMinutes: 90 }).queue.plannedMinutes, 45);
  assert.equal(s.join(u, { zoneId: z, connector: 'ANY' }).queue.id, q.id);
  for (const value of [1, 720, null]) {
    assert.equal(s.join(f.user(), { zoneId: z, connector: 'ANY', plannedMinutes: value }).queue.plannedMinutes, value);
  }
  const omitted = s.join(f.user(), { zoneId: z, connector: 'ANY' }).queue;
  assert.equal(omitted.plannedMinutes, null);
  assert.equal(omitted.estimatedTurnAt, null);
  f.reopen();
  assert.equal(f.service.me(u).queue.plannedMinutes, 45);
  assert.throws(() => f.db.prepare('UPDATE queue SET planned_minutes=0 WHERE id=?').run(q.id), /CHECK/);
});

test('migración aditiva v1 conserva cola previa y agrega planned_minutes null de forma idempotente', t => {
  const f = fixture(t), z = f.zone(), u = f.user();
  const old = f.service.join(u, { zoneId: z, connector: 'ANY' }).queue;
  // Simular el esquema anterior exclusivamente en esta DB temporal.
  f.db.exec(`ALTER TABLE queue DROP COLUMN planned_minutes; DROP TABLE provider_sessions; DROP TABLE external_identities;
    DROP VIEW private_provider_zones; DROP TABLE provider_zone_aliases; DROP TABLE provider_sites;
    DROP TABLE charger_favorites; DROP TABLE provider_zones; DROP TABLE remote_charge_attempts; DROP TABLE remote_charge_lifecycle; PRAGMA user_version=1;`);
  assert.equal(f.db.prepare('PRAGMA table_info(queue)').all().some(column => column.name === 'planned_minutes'), false);
  f.reopen();
  const restored = f.service.me(u).queue;
  assert.equal(restored.id, old.id); assert.equal(restored.state, 'WAITING');
  assert.equal(restored.plannedMinutes, null);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 9);
  f.reopen();
  assert.equal(f.db.prepare('PRAGMA table_info(queue)').all().filter(column => column.name === 'planned_minutes').length, 1);
  assert.equal(f.service.me(u).queue.plannedMinutes, null);
});

test('start deriva ETA una sola vez desde reloj servidor y plan, nunca desde tick o reintento', t => {
  const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), u = f.user();
  f.available(r);
  const q = s.join(u, { zoneId: z, connector: 'ANY', plannedMinutes: 30 }).queue;
  s.accept(u, q.id); f.advance(15000);
  const expected = f.clock() + 30 * 60000;
  assert.equal(s.start(u, q.id, {}).queue.expectedReleaseAt, expected);
  f.advance(50000); s.tick();
  assert.equal(s.start(u, q.id, {}).queue.expectedReleaseAt, expected);
  assert.equal(s.start(u, q.id, { expectedReleaseAt: f.clock() + 60000 }).queue.expectedReleaseAt, expected);
  assert.equal(s.zones().zones[0].resources[0].expectedReleaseAt, expected);
  f.advance(30 * 60000); s.tick();
  assert.equal(s.me(u).queue.state, 'CHARGING');
  assert.equal(s.me(u).queue.expectedReleaseAt, expected);
  assert.equal(s.zones().zones[0].resources[0].status, 'RECHARGING');
  f.reopen();
  assert.equal(f.service.me(u).queue.expectedReleaseAt, expected);
});

test('start respeta ETA explícita, null explícito y ausencia de duración sin inventar 60 minutos', t => {
  for (const mode of ['explicit', 'null', 'unknown']) {
    const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), u = f.user();
    f.available(r);
    const q = s.join(u, { zoneId: z, connector: 'ANY', ...(mode === 'unknown' ? {} : { plannedMinutes: 90 }) }).queue;
    s.accept(u, q.id);
    const body = mode === 'explicit' ? { expectedReleaseAt: f.clock() + 600000 } : mode === 'null' ? { expectedReleaseAt: null } : {};
    const started = s.start(u, q.id, body).queue;
    assert.equal(started.expectedReleaseAt, mode === 'explicit' ? body.expectedReleaseAt : null);
    assert.equal(started.plannedMinutes, mode === 'unknown' ? null : 90);
    assert.deepEqual(estimateFields(started), { peopleAhead: 0, estimatedTurnAt: null, estimateReason: 'not_waiting', estimateBasis: 'insufficient' });
  }
});

test('/me mapea WAITING de misma zona, duración previa y CHARGING antiguo al estimador puro', t => {
  const f = fixture(t), s = f.service, z = f.zone(), otherZone = f.zone(), r = f.resource(z);
  const occupant = f.user(), other = f.user(), ahead = f.user(), target = f.user();
  const observedAt = f.clock(), releaseAt = f.clock() + 3600000;
  s.claim(occupant, r, { expectedReleaseAt: releaseAt });
  s.join(other, { zoneId: otherZone, connector: 'ANY', plannedMinutes: 720 });
  const first = s.join(ahead, { zoneId: z, connector: 'TYPE2', plannedMinutes: 20 }).queue;
  const queued = s.join(target, { zoneId: z, connector: 'ANY', plannedMinutes: 45 }).queue;
  f.advance(400000); // Ocupación declarada sigue estimable aunque observedAt supere STALE_SECONDS.
  const expected = estimateTurn({ now: f.clock(), targetId: queued.id,
    entries: [{ id: first.id, connector: 'TYPE2', plannedMinutes: 20 }, { id: queued.id, connector: 'ANY', plannedMinutes: 45 }],
    resources: [{ id: r, connector: 'TYPE2', status: 'RECHARGING', observedAt,
      active: { state: 'CHARGING', expiresAt: null, arrivalExpiresAt: null, expectedReleaseAt: releaseAt, plannedMinutes: null } }],
    offerSeconds: f.config.offerSeconds, arrivalSeconds: f.config.arrivalSeconds, staleSeconds: f.config.staleSeconds });
  let clockCalls = 0;
  s.clock = () => { clockCalls++; return f.clock(); };
  const actual = s.me(target).queue;
  assert.equal(clockCalls, 1);
  assert.deepEqual(estimateFields(actual), expected);
  assert.equal(actual.peopleAhead, 1); assert.equal(actual.position, 2);
  assert.equal(actual.estimatedTurnAt, releaseAt + (f.config.offerSeconds + f.config.arrivalSeconds + 20 * 60) * 1000);
  assert.equal(actual.estimateBasis, 'declared');
  assert.equal(Object.hasOwn(actual, 'userId'), false);
  assert.equal(Object.hasOwn(actual, 'username'), false);
});

test('integración OFFERED/ACCEPTED pasa duración y ventanas correctas sin estimar plazo como liberación real', t => {
  const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), active = f.user(), waiting = f.user();
  f.available(r);
  const offered = s.join(active, { zoneId: z, connector: 'ANY', plannedMinutes: 25 }).queue;
  const next = s.join(waiting, { zoneId: z, connector: 'ANY' }).queue;
  assert.equal(next.peopleAhead, 0); assert.equal(next.position, 1);
  assert.equal(next.estimatedTurnAt, offered.expiresAt + f.config.arrivalSeconds * 1000 + 25 * 60000);
  assert.equal(offered.peopleAhead, 0); assert.equal(offered.estimateReason, 'not_waiting');
  f.advance(1000);
  const accepted = s.accept(active, offered.id).queue;
  assert.equal(s.me(waiting).queue.estimatedTurnAt, accepted.arrivalExpiresAt + 25 * 60000);
  s.complete(active, offered.id);
  const unknown = s.me(waiting).queue;
  assert.equal(unknown.estimatedTurnAt, null);
  assert.equal(unknown.estimateBasis, 'insufficient');
  assert.equal(unknown.estimateReason, 'missing_release_estimate');
});

test('duración anterior desconocida produce null; una plaza conocida permite estimación parcial honesta', t => {
  const f = fixture(t), s = f.service, z = f.zone(), r1 = f.resource(z), r2 = f.resource(z);
  const u1 = f.user(), u2 = f.user(), ahead = f.user(), target = f.user();
  const eta = f.clock() + 3600000;
  s.claim(u1, r1, { expectedReleaseAt: eta }); s.claim(u2, r2, {});
  const first = s.join(ahead, { zoneId: z, connector: 'ANY' }).queue;
  assert.equal(first.estimatedTurnAt, eta);
  assert.equal(first.estimateReason, 'partial_declared_schedule');
  const second = s.join(target, { zoneId: z, connector: 'ANY', plannedMinutes: 15 }).queue;
  assert.equal(second.peopleAhead, 1);
  assert.equal(second.estimatedTurnAt, null);
  assert.equal(second.estimateReason, 'missing_duration');
  assert.equal(second.estimateBasis, 'insufficient');
  f.advance(3600000); s.tick();
  assert.equal(s.me(ahead).queue.estimatedTurnAt, null);
  assert.equal(s.me(u1).queue.state, 'CHARGING');
  assert.equal(s.zones().zones[0].availableCount, 0);
});
