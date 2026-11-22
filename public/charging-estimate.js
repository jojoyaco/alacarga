// A scenario, not a promise: effective power can change and the driver may stay parked.
export function chargingScenario(capacityKwh, fromPercent, toPercent, effectiveKw) {
  if (![capacityKwh, fromPercent, toPercent, effectiveKw].every(Number.isFinite) ||
      capacityKwh <= 0 || capacityKwh > 1000 || fromPercent < 0 || toPercent > 100 ||
      fromPercent >= toPercent || effectiveKw <= 0 || effectiveKw > 1000) return null;
  const energyKwh = capacityKwh * (toPercent - fromPercent) / 100;
  return { energyKwh, minutes: Math.ceil(energyKwh / effectiveKw * 60 - 1e-9) };
}
