import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTurn } from '../src/wait-estimate.mjs';

const now = 1_800_000_000_000;
const min = 60_000;
const request = (id, connector = 'TYPE2', plannedMinutes = null) => ({ id, connector, plannedMinutes });
const space = (id, offsetMinutes, connector = 'TYPE2') => ({
  id, connector, status: 'RECHARGING', observedAt: now - 3_600_000,
  active: { state: 'CHARGING', expectedReleaseAt: offsetMinutes === null ? null : now + offsetMinutes * min },
});
const calculate = (entries, resources, targetId = entries.at(-1)?.id, extra = {}) => estimateTurn({ now, targetId, entries, resources, ...extra });

test('first waiting user gets the declared future release, not its telemetry freshness', () => {
  const result = calculate([request(1)], [space(1, 20)]);
  assert.equal(result.peopleAhead, 0);
  assert.equal(result.estimatedTurnAt, now + 20 * min);
  assert.equal(result.estimateBasis, 'declared');
});

test('counts people ahead by persistent sequence, not client input ordering', () => {
  const result = calculate([request(3), request(1, 'TYPE2', 30), request(2, 'TYPE2', 60)], [space(1, 10)], 3);
  assert.equal(result.peopleAhead, 2);
  // 10 minute release + two declared sessions + two full handoff windows.
  assert.equal(result.estimatedTurnAt, now + (10 + 30 + 60 + 24) * min);
});

test('two spaces run in parallel rather than summing all wait durations', () => {
  const result = calculate([request(1, 'TYPE2', 60), request(2), request(3)], [space(1, 10), space(2, 20)], 2);
  assert.equal(result.peopleAhead, 1);
  assert.equal(result.estimatedTurnAt, now + 20 * min);
});

test('connector-specific queue can advance independently of incompatible requests', () => {
  const result = calculate([request(1, 'CCS2', 60), request(2, 'TYPE2')], [space(1, 20, 'CCS2'), space(2, 10, 'TYPE2')]);
  assert.equal(result.peopleAhead, 1);
  assert.equal(result.estimatedTurnAt, now + 10 * min);
});

test('ANY consumes the earliest compatible lane in FIFO order', () => {
  const result = calculate([request(1, 'ANY', 30), request(2, 'TYPE2')], [space(1, 10, 'TYPE2'), space(2, 20, 'CCS2')]);
  assert.equal(result.estimatedTurnAt, now + (10 + 30 + 12) * min);
});

test('fresh unassigned AVAILABLE can be offered now', () => {
  assert.equal(calculate([request(1)], [{ id: 1, connector: 'TYPE2', status: 'AVAILABLE', observedAt: now }]).estimatedTurnAt, now);
});

test('stale, unknown, busy and future-dated observations never mean free', () => {
  for (const status of ['UNKNOWN', 'BUSY', 'MAINTENANCE', 'RESERVED', 'STALE', 'RECHARGING']) {
    assert.equal(calculate([request(1)], [{ id: 1, connector: 'TYPE2', status, observedAt: now }]).estimatedTurnAt, null);
  }
  for (const observedAt of [now - 300_000, now - 400_000, now + 1000, null]) {
    assert.equal(calculate([request(1)], [{ id: 1, connector: 'TYPE2', status: 'AVAILABLE', observedAt }]).estimatedTurnAt, null);
  }
});

test('missed or absent release estimate keeps the occupied lane unknown', () => {
  for (const minutes of [null, 0, -10]) {
    const result = calculate([request(1)], [space(1, minutes)]);
    assert.equal(result.estimatedTurnAt, null);
    assert.equal(result.estimateReason, 'missing_release_estimate');
  }
});

test('unknown earlier duration never gets a fabricated 60-minute default', () => {
  for (const plannedMinutes of [null, undefined, 0, -1, 721, 1.5, '60', Infinity]) {
    const result = calculate([request(1, 'TYPE2', plannedMinutes), request(2)], [space(1, 10)]);
    assert.equal(result.estimatedTurnAt, null);
    assert.equal(result.estimateReason, 'missing_duration');
  }
});

test('another known lane permits an explicitly partial estimate', () => {
  const result = calculate([request(1), request(2)], [space(1, 10), space(2, 20)]);
  assert.equal(result.estimatedTurnAt, now + 20 * min);
  assert.equal(result.estimateReason, 'partial_declared_schedule');
});

test('OFFERED and ACCEPTED occupants include their actual remaining windows', () => {
  const resource = { id: 1, connector: 'TYPE2', status: 'AVAILABLE', observedAt: now,
    active: { state: 'OFFERED', expiresAt: now + 90_000, plannedMinutes: 30 } };
  assert.equal(calculate([request(1)], [resource]).estimatedTurnAt, now + 90_000 + 600_000 + 30 * min);
  resource.active = { state: 'ACCEPTED', arrivalExpiresAt: now + 240_000, plannedMinutes: 30 };
  assert.equal(calculate([request(1)], [resource]).estimatedTurnAt, now + 240_000 + 30 * min);
});

test('active offers without duration or already elapsed never become free estimates', () => {
  for (const active of [
    { state: 'OFFERED', expiresAt: now + 1000 },
    { state: 'OFFERED', expiresAt: now - 1000, plannedMinutes: 30 },
    { state: 'ACCEPTED', arrivalExpiresAt: now - 1000, plannedMinutes: 30 },
    { state: 'INVALID' },
  ]) assert.equal(calculate([request(1)], [{ id: 1, connector: 'TYPE2', status: 'AVAILABLE', observedAt: now, active }]).estimatedTurnAt, null);
});

test('no compatible hardware and absent target have explicit reasons', () => {
  assert.equal(calculate([request(1)], [space(1, 10, 'CCS2')]).estimateReason, 'no_compatible_space');
  assert.equal(calculate([request(1)], [space(1, 10)], 99).estimateReason, 'not_waiting');
});

test('uses configured windows, without mutating any caller-owned input', () => {
  const entries = Object.freeze([Object.freeze(request(1, 'TYPE2', 10)), Object.freeze(request(2))]);
  const resources = Object.freeze([Object.freeze({ ...space(1, 5), active: Object.freeze(space(1, 5).active) })]);
  const before = JSON.stringify({ entries, resources });
  assert.equal(calculate(entries, resources, 2, { offerSeconds: 30, arrivalSeconds: 90 }).estimatedTurnAt, now + 17 * min);
  assert.equal(JSON.stringify({ entries, resources }), before);
});

test('rejects an invalid server clock or timing windows', () => {
  assert.throws(() => estimateTurn({ now: NaN }), TypeError);
  assert.throws(() => estimateTurn({ now, offerSeconds: -1 }), TypeError);
});
