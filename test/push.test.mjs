import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, subscription, isCode } from './helpers.mjs';
import { loadVapidKeys, validateEndpoint, validateSubscription, isPublicAddress, PushWorker, createPushSender } from '../src/push.mjs';
import { generateRequestDetails } from 'web-push';

test('VAPID persiste con permisos privados, no se regenera un archivo corrupto', t => {
  const f = fixture(t);
  const keys = loadVapidKeys(f.config.dataDir);
  assert.equal(keys.publicKey.length, 87);
  assert.equal(keys.privateKey.length, 43);
  assert.deepEqual(loadVapidKeys(f.config.dataDir), keys);
  assert.equal(statSync(join(f.config.dataDir, 'vapid.json')).mode & 0o777, 0o600);
  assert.equal(statSync(f.config.dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.config.dataDir, 'alacarga.sqlite')).mode & 0o777, 0o600);
  writeFileSync(join(f.config.dataDir, 'vapid.json'), 'invalid');
  assert.throws(() => loadVapidKeys(f.config.dataDir), /no se regeneraron/);
  assert.equal(readFileSync(join(f.config.dataDir, 'vapid.json'), 'utf8'), 'invalid');
});

test('push: hosts exactos, HTTPS, DNS público; se rechazan SSRF y claves mal formadas', () => {
  for (const endpoint of [
    'http://fcm.googleapis.com/path', 'https://localhost/path', 'https://127.0.0.1/path', 'https://[::1]/path',
    'https://fcm.googleapis.com.evil.test/path', 'https://evilfcm.googleapis.com/path', 'https://evilpush.services.mozilla.com/path',
    'https://fcm.googleapis.com@evil.test/path', 'https://a:b@fcm.googleapis.com/path', 'https://fcm.googleapis.com:444/path',
    'https://fcm.googleapis.com./path', 'https://fcm.googleapis.com/path#fragment', 'https://fcm.googleapis.com\\@evil.test/path',
    'file:///etc/passwd', 'https://push.services.mozilla.com/path', 'https://notify.windows.com/path',
  ]) assert.throws(() => validateEndpoint(endpoint), isCode('INVALID_PUSH_ENDPOINT'));
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/test', 'https://updates.push.services.mozilla.com/wpush/test', 'https://web.push.apple.com/test', 'https://wns2-bl2p.notify.windows.com/w/?token=test']) {
    assert.equal(validateEndpoint(endpoint), endpoint);
  }
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001:db8::1', '2002:7f00:1::', '64:ff9b::7f00:1']) assert.equal(isPublicAddress(address), false);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  const sub = subscription();
  assert.deepEqual(validateSubscription(sub), sub);
  for (const keys of [{ ...sub.keys, auth: 'a'.repeat(21) }, { ...sub.keys, auth: sub.keys.auth + '=' }, { ...sub.keys, p256dh: Buffer.alloc(65).toString('base64url') }, { ...sub.keys, p256dh: 'a'.repeat(87) }]) assert.throws(() => validateSubscription({ ...sub, keys }), isCode('INVALID_PUSH_KEYS'));
  assert.throws(() => validateSubscription({ ...sub, expirationTime: 1 }), isCode('INVALID_PUSH_EXPIRATION'));
});

test('endpoint tiene dueño: no transferir ni desactivar suscripción ajena, reintento propio idempotente', t => {
  const f = fixture(t), s = f.service, u1 = f.user(), u2 = f.user(), sub = subscription();
  s.subscribePush(u1, sub); s.subscribePush(u1, sub);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM push_subscriptions').get().n, 1);
  assert.throws(() => s.subscribePush(u2, sub), isCode('PUSH_OWNERSHIP'));
  assert.throws(() => s.unsubscribePush(u2, { endpoint: sub.endpoint }), isCode('PUSH_NOT_FOUND'));
  assert.equal(s.me(u1).pushEnabled, true);
  s.unsubscribePush(u1, { endpoint: sub.endpoint });
  assert.equal(s.me(u1).pushEnabled, false);
});

test('cola + oferta + outbox son atómicos: fallo insert outbox no deja asignación parcial', t => {
  const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), u = f.user();
  s.subscribePush(u, subscription());
  const q = s.join(u, { zoneId: z, connector: 'ANY' }).queue;
  f.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(() => f.available(r), /synthetic failure/);
  assert.equal(f.db.prepare('SELECT state FROM queue WHERE id=?').get(q.id).state, 'WAITING');
  assert.equal(f.db.prepare('SELECT status FROM resources WHERE id=?').get(r).status, 'UNKNOWN');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM notifications').get().n, 0);
});

test('outbox retry persistido, TTL decrece y 201 solo significa provider_accepted', async t => {
  const f = fixture(t), z = f.zone(), r = f.resource(z), u = f.user();
  f.service.subscribePush(u, subscription()); f.available(r);
  f.service.join(u, { zoneId: z, connector: 'ANY' });
  const calls = [];
  const failing = new PushWorker(f.service, async (_, payload, options) => { calls.push({ payload: JSON.parse(payload), options }); throw { statusCode: 503 }; });
  await failing.drain();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.TTL, 120);
  assert.equal(calls[0].payload.type, 'offer');
  assert.equal(f.db.prepare('SELECT state FROM outbox').get().state, 'pending');
  await failing.drain(); assert.equal(calls.length, 1);
  f.advance(5000); f.reopen();
  const success = new PushWorker(f.service, async (_, payload, options) => { calls.push({ payload: JSON.parse(payload), options }); return { statusCode: 201 }; });
  await success.drain();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.TTL, 115);
  assert.equal(f.db.prepare('SELECT state FROM outbox').get().state, 'provider_accepted');
  await success.drain(); assert.equal(calls.length, 2);
});

test('outbox lease recupera caída, workers concurrentes no reclaman el mismo envío', t => {
  const f = fixture(t), u = f.user();
  f.service.subscribePush(u, subscription()); f.service.testPush(u);
  const first = f.service.claimPush();
  assert.ok(first);
  assert.equal(f.service.claimPush(), null);
  f.reopen(); assert.equal(f.service.claimPush(), null);
  f.advance(45000);
  const recovered = f.service.claimPush();
  assert.equal(recovered.id, first.id);
  assert.notEqual(recovered.leaseToken, first.leaseToken);
  f.service.finishPush(first, { statusCode: 201 });
  assert.equal(f.db.prepare('SELECT state FROM outbox').get().state, 'sending');
  f.service.finishPush(recovered, { statusCode: 201 });
  assert.equal(f.db.prepare('SELECT state FROM outbox').get().state, 'provider_accepted');
});

for (const statusCode of [404, 410]) {
  test(`push ${statusCode} elimina endpoint y trabajos asociados`, async t => {
    const f = fixture(t), s = f.service, u = f.user();
    s.subscribePush(u, subscription()); s.testPush(u);
    const worker = new PushWorker(s, async () => { throw { statusCode }; });
    await worker.drain();
    assert.equal(s.me(u).pushEnabled, false);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM outbox').get().n, 0);
  });
}

test('TTL e invalidación descartan ofertas obsoletas; no se envía push real', async t => {
  const f = fixture(t, { staleSeconds: 10 }), s = f.service, z = f.zone(), r = f.resource(z), u = f.user(), sent = [];
  s.subscribePush(u, subscription()); f.available(r); s.join(u, { zoneId: z, connector: 'ANY' });
  f.advance(10000);
  const worker = new PushWorker(s, async (_, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; });
  await worker.drain();
  assert.equal(sent.filter(message => message.type === 'offer').length, 0);
  assert.equal(f.db.prepare("SELECT state FROM outbox JOIN notifications n ON n.id=outbox.notification_id WHERE n.kind='OFFER'").get().state, 'expired');
});

test('reintentos acotados: cinco fallos, sin bucle de envío', async t => {
  const f = fixture(t), s = f.service, u = f.user();
  s.subscribePush(u, subscription()); s.testPush(u);
  let calls = 0;
  const worker = new PushWorker(s, async () => { calls++; throw new Error('synthetic transport failure'); });
  for (const wait of [0, 5000, 10000, 20000, 40000, 60000]) { f.advance(wait); await worker.drain(); }
  assert.equal(calls, 5);
  assert.equal(f.db.prepare('SELECT state FROM outbox').get().state, 'failed');
});

test('web-push 4 cifra payload y firma VAPID con adaptador de red inyectado, sin red real', async t => {
  const f = fixture(t), keys = loadVapidKeys(f.config.dataDir), sub = subscription();
  const payload = JSON.stringify({ title: 'Prueba criptográfica sintética' });
  let calls = 0;
  const send = createPushSender(f.config, keys, async (subscription, body, options) => {
    calls++;
    const details = generateRequestDetails(subscription, body, options);
    assert.equal(details.method, 'POST');
    assert.equal(details.endpoint === sub.endpoint, true);
    assert.equal(details.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(details.headers.TTL, 20);
    assert.equal(typeof details.headers.Authorization, 'string');
    assert.equal(Buffer.isBuffer(details.body), true);
    assert.equal(details.body.includes(Buffer.from(payload)), false);
    assert.equal(Object.hasOwn(options, 'proxy'), false);
    assert.equal(typeof options.agent.options.lookup, 'function');
    return { statusCode: 201 };
  });
  const result = await send(sub, payload, { TTL: 20, urgency: 'high' });
  assert.equal(result.statusCode, 201); assert.equal(calls, 1);
});

test('deadline push absoluta y validación antes de transporte', async t => {
  const f = fixture(t), keys = loadVapidKeys(f.config.dataDir);
  let calls = 0;
  const send = createPushSender(f.config, keys, () => { calls++; return new Promise(() => {}); }, 10);
  await assert.rejects(send(subscription(), '{}', { TTL: 10 }), /deadline/);
  assert.equal(calls, 1);
  const sub = subscription(); sub.endpoint = 'https://127.0.0.1/private';
  await assert.rejects(send(sub, '{}', { TTL: 10 }), isCode('INVALID_PUSH_ENDPOINT'));
  assert.equal(calls, 1);
});

test('410 de claves antiguas no elimina una suscripción renovada durante el envío', t => {
  const f = fixture(t), s = f.service, u = f.user();
  const first = subscription('renewed');
  s.subscribePush(u, first); s.testPush(u);
  const job = s.claimPush();
  s.subscribePush(u, subscription('renewed'));
  s.finishPush(job, { statusCode: 410 });
  assert.equal(s.me(u).pushEnabled, true);
  assert.equal(f.db.prepare('SELECT state FROM outbox').get().state, 'failed');
});

test('aviso ACCEPTED pendiente no se envía cuando el usuario ya está CHARGING o salió', async t => {
  const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), u = f.user();
  s.subscribePush(u, subscription()); f.available(r);
  const q = s.join(u, { zoneId: z, connector: 'ANY' }).queue;
  s.accept(u, q.id); s.start(u, q.id, {});
  const sent = [];
  await new PushWorker(s, async (_, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; }).drain();
  assert.equal(sent.length, 0);
});
