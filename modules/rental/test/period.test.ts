/**
 * Rental's arithmetic without a database (RFC 0038): the units of a period, the units a return is late by, and
 * the most that is out at once.
 */
import { expect, test } from 'vitest';
import { lateUnits, peakBooked, unitsOf } from '../src/period.js';

const H = 3_600_000;
const D = 24 * H;

test('every unit begun counts, and there is always one', () => {
  expect(unitsOf(0, 4 * H, 'hour')).toBe(4);
  expect(unitsOf(0, 4 * H + 1, 'hour')).toBe(5);
  expect(unitsOf(0, 2 * D, 'day')).toBe(2);
  expect(unitsOf(0, 2 * D + H, 'day')).toBe(3);
  // An hour of a day product is a day.
  expect(unitsOf(0, H, 'day')).toBe(1);
  expect(unitsOf(0, 0, 'hour')).toBe(1);
});

test('a return on time is not late; after that every unit begun is', () => {
  expect(lateUnits(10 * H, 10 * H, 'hour')).toBe(0);
  expect(lateUnits(10 * H, 9 * H, 'hour')).toBe(0);
  expect(lateUnits(10 * H, 10 * H + 1, 'hour')).toBe(1);
  expect(lateUnits(10 * H, 12 * H + 1, 'hour')).toBe(3);
  expect(lateUnits(D, D + H, 'day')).toBe(1);
});

test('the most out at once over a period', () => {
  const bookings = [
    { start: 0, end: 4 * H, quantity: 2 },
    { start: 2 * H, end: 6 * H, quantity: 1 },
    { start: 6 * H, end: 8 * H, quantity: 3 },
  ];
  expect(peakBooked(bookings, 0, 8 * H)).toBe(3);
  // Two overlap between the second and the fourth hour.
  expect(peakBooked(bookings, 3 * H, 5 * H)).toBe(3);
  expect(peakBooked(bookings, 4 * H, 6 * H)).toBe(1);
  // One ends as the other starts: they do not overlap.
  expect(peakBooked(bookings, 5 * H, 7 * H)).toBe(3);
  expect(peakBooked(bookings, 8 * H, 9 * H)).toBe(0);
  expect(peakBooked([], 0, H)).toBe(0);
  // Something late has no end until it is back: it counts for every later period.
  expect(
    peakBooked([{ start: 0, end: Number.POSITIVE_INFINITY, quantity: 2 }], 100 * H, 101 * H),
  ).toBe(2);
});
