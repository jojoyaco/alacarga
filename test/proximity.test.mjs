import test from 'node:test';
import assert from 'node:assert/strict';
import { byProximity, distanceMeters } from '../public/proximity.js';

const origin = { latitude: 0, longitude: 0 };

test('distance accepts zero coordinates and takes the short route across the date line', () => {
  assert.equal(distanceMeters(origin, origin), 0);
  assert.ok(Math.abs(distanceMeters(origin, { latitude: 0, longitude: 1 }) - 111195) < 2);
  assert.ok(distanceMeters({ latitude: 0, longitude: 179.9 }, { latitude: 0, longitude: -179.9 }) < 23000);
  assert.equal(distanceMeters(origin, { latitude: null, longitude: 1 }), null);
  assert.equal(distanceMeters(origin, { latitude: 91, longitude: 1 }), null);
});

test('proximity leaves unknown coordinates last, preserves ties and does not mutate the catalogue', () => {
  const items = Object.freeze([{ id: 1 }, { id: 2, latitude: 0, longitude: 2 }, { id: 3, ...origin }, { id: 4, ...origin }, { id: 5 }]);
  assert.deepEqual(byProximity(items, origin).map(x => x.id), [3, 4, 2, 1, 5]);
  assert.deepEqual(byProximity(items, null).map(x => x.id), [1, 2, 3, 4, 5]);
});
