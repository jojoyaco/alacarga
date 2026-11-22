import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargerCatalog, normalizeCatalog, terminalState } from '../src/charger-catalog.mjs';
import { fixture, isCode, subscription } from './helpers.mjs';

const places = { e1: { id: 1, name: 'Ubicación privada', lat: 42, long: -2, terminalsId: ['t1', 't2'] } };
const terminal = { emplacementId: 1, idRate: 1, internalName: 'IN0001', description: 'IN0001 Parcelas 10 - 11',
  connectors: { c1: { id: 1, type: 8, power: 7.36000013, idphysical: 'A' }, c2: { id: 2, type: 8, power: 22 } } };
const terminals = { t1: { ...terminal, id: 1, userId: ['u42', '84'] }, t2: { ...terminal, id: 2, description: 'Terminal privado B · Parcelas 20 - 21', userId: ['u999'] } };
const rates = { r1: { id: 1, rateSegments: { s1: { description: 'Horario', start: '00:00', end: '23:59', energyPrice: 3 } } } };
const telemetry = (a, b) => ({ t1: { connectors: { c1: { id: 1, state: a, userId: 999 }, c2: { id: 2, state: b, userId: 999 } } } });

test('guarda una sola plaza por terminal, exige estados completos y no proyecta ocupantes ni unidades sin validar', () => {
  const normalized = normalizeCatalog(places, terminals, rates);
  assert.deepEqual([...normalized.permissions.get('t1')], ['42', '84']);
  const t = normalized.sites[0].terminals[0];
  assert.equal(t.name, 'IN0001 Parcelas 10 - 11');
  assert.deepEqual(t.connectors.map(c => c.label), ['A', null]);
  assert.equal(terminalState(t, telemetry(1, 1)).state, 'AVAILABLE');
  assert.equal(terminalState(t, telemetry(1, 5)).state, 'RECHARGING');
  assert.equal(terminalState(t, telemetry(1, null)).state, 'UNKNOWN');
  assert.equal(terminalState({ ...t, blocked: 'MAINTENANCE' }, telemetry(1, 1)).state, 'MAINTENANCE');
  assert.deepEqual(t.tariffSegments[0], { description: 'Horario', start: '00:00', end: '23:59' });
  assert.doesNotMatch(JSON.stringify(terminalState(t, telemetry(1, 1))), /userId|999/);
});

test('normaliza solo pares de plazas explícitos; las plazas no intervienen en la verificación del conector', t => {
  const { service } = fixture(t);
  service.config = { ...service.config, remoteCharge: true, remoteChargeTargets: new Set(['e1:t1:1']) };
  service.catalog = {};
  for (const [description, moreInformation, expected] of [
    ['Cargador · Plaza 004-008', null, ['004', '008']],
    ['Cargador', 'Parcelas 831 - 821', ['831', '821']],
    ['Cargador', 'Parcela 801-801', ['801']],
    ['Cargador · Parcela 801', 'Parcelas 831-821', ['801']],
    ['Cargador · Plaza Mayor 4', null, []],
    ['Cargador · Plaza 17', null, []],
    ['Cargador · Parking 12-15', 'Capacidad 12-15', []],
    ['Cargador · Plaza 004-008 kW', 'Acceso por Parcelas 12-15', []],
  ]) {
    const { sites } = normalizeCatalog(places, { ...terminals, t1: { ...terminals.t1,
      description, moreInformation, internalName: '004', connectedToIbilsare: false } }, rates);
    const [target] = sites[0].terminals;
    assert.deepEqual(target.parcels, expected);
    assert.equal(service.chargeTargetVerified('e1', target, target.connectors[0]), true);
    assert.equal(service.chargeTargetVerified('e2', target, target.connectors[0]), false);
    assert.equal(service.chargeTargetVerified('e1', target, target.connectors[1]), false);
    assert.equal(Object.hasOwn(target, 'moreInformation'), false);
  }
});

test('el piloto conserva solo el destino IBILSARE nativo no Bluetooth y sin colisiones de etiqueta física', t => {
  const { service } = fixture(t);
  service.config = { ...service.config, remoteCharge: true, remoteChargeTargets: new Set(['e1:t1:1']) };
  service.catalog = {};
  for (const overrides of [{ isBluetooth: true }, { isBluetooth: 'false' }, { broker_interop: 'OCPI' }, { isInteroperable: true },
    { connectors: { c1: { id: 1, type: 2 } } }, { connectors: { c1: { id: 1, idphysical: 'A' }, c2: { id: 2, idphysical: 'a' } } }]) {
    const { sites } = normalizeCatalog(places, { ...terminals, t1: { ...terminals.t1, ...overrides } }, rates);
    const [target] = sites[0].terminals;
    assert.equal(service.chargeTargetVerified('e1', target, target.connectors[0]), false);
  }
});

test('un código visible del operador prima sobre el nombre interno sin crear plazas', () => {
  const { sites } = normalizeCatalog(places, { ...terminals, t1: { ...terminals.t1,
    description: 'IN0199', internalName: 'SERIAL-EXAMPLE', moreInformation: null } }, rates);
  const target = sites[0].terminals.find(t => t.id === 't1');
  assert.equal(target.name, 'IN0199');
  assert.deepEqual(target.parcels, []);
});

test('catálogo se filtra por cuenta EVsare; suscripción privada y FIFO no inventan señal de liberación', t => {
  const f = fixture(t), { service, db } = f;
  const [first, second, outsider, subscriber] = [f.user(), f.user(), f.user(), f.user()];
  for (const [u, subject] of [[first, '42'], [second, '84'], [subscriber, '85']]) {
    db.prepare("INSERT INTO external_identities VALUES (?,'evsare',?,'Cuenta test')").run(u, subject);
  }
  const c = new ChargerCatalog(null, { clock: f.clock }); service.catalog = c;
  c.metadata = normalizeCatalog(places, { ...terminals, t1: { ...terminals.t1, userId: ['u42','u84','u85'] } }, rates);
  c.metadataAt = f.clock();
  const sample = (a, b) => {
    f.advance(10);
    c.observedAt = f.clock();
    c.sites = c.metadata.sites.map(s => ({ ...s, terminals: s.terminals.map(t => terminalState(t, telemetry(a, b))) }));
    c.terminals = new Map(c.sites.flatMap(s => s.terminals.map(t => [t.id, t])));
    service.tick();
  };
  sample(2, 1);
  assert.deepEqual(service.privateChargers(outsider).sites, []);
  const [{ id, zoneId, terminals: mine }] = service.privateChargers(first).sites;
  assert.equal(id, 'e1');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].connectors[0].powerKw, 7.36);
  assert.deepEqual(service.zones(), { zones: [] });
  assert.throws(() => service.subscribeZone(outsider, { zoneId, enabled: true }), isCode('ZONE_NOT_FOUND'));
  assert.throws(() => service.join(outsider, { zoneId, connector: 'ANY' }), isCode('ZONE_NOT_FOUND'));
  service.subscribeZone(subscriber, { zoneId, enabled: true });
  assert.equal(service.me(subscriber).queue, null);
  sample(1, 1);
  assert.equal(service.me(subscriber).notifications.length, 1);
  sample(1, 1);
  assert.equal(service.me(subscriber).notifications.length, 1);
  const { queue: one } = service.join(first, { zoneId, connector: 'ANY' });
  assert.equal(one.state, 'OFFERED');
  assert.equal(service.join(second, { zoneId, connector: 'ANY' }).queue.state, 'WAITING');
  service.accept(first, one.id);
  service.start(first, one.id, {});
  service.release(first, one.id);
  assert.equal(service.me(second).queue.state, 'WAITING');
  sample(1, 1);
  assert.equal(service.me(second).queue.state, 'OFFERED');
  c.metadata.permissions.get('t1').delete('84');
  sample(1, 1);
  assert.equal(service.me(second).queue.reason, 'ACCESS_REVOKED');
  f.advance(40001);
  const stale = service.privateChargers(first);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.sites[0].terminals[0].state, 'UNKNOWN');
  assert.throws(() => service.join(first, { zoneId, connector: 'ANY' }), isCode('ZONE_NOT_FOUND'));
  f.advance(150000);
  assert.throws(() => service.privateChargers(first), isCode('CHARGER_CATALOG_UNAVAILABLE'));
});

function testCatalog(f, members) {
  const c = new ChargerCatalog(null, { clock: f.clock });
  c.metadata = normalizeCatalog(places, {
    t1: { ...terminals.t1, userId: members.t1 }, t2: { ...terminals.t2, userId: members.t2 },
  }, rates);
  c.metadataAt = f.clock();
  const sample = (a, b) => {
    f.advance(10);
    c.observedAt = f.clock();
    const live = { ...telemetry(a, a), t2: telemetry(b, b).t1 };
    c.sites = c.metadata.sites.map(s => ({ ...s, terminals: s.terminals.map(t => terminalState(t, live)) }));
    c.terminals = new Map(c.sites.flatMap(s => s.terminals.map(t => [t.id, t])));
  };
  return { c, sample };
}

function member(f, subject) {
  const userId = f.user();
  f.db.prepare("INSERT INTO external_identities VALUES (?,'evsare',?,'Cuenta test')").run(userId, subject);
  return userId;
}

test('una ubicación con permisos mixtos comparte favoritos y cola, sin usar plazas ni avisos invisibles', t => {
  const f = fixture(t), s = f.service;
  const a = member(f, '42'), b = member(f, '84'), both = member(f, '85'), watcher = member(f, '86');
  const { c, sample } = testCatalog(f, { t1: ['42', '85', '86'], t2: ['84', '85'] });
  s.catalog = c;
  sample(2, 2);
  const [firstSite] = s.privateChargers(a).sites, [secondSite] = s.privateChargers(b).sites;
  const { zoneId } = firstSite;
  assert.equal(secondSite.zoneId, zoneId);
  assert.deepEqual(firstSite.terminals.map(t => t.id), ['t1']);
  assert.deepEqual(secondSite.terminals.map(t => t.id), ['t2']);
  assert.doesNotMatch(JSON.stringify(firstSite), /privado B|t2/);
  assert.equal(s.get('SELECT count(*) AS n FROM resources WHERE zone_id=?', zoneId).n, 2);
  assert.throws(() => s.createResource({ zoneId, name: 'Manual', connector: 'TYPE2', powerKw: 22 }), isCode('ZONE_NOT_FOUND'));
  const [r1, r2] = s.all('SELECT id FROM resources WHERE zone_id=? ORDER BY id', zoneId).map(x => x.id);
  assert.throws(() => s.claim(a, r2, {}), isCode('RESOURCE_NOT_FOUND'));
  assert.throws(() => s.setStatus(r2, { status: 'AVAILABLE' }), isCode('RESOURCE_NOT_FOUND'));
  s.favoriteCharger(a, { zoneId, enabled: true });
  s.subscribeZone(watcher, { zoneId, enabled: true });
  s.subscribeZone(both, { zoneId, enabled: true });
  s.subscribePush(both, subscription('mixed-member'));
  sample(2, 1);
  assert.equal(s.me(watcher).notifications.length, 0);
  assert.equal(s.me(both).notifications.length, 1);
  c.metadata.permissions.get('t2').delete('85'); // El emplazamiento sigue autorizado por t1.
  assert.equal(s.claimPush(), null);
  assert.equal(s.me(both).notifications.length, 0);
  assert.deepEqual(s.me(a).favorites, [zoneId]);
  assert.deepEqual(s.me(a).subscriptions, []);
  c.metadata.permissions.get('t2').add('85');
  sample(2, 2); s.tick();
  const first = s.join(a, { zoneId, connector: 'ANY' }).queue;
  const second = s.join(both, { zoneId, connector: 'ANY' }).queue;
  const third = s.join(b, { zoneId, connector: 'ANY' }).queue;
  assert.equal(first.state, 'WAITING');
  assert.equal(second.peopleAhead, 1);
  assert.equal(second.estimatedTurnAt, null);
  assert.equal(third.peopleAhead, 1); // t1-only first driver isn't ahead of someone who only sees t2.
  sample(2, 1);
  const offer = s.me(both).queue;
  assert.equal(offer.id, second.id);
  assert.equal(offer.resourceId, r2);
  assert.match(offer.resourceName, /privado B/);
  assert.equal(s.me(a).queue.state, 'WAITING');
  assert.equal(s.me(b).queue.state, 'WAITING');
  c.metadata.permissions.get('t2').delete('85');
  const revoked = s.me(both).queue;
  assert.equal(revoked.reason, 'ACCESS_REVOKED');
  assert.equal(revoked.resourceId, null);
  assert.equal(revoked.resourceName, null);
  assert.equal(s.me(b).queue.resourceId, r2);
  sample(1, 1);
  assert.equal(s.me(a).queue.resourceId, r1);
  assert.deepEqual(s.zones(), { zones: [] });
});

test('una observación con dos terminales libres produce un solo aviso de ubicación por cuenta', t => {
  const f = fixture(t), s = f.service, driver = member(f, '42');
  const { c, sample } = testCatalog(f, { t1: ['42'], t2: ['42'] });
  s.catalog = c;
  sample(2, 2);
  const [{ zoneId }] = s.privateChargers(driver).sites;
  s.subscribeZone(driver, { zoneId, enabled: true });
  sample(1, 1);
  assert.equal(s.me(driver).notifications.length, 1);
  assert.match(s.me(driver).notifications[0].body, /ubicación que sigues/);
  assert.equal(s.me(driver).queue, null);
  sample(1, 1);
  assert.equal(s.me(driver).notifications.length, 1);
});

test('migración SQLite v5 agrupa en sitio sin perder favoritos, turnos vigentes ni recursos', t => {
  const f = fixture(t), driver = member(f, '42'), waiting = member(f, '84');
  const [old1, old2] = [f.zone(), f.zone()];
  const [r1, r2] = [f.resource(old1), f.resource(old2)];
  f.available(r1);
  const offer = f.service.join(driver, { zoneId: old1, connector: 'ANY', plannedMinutes: 25 }).queue;
  const previous = f.service.accept(driver, offer.id).queue;
  const next = f.service.join(waiting, { zoneId: old2, connector: 'ANY' }).queue;
  // Restaurar la estructura exacta de v5 solo en la base temporal.
  f.db.exec(`DROP VIEW private_provider_zones; DROP TABLE provider_zone_aliases; DROP TABLE provider_sites;
    DROP TABLE charger_favorites; DROP TABLE provider_zones; DROP TABLE remote_charge_attempts; DROP TABLE remote_charge_lifecycle;
    CREATE TABLE provider_zones (zone_id INTEGER PRIMARY KEY REFERENCES zones(id), terminal_key TEXT NOT NULL UNIQUE,
      resource_id INTEGER NOT NULL UNIQUE REFERENCES resources(id), free_after INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE charger_favorites (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      zone_id INTEGER NOT NULL REFERENCES provider_zones(zone_id) ON DELETE CASCADE, PRIMARY KEY (user_id,zone_id)) STRICT;
    PRAGMA user_version=5;`);
  for (const [old, resource, key] of [[old1, r1, 't1'], [old2, r2, 't2']]) {
    f.db.prepare('INSERT INTO provider_zones(zone_id,terminal_key,resource_id) VALUES (?,?,?)').run(old, key, resource);
    f.db.prepare('INSERT INTO charger_favorites VALUES (?,?)').run(driver, old);
    f.db.prepare('INSERT INTO subscriptions VALUES (?,?)').run(driver, old);
  }
  f.reopen();
  assert.deepEqual(f.service.zones(), { zones: [] }); // Incluso antes de que el catálogo identifique las ubicaciones.
  const { c, sample } = testCatalog(f, { t1: ['42'], t2: ['42', '84'] });
  f.service.catalog = c;
  sample(1, 2);
  const restored = f.service.me(driver); // El worker reconcilia sin depender de GET /chargers.
  const [zoneId] = restored.favorites;
  assert.notEqual(zoneId, old1);
  assert.notEqual(zoneId, old2);
  assert.deepEqual(restored.favorites, [zoneId]);
  assert.deepEqual(restored.subscriptions, [zoneId]);
  assert.equal(restored.queue.id, previous.id);
  assert.equal(restored.queue.state, 'ACCEPTED');
  assert.equal(restored.queue.resourceId, r1);
  assert.equal(restored.queue.arrivalExpiresAt, previous.arrivalExpiresAt);
  assert.equal(restored.queue.plannedMinutes, 25);
  assert.equal(f.service.me(waiting).queue.id, next.id);
  assert.equal(f.service.me(waiting).queue.zoneId, zoneId);
  assert.equal(f.service.me(waiting).queue.state, 'WAITING');
  assert.equal(f.service.privateChargers(driver).sites[0].zoneId, zoneId);
  assert.equal(f.service.join(driver, { zoneId: old2, connector: 'ANY' }).queue.id, previous.id);
  assert.throws(() => f.service.join(waiting, { zoneId: old1, connector: 'ANY' }), isCode('ZONE_NOT_FOUND'));
  f.service.favoriteCharger(driver, { zoneId: old2, enabled: false });
  assert.deepEqual(f.service.me(driver).favorites, []);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  f.reopen(); f.service.catalog = c;
  assert.equal(f.service.privateChargers(driver).sites[0].zoneId, zoneId);
  sample(1, 1);
  assert.equal(f.service.me(waiting).queue.resourceId, r2);
  assert.deepEqual(f.service.zones(), { zones: [] });
});
