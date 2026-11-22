import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, isCode, subscription } from './helpers.mjs';
import { PushWorker } from '../src/push.mjs';

test('voy -> cargando, ETA pública sin identidad y sin liberar al alcanzar ETA ni TTL', t => {
  const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), u1 = f.user(), u2 = f.user();
  f.available(r);
  const q = s.join(u1, { zoneId: z, connector: 'ANY' }).queue;
  assert.throws(() => s.start(u1, q.id, {}), isCode('NOT_ACCEPTED'));
  s.accept(u1, q.id);
  const expected = f.clock() + 80000;
  assert.equal(s.start(u1, q.id, { expectedReleaseAt: expected }).queue.state, 'CHARGING');
  s.join(u2, { zoneId: z, connector: 'ANY' });
  const resource = s.zones().zones[0].resources[0];
  assert.equal(resource.source, 'community');
  assert.equal(resource.status, 'RECHARGING');
  assert.equal(resource.expectedReleaseAt, expected);
  assert.equal(Object.hasOwn(resource, 'userId'), false);
  assert.equal(Object.hasOwn(resource, 'username'), false);
  f.advance(86400000); s.tick();
  assert.equal(s.me(u1).queue.state, 'CHARGING');
  assert.equal(s.me(u2).queue.state, 'WAITING');
  assert.equal(s.zones().zones[0].resources[0].status, 'RECHARGING');
  assert.equal(s.zones().zones[0].availableCount, 0);
  // Refrescar la misma ocupación como admin no convierte la declaración del dueño en telemetría caducable.
  s.setStatus(r, { status: 'RECHARGING' }); f.advance(400000);
  assert.equal(s.zones().zones[0].resources[0].status, 'RECHARGING');
  assert.equal(s.zones().zones[0].resources[0].source, 'community');
});

test('liberación comunitaria entrega siguiente atómicamente y reintento no toca nuevo dueño', t => {
  const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), u1 = f.user(), u2 = f.user();
  const q1 = s.claim(u1, r, {}).queue;
  const q2 = s.join(u2, { zoneId: z, connector: 'ANY' }).queue;
  assert.throws(() => s.release(u2, q1.id), isCode('QUEUE_NOT_FOUND'));
  assert.throws(() => s.release(u2, q2.id), isCode('NOT_CHARGING'));
  assert.equal(s.release(u1, q1.id).queue.state, 'COMPLETED');
  assert.equal(s.me(u2).queue.state, 'OFFERED');
  assert.equal(s.me(u2).queue.resourceId, r);
  assert.equal(s.zones().zones[0].resources[0].source, 'community');
  assert.equal(s.zones().zones[0].availableCount, 0);
  s.accept(u2, q2.id); s.start(u2, q2.id, {});
  f.advance(1000);
  const before = f.db.prepare('SELECT * FROM resources WHERE id=?').get(r);
  s.release(u1, q1.id);
  assert.deepEqual(f.db.prepare('SELECT * FROM resources WHERE id=?').get(r), before);
  assert.equal(s.me(u2).queue.state, 'CHARGING');
});

test('dos plazas cargando: liberar una no cambia la otra, ETA editada/quitada por dueño', t => {
  const f = fixture(t), s = f.service, z = f.zone(), r1 = f.resource(z), r2 = f.resource(z), u1 = f.user(), u2 = f.user();
  const q1 = s.claim(u1, r1, {}).queue, q2 = s.claim(u2, r2, {}).queue;
  const eta = f.clock() + 3600000;
  s.estimate(u2, q2.id, { expectedReleaseAt: eta });
  assert.equal(s.zones().zones[0].resources[1].expectedReleaseAt, eta);
  assert.throws(() => s.estimate(u1, q2.id, { expectedReleaseAt: eta }), isCode('QUEUE_NOT_FOUND'));
  assert.throws(() => s.estimate(u2, q2.id, { expectedReleaseAt: f.clock() - 1 }), isCode('INVALID_ESTIMATE'));
  s.estimate(u2, q2.id, { expectedReleaseAt: null });
  assert.equal(s.zones().zones[0].resources[1].expectedReleaseAt, null);
  s.release(u1, q1.id);
  const zone = s.zones().zones[0];
  assert.equal(zone.availableCount, 1);
  assert.equal(zone.resources[0].status, 'AVAILABLE');
  assert.equal(zone.resources[1].status, 'RECHARGING');
});

test('claim impide saltar WAITING incompatible, OFFERED y ACCEPTED incluso en otra plaza', t => {
  for (const state of ['WAITING', 'OFFERED', 'ACCEPTED']) {
    const f = fixture(t), s = f.service, z = f.zone(), r1 = f.resource(z), r2 = f.resource(z), u1 = f.user(), u2 = f.user();
    const q = s.join(u1, { zoneId: z, connector: state === 'WAITING' ? 'CCS2' : 'ANY' }).queue;
    if (state !== 'WAITING') f.available(r1);
    if (state === 'ACCEPTED') s.accept(u1, q.id);
    assert.throws(() => s.claim(u2, r2, {}), isCode('QUEUE_PRIORITY'));
  }
});

test('claim no takeover, una activa, bloqueos mantenimiento y reservado aun obsoletos', t => {
  const f = fixture(t), s = f.service, z = f.zone(), r1 = f.resource(z), r2 = f.resource(z), u1 = f.user(), u2 = f.user();
  s.claim(u1, r1, {});
  assert.throws(() => s.claim(u2, r1, {}), isCode('RESOURCE_OWNED'));
  assert.throws(() => s.claim(u1, r2, {}), isCode('ACTIVE_QUEUE'));
  assert.throws(() => s.join(u1, { zoneId: z, connector: 'ANY' }), isCode('ACTIVE_QUEUE'));
  for (const status of ['MAINTENANCE', 'RESERVED']) {
    s.setStatus(r2, { status }); f.advance(400000);
    assert.throws(() => s.claim(u2, r2, {}), isCode('RESOURCE_BLOCKED'));
  }
});

test('salir CHARGING es cierre conservador UNKNOWN; complete no sustituye release', t => {
  const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), u = f.user();
  const q = s.claim(u, r, {}).queue;
  assert.throws(() => s.complete(u, q.id), isCode('NOT_ACCEPTED'));
  s.leave(u, q.id);
  assert.equal(s.zones().zones[0].resources[0].status, 'UNKNOWN');
});

test('recordatorio ETA: un evento/outbox por previsión, reinicio conserva deduplicación, no libera', t => {
  const f = fixture(t), z = f.zone(), r = f.resource(z), u = f.user();
  f.service.subscribePush(u, subscription());
  const eta = f.clock() + 10000;
  const q = f.service.claim(u, r, { expectedReleaseAt: eta }).queue;
  f.advance(10000); f.service.tick(); f.service.tick();
  let events = f.db.prepare("SELECT count(*) AS n FROM notifications WHERE kind='REMINDER'").get().n;
  assert.equal(events, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM outbox').get().n, 1);
  f.reopen(); f.service.tick();
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM notifications WHERE kind='REMINDER'").get().n, 1);
  assert.equal(f.service.me(u).queue.state, 'CHARGING');
  assert.match(f.service.me(u).notifications[0].title, /Hora prevista alcanzada/);
  assert.match(f.service.me(u).notifications[0].body, /previsión, no una señal/);
  const next = f.clock() + 10000;
  f.service.estimate(u, q.id, { expectedReleaseAt: next });
  assert.equal(f.service.claimPush(), null); // El aviso anterior no sale con la nueva ETA.
  f.advance(10000); f.service.tick();
  events = f.db.prepare("SELECT count(*) AS n FROM notifications WHERE kind='REMINDER'").get().n;
  assert.equal(events, 2);
  assert.equal(f.service.claimPush().kind, 'REMINDER');
});

test('fin manual idempotente notifica al dueño, persiste señal y no pasa al siguiente antes de release', async t => {
  const f = fixture(t), z = f.zone(), r = f.resource(z), u1 = f.user(), u2 = f.user(), sent = [];
  f.service.subscribePush(u1, subscription('owner-only'));
  f.service.subscribePush(u2, subscription('waiting-only'));
  const q = f.service.claim(u1, r, { expectedReleaseAt: f.clock() + 1000 }).queue;
  f.service.join(u2, { zoneId: z, connector: 'ANY' });
  f.service.chargeFinished(r); f.advance(2000); f.service.chargeFinished(r);
  const finishedAt = f.service.me(u1).queue.chargeFinishedAt;
  assert.ok(finishedAt);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM notifications WHERE kind='FINISHED'").get().n, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM notifications WHERE kind='REMINDER'").get().n, 0);
  assert.equal(f.service.me(u1).queue.state, 'CHARGING');
  assert.equal(f.service.me(u2).queue.state, 'WAITING');
  assert.equal(f.service.zones().zones[0].resources[0].chargeFinishedAt, finishedAt);
  const worker = new PushWorker(f.service, async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); return { statusCode: 201 }; });
  await worker.drain();
  assert.equal(sent.length, 1);
  assert.match(sent[0].endpoint, /owner-only$/);
  assert.match(sent[0].payload.title, /señal manual/);
  f.reopen(); f.service.chargeFinished(r);
  assert.equal(f.service.me(u1).queue.chargeFinishedAt, finishedAt);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM notifications WHERE kind='FINISHED'").get().n, 1);
  f.service.release(u1, q.id);
  assert.equal(f.service.me(u2).queue.state, 'OFFERED');
});

for (const ending of ['release', 'leave', 'admin']) {
  test(`ningún aviso ETA/fin pendiente se envía tras ${ending}`, async t => {
    const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), u = f.user();
    s.subscribePush(u, subscription());
    const q = s.claim(u, r, { expectedReleaseAt: f.clock() + 1000 }).queue;
    f.advance(1000); s.tick(); s.chargeFinished(r);
    if (ending === 'admin') s.setStatus(r, { status: 'AVAILABLE' });
    else s[ending](u, q.id);
    const sent = [];
    const worker = new PushWorker(s, async (_, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; });
    await worker.drain();
    assert.equal(sent.filter(message => ['reminder', 'finished'].includes(message.type)).length, 0);
    if (ending === 'admin') assert.equal(s.me(u).queue.reason, 'ADMIN_CORRECTION');
  });
}
