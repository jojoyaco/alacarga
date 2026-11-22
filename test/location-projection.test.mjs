import test from 'node:test';
import assert from 'node:assert/strict';
import { parcelNumbers } from '../src/charger-catalog.mjs';
import { maskRfidCards } from '../src/evsare.mjs';
import { createApplication } from '../src/http.mjs';
import { temporary, testConfig } from './helpers.mjs';

test('parcel references preserve exact labels and never fill a numerical range', () => {
  assert.deepEqual(parcelNumbers('IN0265 Parcelas 424 - 425'), ['424', '425']);
  assert.deepEqual(parcelNumbers('IN0269 Parcelas 428 - 391'), ['428', '391']);
  assert.deepEqual(parcelNumbers('Parcelas: 010B y 015; potencia 22 kW'), ['010B', '015']);
  assert.deepEqual(parcelNumbers('Terminal 4 / 7.36 kW'), []);
});

test('RFID projection masks cards in the authenticated list, including linked cards', () => {
  const own = { idUsuario: 42, idtarjetarfid: 99, codigotarjetarfid: 'CANARY1234', saldo: 123, userAlias: 'private' };
  assert.deepEqual(maskRfidCards({ cards: [own, own, { ...own, idUsuario: 43, idtarjetarfid: 100 }, { ...own, idtarjetarfid: 101, codigotarjetarfid: '1234' }] }, '42'),
    { cards: [{ label: 'Tarjeta RFID', ending: '1234' }, { label: 'Tarjeta RFID', ending: '1234' }] });
  assert.throws(() => maskRfidCards({ cards: [] }, ''), { code: 'EVSARE_BAD_RESPONSE' });
  assert.deepEqual(maskRfidCards({ cards: [{ idtarjetarfid: 102, codigotarjetaibil: 'IBIL5678' },
    { idtarjetarfid: 103, codigotarjetaibil: 'IBIL1234', codigotarjetarfid: 'RFID9999' }] }, '42'),
  { cards: [{ label: 'Tarjeta RFID', ending: '5678' }, { label: 'Tarjeta RFID', ending: '1234' }] });
});

test('RFID endpoint uses the signed-in EVsare identity and never exposes or starts a card', async t => {
  const calls = [];
  const config = testConfig(temporary(t));
  const app = createApplication({ config, sendPush: null, evsareFetch: async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method });
    if (path === '/user/login2') return Response.json({ valid: true, token: 'synthetic-session', user: { userId: 42, firstName: 'Test' } });
    assert.equal(path, '/user/cards');
    assert.equal(init.headers['X-IBIL-TOKEN'], 'synthetic-session');
    assert.equal(new URL(url).search, '');
    return Response.json({ cards: [{ idUsuario: 84, idtarjetarfid: 300, codigotarjetaibil: 'CANARYABCD', codigotarjetarfid: 'RFIDTEST4321' }] });
  } });
  t.after(() => app.close());
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(base + '/api/evsare/rfid-cards')).status, 401);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'synthetic@test', password: 'synthetic' }) });
  const auth = await login.json();
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const cards = await fetch(base + '/api/evsare/rfid-cards', { headers: { Cookie: cookie } });
  assert.equal(cards.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await cards.json(), { cards: [{ label: 'Tarjeta RFID', ending: 'ABCD' }] });
  const reveal = (ending, csrf = auth.csrfToken) => fetch(base + '/api/evsare/rfid-cards/reveal', { method: 'POST', headers: { Cookie: cookie, Origin: config.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ ending }) });
  assert.equal((await reveal('ABCD', 'wrong')).status, 403);
  assert.equal((await reveal('XXXX')).status, 409);
  const revealed = await reveal('ABCD');
  assert.equal(revealed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await revealed.json(), { number: 'RFIDTEST4321' });
  assert.equal((await fetch(base + '/api/evsare/start-charge', { method: 'POST', headers: { Cookie: cookie, Origin: config.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrfToken }, body: '{}' })).status, 404);
  assert.deepEqual(calls, [{ path: '/user/login2', method: 'POST' }, ...Array.from({ length: 3 }, () => ({ path: '/user/cards', method: 'GET' }))]);
});
