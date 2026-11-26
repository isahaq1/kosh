/**
 * Fuel arithmetic without a database (RFC 0038, Fleet): kilometres per litre by the full-tank method. Between two
 * fills that filled the tank, the vehicle burnt exactly what was put in after the first, up to and including the
 * second — whatever partial fills came in between. Fills before the first full tank, and after the last, say
 * nothing yet.
 *
 * Distances are in metres and volumes in millilitres (integers), so nothing drifts.
 */

export interface Fill {
  /** The odometer when filling, in metres. */
  readonly odometer: number;
  /** What was put in, in millilitres. */
  readonly volume: number;
  /** Whether the tank was filled to the top. */
  readonly full: boolean;
}

/** The distance and the fuel that can be set against each other, from the first full tank to the last. */
export function measured(fills: readonly Fill[]): { distance: number; volume: number } {
  const ordered = [...fills].sort((a, b) => a.odometer - b.odometer);
  const first = ordered.findIndex((f) => f.full);
  let last = -1;
  for (let i = ordered.length - 1; i > first; i -= 1)
    if (ordered[i]?.full === true) {
      last = i;
      break;
    }
  if (first < 0 || last < 0) return { distance: 0, volume: 0 };
  let volume = 0;
  for (let i = first + 1; i <= last; i += 1) volume += ordered[i]?.volume ?? 0;
  return {
    distance: (ordered[last]?.odometer ?? 0) - (ordered[first]?.odometer ?? 0),
    volume,
  };
}

/** Kilometres per litre to two places, as text; `null` while two full tanks have not been seen. */
export function kmPerLitre(fills: readonly Fill[]): string | null {
  const { distance, volume } = measured(fills);
  if (distance <= 0 || volume <= 0) return null;
  // (metres / 1000) / (millilitres / 1000) = metres / millilitres.
  return (Math.round((distance / volume) * 100) / 100).toFixed(2);
}
