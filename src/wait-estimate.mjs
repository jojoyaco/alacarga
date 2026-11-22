/**
 * A planning estimate, never an availability signal or a reservation.
 * Only declared, future release times and fresh free resources form lanes.
 * Unknown durations consume a lane rather than inventing a default duration.
 * Inputs contain no user identities and are never mutated.
 */
const connectors = new Set(['TYPE2', 'CCS2', 'CHADEMO', 'SCHUKO']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const compatible = (request, resource) => request === 'ANY' || request === resource;
const duration = minutes => Number.isInteger(minutes) && minutes >= 1 && minutes <= 720
  ? minutes * 60_000 : null;

export function estimateTurn({ now, targetId, entries = [], resources = [], offerSeconds = 120, arrivalSeconds = 600, staleSeconds = 300 }) {
  if (!finite(now) || ![offerSeconds, arrivalSeconds, staleSeconds].every(v => finite(v) && v >= 0)) {
    throw new TypeError('A finite server time and nonnegative windows are required');
  }
  const waiting = entries.slice().sort((a, b) => a.id - b.id);
  const index = waiting.findIndex(entry => entry.id === targetId);
  const absent = reason => ({ peopleAhead: Math.max(0, index), estimatedTurnAt: null, estimateReason: reason, estimateBasis: 'insufficient' });
  if (index < 0) return absent('not_waiting');
  const target = waiting[index];
  const usable = resources.filter(resource => connectors.has(resource.connector));
  const targetResources = usable.filter(resource => compatible(target.connector, resource.connector));
  if (!targetResources.length) return absent('no_compatible_space');
  const handoffMs = (offerSeconds + arrivalSeconds) * 1000;

  const lanes = usable.map(resource => {
    let readyAt = Infinity;
    const active = resource.active;
    if (active?.state === 'CHARGING') {
      // A missed ETA does NOT imply that the driver moved the vehicle.
      if (finite(active.expectedReleaseAt) && active.expectedReleaseAt > now) readyAt = active.expectedReleaseAt;
    } else if (active?.state === 'OFFERED') {
      const planned = duration(active.plannedMinutes);
      if (planned !== null && finite(active.expiresAt) && active.expiresAt > now) {
        readyAt = active.expiresAt + arrivalSeconds * 1000 + planned;
      }
    } else if (active?.state === 'ACCEPTED') {
      const planned = duration(active.plannedMinutes);
      if (planned !== null && finite(active.arrivalExpiresAt) && active.arrivalExpiresAt > now) {
        readyAt = active.arrivalExpiresAt + planned;
      }
    } else if (!active && resource.status === 'AVAILABLE' && finite(resource.observedAt)
      && resource.observedAt <= now && now - resource.observedAt < staleSeconds * 1000) {
      readyAt = now;
    }
    return { id: resource.id, connector: resource.connector, readyAt, missingDuration: false };
  });

  for (const entry of waiting.slice(0, index + 1)) {
    const candidates = lanes.filter(lane => compatible(entry.connector, lane.connector) && Number.isFinite(lane.readyAt));
    candidates.sort((a, b) => a.readyAt - b.readyAt || a.id - b.id);
    const lane = candidates[0];
    if (!lane) {
      if (entry.id === targetId) {
        return absent(lanes.some(l => compatible(target.connector, l.connector) && l.missingDuration)
          ? 'missing_duration' : 'missing_release_estimate');
      }
      // An earlier incompatible request cannot occupy another connector type.
      continue;
    }
    if (entry.id === targetId) {
      const partial = lanes.some(l => compatible(target.connector, l.connector) && !Number.isFinite(l.readyAt));
      return {
        peopleAhead: index,
        estimatedTurnAt: Math.max(now, lane.readyAt),
        estimateReason: partial ? 'partial_declared_schedule' : 'declared_schedule',
        estimateBasis: 'declared',
      };
    }
    const planned = duration(entry.plannedMinutes);
    if (planned === null) {
      lane.readyAt = Infinity;
      lane.missingDuration = true;
    } else {
      lane.readyAt = Math.max(now, lane.readyAt) + handoffMs + planned;
    }
  }
  return absent('not_waiting');
}
