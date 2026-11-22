import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingScenario } from '../public/charging-estimate.js';

test('full and partial charge scenarios use the declared average power', () => {
  assert.deepEqual(chargingScenario(60, 0, 100, 7.5), { energyKwh: 60, minutes: 480 });
  assert.deepEqual(chargingScenario(60, 20, 80, 7.5), { energyKwh: 36, minutes: 288 });
});

test('unknown power and invalid battery percentages yield no estimate', () => {
  for (const values of [[60, 0, 100, NaN], [60, 80, 20, 7], [60, 0, 101, 7], [60, 0, 100, 0]]) {
    assert.equal(chargingScenario(...values), null);
  }
});
