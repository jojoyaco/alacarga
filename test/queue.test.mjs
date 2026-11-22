import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fixture, isCode, subscription } from './helpers.mjs';

test('arranque vacío, recursos UNKNOWN, observación del servidor y conteos sin asignados', t => {
  const f = fixture(t), s = f.service;
  assert.deepEqual(s.zones(), { zones: [] });
  const z = f.zone(), r = f.resource(z), u = f.user();
  const empty = s.zones().zones[0];
  assert.equal(empty.resources[0].status, 'UNKNOWN');
  assert.equal(empty.resources[0].observedAt, null);
  f.available(r);
  assert.equal(s.zones().zones[0].availableCount, 1);
  const offer = s.join(u, { zoneId: z, connector: 'ANY' }).queue;
  assert.equal(offer.state, 'OFFERED');
  assert.equal(offer.expiresAt, f.clock() + 120000);
  assert.equal(s.zones().zones[0].availableCount, 0);
  assert.equal(s.zones().zones[0].resources[0].status, 'AVAILABLE');
});

test('FIFO persistido compatible, varias plazas independientes y una sola participación por usuario', t => {
  const f = fixture(t), s = f.service, z = f.zone(), z2 = f.zone();
  const r1 = f.resource(z, 'TYPE2'), r2 = f.resource(z, 'CCS2');
  const [u1, u2, u3] = [f.user(), f.user(), f.user()];
  const q1 = s.join(u1, { zoneId: z, connector: 'CHADEMO' }).queue;
  const q2 = s.join(u2, { zoneId: z, connector: 'TYPE2' }).queue;
  const q3 = s.join(u3, { zoneId: z, connector: 'ANY' }).queue;
  assert.equal(q3.position, 3);
  f.available(r1); f.available(r2);
  assert.equal(s.me(u1).queue.state, 'WAITING');
  assert.equal(s.me(u2).queue.resourceId, r1);
  assert.equal(s.me(u3).queue.resourceId, r2);
  assert.equal(s.join(u2, { zoneId: z, connector: 'TYPE2' }).queue.id, q2.id);
  assert.throws(() => s.join(u2, { zoneId: z2, connector: 'ANY' }), isCode('ACTIVE_QUEUE'));
  assert.equal(s.me(u1).queue.id, q1.id);
  assert.equal(s.zones().zones[0].waitingCount, 1);
});

test('caducidad exacta de oferta pasa al siguiente; aceptación tardía no revierte el avance', t => {
  const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z);
  const u1 = f.user(), u2 = f.user();
  f.available(r);
  const q1 = s.join(u1, { zoneId: z, connector: 'ANY' }).queue;
  s.join(u2, { zoneId: z, connector: 'ANY' });
  f.advance(120000);
  assert.throws(() => s.accept(u1, q1.id), isCode('OFFER_NOT_ACTIVE'));
  assert.equal(s.me(u1).queue.state, 'EXPIRED');
  assert.equal(s.me(u1).queue.reason, 'OFFER_EXPIRED');
  assert.equal(s.me(u2).queue.state, 'OFFERED');
  assert.equal(s.me(u2).queue.resourceId, r);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM queue WHERE state IN ('OFFERED','ACCEPTED','CHARGING')").get().n, 1);
});

test('doble clic accept idempotente sin ampliar llegada y ownership', t => {
  const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), u = f.user(), other = f.user();
  f.available(r);
  const q = s.join(u, { zoneId: z, connector: 'ANY' }).queue;
  assert.throws(() => s.accept(other, q.id), isCode('QUEUE_NOT_FOUND'));
  const first = s.accept(u, q.id).queue;
  f.advance(1000);
  const second = s.accept(u, q.id).queue;
  assert.equal(second.arrivalExpiresAt, first.arrivalExpiresAt);
  assert.equal(second.state, 'ACCEPTED');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM notifications WHERE title='Turno aceptado'").get().n, 1);
});

test('ACCEPTED no es CHARGING; caducidad de llegada consume observación y no ofrece al siguiente', t => {
  const f = fixture(t, { staleSeconds: 3600 }), s = f.service, z = f.zone(), r = f.resource(z), u1 = f.user(), u2 = f.user();
  f.available(r);
  const q = s.join(u1, { zoneId: z, connector: 'ANY' }).queue;
  s.accept(u1, q.id); s.join(u2, { zoneId: z, connector: 'ANY' });
  assert.equal(s.me(u1).queue.state, 'ACCEPTED');
  assert.equal(s.zones().zones[0].resources[0].status, 'AVAILABLE');
  f.advance(600000); s.tick();
  assert.equal(s.me(u1).queue.reason, 'ARRIVAL_EXPIRED');
  assert.equal(s.zones().zones[0].resources[0].status, 'UNKNOWN');
  assert.equal(s.me(u2).queue.state, 'WAITING');
  f.available(r);
  assert.equal(s.me(u2).queue.state, 'OFFERED');
});

for (const operation of ['complete', 'leave']) {
  test(`${operation} ACCEPTED deja UNKNOWN; reintento no modifica recurso posterior`, t => {
    const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), u1 = f.user(), u2 = f.user();
    f.available(r);
    const q = s.join(u1, { zoneId: z, connector: 'ANY' }).queue;
    s.accept(u1, q.id); s.join(u2, { zoneId: z, connector: 'ANY' });
    s[operation](u1, q.id);
    assert.equal(s.zones().zones[0].resources[0].status, 'UNKNOWN');
    assert.equal(s.me(u2).queue.state, 'WAITING');
    f.available(r);
    s[operation](u1, q.id);
    assert.equal(s.me(u2).queue.state, 'OFFERED');
    assert.equal(s.zones().zones[0].resources[0].status, 'AVAILABLE');
  });
}

test('rechazar oferta no consume la observación y despacha siguiente compatible', t => {
  const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), u1 = f.user(), u2 = f.user();
  f.available(r);
  const q = s.join(u1, { zoneId: z, connector: 'ANY' }).queue;
  s.join(u2, { zoneId: z, connector: 'ANY' });
  assert.throws(() => s.complete(u1, q.id), isCode('NOT_ACCEPTED'));
  assert.equal(s.leave(u1, q.id).queue.state, 'CANCELLED');
  assert.equal(s.me(u2).queue.state, 'OFFERED');
});

test('freshness exacta invalida ofertas y disponibilidad, sin ofrecer una observación vieja', t => {
  const f = fixture(t, { staleSeconds: 60 }), s = f.service, z = f.zone(), r = f.resource(z), u1 = f.user(), u2 = f.user();
  f.available(r);
  const q = s.join(u1, { zoneId: z, connector: 'ANY' }).queue;
  s.join(u2, { zoneId: z, connector: 'ANY' });
  f.advance(60000);
  assert.throws(() => s.accept(u1, q.id), isCode('OFFER_NOT_ACTIVE'));
  assert.equal(s.me(u1).queue.reason, 'DATA_STALE');
  assert.equal(s.me(u2).queue.state, 'WAITING');
  assert.equal(s.zones().zones[0].resources[0].status, 'STALE');
  assert.equal(s.zones().zones[0].availableCount, 0);
});

for (const status of ['BUSY', 'UNKNOWN', 'RESERVED', 'RECHARGING', 'MAINTENANCE']) {
  test(`cambio manual ${status} invalida una oferta`, t => {
    const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), u = f.user();
    f.available(r); const q = s.join(u, { zoneId: z, connector: 'ANY' }).queue;
    s.setStatus(r, { status });
    assert.equal(s.me(u).queue.state, 'EXPIRED');
    assert.throws(() => s.accept(u, q.id), isCode('OFFER_NOT_ACTIVE'));
  });
}

test('reinicio conserva cola y secuencia, recupera oferta vencida sin reencolar ausente', t => {
  const f = fixture(t), z = f.zone(), r = f.resource(z), u1 = f.user(), u2 = f.user();
  f.available(r);
  const q1 = f.service.join(u1, { zoneId: z, connector: 'ANY' }).queue;
  const q2 = f.service.join(u2, { zoneId: z, connector: 'ANY' }).queue;
  f.advance(120001); f.reopen(); f.service.tick();
  assert.equal(f.service.me(u1).queue.id, q1.id);
  assert.equal(f.service.me(u1).queue.state, 'EXPIRED');
  assert.equal(f.service.me(u2).queue.id, q2.id);
  assert.equal(f.service.me(u2).queue.state, 'OFFERED');
  assert.ok(f.service.join(u1, { zoneId: z, connector: 'ANY' }).queue.id > q2.id);
});

test('seguir zona no entra en cola; aviso de disponibilidad no otorga turno', t => {
  const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), u = f.user();
  s.subscribePush(u, subscription());
  s.subscribeZone(u, { zoneId: z, enabled: true }); f.available(r);
  const me = s.me(u);
  assert.equal(me.queue, null);
  assert.deepEqual(me.subscriptions, [z]);
  assert.equal(me.pushEnabled, true);
  assert.match(me.notifications[0].body, /no te otorga un turno/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM outbox').get().n, 1);
  s.subscribeZone(u, { zoneId: z, enabled: false });
  assert.equal(s.claimPush(), null);
});

test('índices únicos parciales protegen usuario y recurso incluso frente a SQL de otra conexión', t => {
  const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), u1 = f.user(), u2 = f.user();
  const q = s.claim(u1, r, {}).queue;
  assert.equal(q.state, 'CHARGING');
  const insert = f.db.prepare("INSERT INTO queue(user_id,zone_id,connector,state,resource_id,created_at,updated_at) VALUES (?,?,'ANY','CHARGING',?,?,?)");
  assert.throws(() => insert.run(u2, z, r, f.clock(), f.clock()), /UNIQUE/);
  const r2 = f.resource(z);
  assert.throws(() => insert.run(u1, z, r2, f.clock(), f.clock()), /UNIQUE/);
});

async function race(f, operations) {
  const gate = new SharedArrayBuffer(4);
  const workers = operations.map(operation => new Worker(new URL('./fixtures/concurrent.mjs', import.meta.url), { workerData: { gate, dataDir: f.config.dataDir, now: f.clock(), operation } }));
  const outputs = workers.map(worker => new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', message => { if (message.type === 'result') resolve(message); });
    worker.on('exit', code => { if (code) reject(new Error('Concurrency worker failed')); });
  }));
  await Promise.all(workers.map(worker => new Promise((resolve, reject) => { worker.on('message', message => { if (message.type === 'ready') resolve(); }); worker.on('error', reject); })));
  Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
  const results = await Promise.all(outputs);
  await Promise.all(workers.map(worker => worker.terminate()));
  return results;
}

test('concurrencia real: dos conexiones aceptan el mismo turno una vez sin extender plazo', async t => {
  const f = fixture(t), z = f.zone(), r = f.resource(z), u = f.user();
  f.available(r); const q = f.service.join(u, { zoneId: z, connector: 'ANY' }).queue;
  const results = await race(f, [{ method: 'accept', args: [u, q.id] }, { method: 'accept', args: [u, q.id] }]);
  assert.ok(results.every(result => result.value?.queue.state === 'ACCEPTED'));
  assert.equal(results[0].value.queue.arrivalExpiresAt, results[1].value.queue.arrivalExpiresAt);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM notifications WHERE title='Turno aceptado'").get().n, 1);
});

test('concurrencia real: dos conexiones no asignan una plaza a dos usuarios', async t => {
  const f = fixture(t), z = f.zone(), r = f.resource(z), u1 = f.user(), u2 = f.user();
  f.available(r);
  const results = await race(f, [{ method: 'join', args: [u1, { zoneId: z, connector: 'ANY' }] }, { method: 'join', args: [u2, { zoneId: z, connector: 'ANY' }] }]);
  assert.deepEqual(results.map(result => result.value.queue.state).sort(), ['OFFERED', 'WAITING']);
  const ordered = f.db.prepare('SELECT id,state FROM queue ORDER BY id').all();
  assert.equal(ordered[0].state, 'OFFERED');
  assert.equal(ordered[1].state, 'WAITING');
});

test('concurrencia real: dos recursos libres asignan dos turnos distintos', async t => {
  const f = fixture(t), z = f.zone(), r1 = f.resource(z), r2 = f.resource(z), u1 = f.user(), u2 = f.user();
  f.available(r1); f.available(r2);
  const results = await race(f, [{ method: 'join', args: [u1, { zoneId: z, connector: 'ANY' }] }, { method: 'join', args: [u2, { zoneId: z, connector: 'ANY' }] }]);
  assert.ok(results.every(result => result.value.queue.state === 'OFFERED'));
  assert.notEqual(results[0].value.queue.resourceId, results[1].value.queue.resourceId);
});
