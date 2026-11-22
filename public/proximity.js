export function validCoordinates(point) {
  return Number.isFinite(point?.latitude) && Math.abs(point.latitude) <= 90 &&
    Number.isFinite(point?.longitude) && Math.abs(point.longitude) <= 180;
}

export function distanceMeters(origin, destination) {
  if (!validCoordinates(origin) || !validCoordinates(destination)) return null;
  const radians = Math.PI / 180;
  const a = Math.sin((destination.latitude - origin.latitude) * radians / 2) ** 2 +
    Math.cos(origin.latitude * radians) * Math.cos(destination.latitude * radians) *
    Math.sin((destination.longitude - origin.longitude) * radians / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

export function byProximity(items, origin) {
  if (!validCoordinates(origin)) return items;
  return items.map(item => ({ item, distance: distanceMeters(origin, item) ?? Infinity }))
    .sort((a, b) => a.distance - b.distance).map(({ item }) => item);
}
