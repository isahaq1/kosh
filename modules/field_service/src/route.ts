/**
 * A technician's day without a database (RFC 0038, Field service): the distance between two places on the
 * Earth, and an order of visits that keeps the driving short — the nearest next stop each time, from where the day
 * starts. Visits without coordinates come last, in their planned order.
 */

export interface Stop {
  readonly id: number;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

const EARTH_KM = 6371;
const rad = (deg: number): number => (deg * Math.PI) / 180;

/** The great-circle distance between two points, in kilometres. */
export function distanceKm(a: [number, number], b: [number, number]): number {
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const h =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const placed = (s: Stop): s is Stop & { latitude: number; longitude: number } =>
  s.latitude !== null && s.longitude !== null;

/**
 * The stops in a short order: from `start` (or the first located stop), each time the nearest one not visited
 * yet; then those without coordinates. Each with the distance from the stop before it (`null` when unknown).
 */
export function routeOf(
  stops: readonly Stop[],
  start: [number, number] | null = null,
): { id: number; legKm: number | null }[] {
  const left = stops.filter(placed);
  const out: { id: number; legKm: number | null }[] = [];
  let here: [number, number] | null = start;
  if (here === null && left.length > 0) {
    const first = left.shift() as Stop & { latitude: number; longitude: number };
    out.push({ id: first.id, legKm: null });
    here = [first.latitude, first.longitude];
  }
  while (left.length > 0 && here !== null) {
    let best = 0;
    let bestKm = Number.POSITIVE_INFINITY;
    for (let i = 0; i < left.length; i += 1) {
      const s = left[i] as Stop & { latitude: number; longitude: number };
      const km = distanceKm(here, [s.latitude, s.longitude]);
      if (km < bestKm) {
        best = i;
        bestKm = km;
      }
    }
    const [next] = left.splice(best, 1) as [Stop & { latitude: number; longitude: number }];
    out.push({ id: next.id, legKm: Math.round(bestKm * 10) / 10 });
    here = [next.latitude, next.longitude];
  }
  for (const s of stops) if (!placed(s)) out.push({ id: s.id, legKm: null });
  return out;
}

/** The longest drawn signature the server keeps, in characters of its data address. */
export const SIGNATURE_LIMIT = 300_000;

/** Whether `value` is a drawn signature: a PNG or JPEG data address of a sensible size. */
export function isSignature(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= SIGNATURE_LIMIT &&
    /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) &&
    value.length > 64
  );
}
