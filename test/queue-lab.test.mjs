import test from 'node:test';
import assert from 'node:assert/strict';
import { startQueueLab } from '../scripts/queue-lab.mjs';

async function fixture(t) {
  const lab = await startQueueLab({ port: 0 });
  t.after(lab.close);
  const get = path => fetch(lab.origin + path);
  const post = (action, origin = lab.origin) => fetch(lab.origin + '/action/' + action, { method: 'POST', headers: { Origin: origin } });
  const act = async action => {
    const response = await post(action);
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  return { ...lab, get, post, act, state: async () => (await get('/state')).json() };
}

test('lab: todos ocupados, prioridad FIFO y aviso distinto sin turno', async t => {
  const lab = await fixture(t);
  const initial = await lab.state();
  assert.deepEqual(initial.zone.resources.map(r => r.status), ['BUSY', 'BUSY']);
  assert.equal(initial.people.first.queue.position, 1);
  assert.equal(initial.people.you.queue, null);
  assert.ok(Object.values(initial.people).every(p => !p.pushEnabled));

  let { people } = await lab.act('join');
  assert.equal(people.you.queue.position, 2);
  ({ people } = await lab.act('free-a'));
  assert.equal(people.first.queue.state, 'OFFERED');
  assert.equal(people.first.queue.resourceName, 'Cargador A');
  assert.equal(people.first.notifications[0].title, 'Tu turno está disponible');
  assert.equal(people.you.queue.state, 'WAITING');
  assert.deepEqual(people.follower.notifications, []);

  ({ people } = await lab.act('free-b'));
  assert.equal(people.you.queue.state, 'WAITING');
  assert.equal(people.follower.queue, null);
  assert.equal(people.follower.notifications[0].title, 'Disponibilidad observada');
  assert.match(people.follower.notifications[0].body, /no te otorga un turno/);
});

test('lab: aceptación no ocupa; liberación y vencimiento transfieren el turno', async t => {
  const lab = await fixture(t);
  await lab.act('join');
  await lab.act('free-a');
  let state = await lab.act('accept-first');
  assert.equal(state.people.first.queue.state, 'ACCEPTED');
  assert.equal(state.zone.resources[0].status, 'AVAILABLE');
  state = await lab.act('occupy-first');
  assert.equal(state.people.first.queue.state, 'CHARGING');
  assert.equal(state.zone.resources[0].status, 'RECHARGING');
  state = await lab.act('release-first');
  assert.equal(state.people.first.queue.reason, 'USER_RELEASED');
  assert.equal(state.people.you.queue.state, 'OFFERED');
  const deadline = state.people.you.queue.expiresAt;
  state = await lab.act('expire-you');
  assert.equal(state.now, deadline);
  assert.equal(state.people.you.queue.reason, 'OFFER_EXPIRED');
  assert.equal(state.people.you.notifications[0].title, 'Oferta no disponible');

  state = await lab.act('reset');
  assert.deepEqual(state.zone.resources.map(r => r.status), ['BUSY', 'BUSY']);
  assert.ok(Object.values(state.people).every(p => p.notifications.length === 0));
  await lab.act('join');
  await lab.act('free-a');
  state = await lab.act('expire-first');
  assert.equal(state.people.first.queue.reason, 'OFFER_EXPIRED');
  assert.equal(state.people.you.queue.state, 'OFFERED');
  await lab.act('accept-you');
  state = await lab.act('expire-you');
  assert.equal(state.people.you.queue.reason, 'ARRIVAL_EXPIRED');
  assert.equal(state.zone.resources[0].status, 'UNKNOWN');
});

test('lab: solo interfaz local y mutaciones del mismo origen', async t => {
  const lab = await fixture(t);
  assert.match(lab.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const page = await lab.get('/');
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(await page.text(), /Laboratorio de cola/);
  assert.match((await lab.get('/lab.js')).headers.get('content-type'), /^text\/javascript/);
  assert.equal((await lab.get('/sw.js')).status, 404);
  assert.equal((await lab.post('free-a', 'https://other.test')).status, 403);
  assert.equal((await fetch(lab.origin + '/action/free-a', { method: 'POST' })).status, 403);
  assert.equal((await lab.get('/action/free-a')).status, 404);
  assert.equal((await lab.state()).zone.resources[0].status, 'BUSY');
});
