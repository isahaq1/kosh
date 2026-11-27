/**
 * Rental arithmetic without a database (RFC 0038, Rental): how many units — hours or days — a period comes to,
 * how many a late return adds, and what is free of a product over a period given what is booked.
 */

export type RentUnit = 'hour' | 'day';

const MS: Readonly<Record<RentUnit, number>> = { hour: 3_600_000, day: 86_400_000 };

/** The units a period is charged for: every unit begun counts, and there is always one. */
export function unitsOf(start: number, end: number, unit: RentUnit): number {
  return Math.max(1, Math.ceil((end - start) / MS[unit]));
}

/** The units a return is late by: none on time, every unit begun after that. */
export function lateUnits(due: number, returned: number, unit: RentUnit): number {
  return returned <= due ? 0 : Math.ceil((returned - due) / MS[unit]);
}

/** What is booked of a product over a period: a quantity from `start` until `end`. */
export interface Booking {
  readonly start: number;
  readonly end: number;
  readonly quantity: number;
}

/**
 * The most that is out at once during `[start, end)`, given the bookings: a booking that ends when another
 * starts does not overlap it.
 */
export function peakBooked(bookings: readonly Booking[], start: number, end: number): number {
  const events: [number, number][] = [];
  for (const b of bookings) {
    if (b.end <= start || b.start >= end) continue;
    events.push([Math.max(b.start, start), b.quantity], [Math.min(b.end, end), -b.quantity]);
  }
  // Returns before pick-ups at the same instant.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let peak = 0;
  for (const [, change] of events) {
    now += change;
    if (now > peak) peak = now;
  }
  return peak;
}
