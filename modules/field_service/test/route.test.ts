/**
 * A technician's day without a database (RFC 0038, Field service): distances, the short order of visits, and what
 * counts as a drawn signature.
 */
import { expect, test } from 'vitest';
import { distanceKm, isSignature, routeOf, SIGNATURE_LIMIT } from '../src/route.js';

const MOTIJHEEL: [number, number] = [23.733, 90.4172];
const GULSHAN: [number, number] = [23.7925, 90.4078];
const BANANI: [number, number] = [23.7937, 90.4066];

test('the distance between two places', () => {
  expect(distanceKm(MOTIJHEEL, MOTIJHEEL)).toBe(0);
  // Motijheel to Gulshan is about 6.7 km as the crow flies.
  expect(distanceKm(MOTIJHEEL, GULSHAN)).toBeGreaterThan(6.4);
  expect(distanceKm(MOTIJHEEL, GULSHAN)).toBeLessThan(7);
  expect(distanceKm(GULSHAN, BANANI)).toBeLessThan(0.3);
  // Dhaka to Chattogram, about 215 km.
  expect(Math.round(distanceKm(MOTIJHEEL, [22.3569, 91.7832]) / 10)).toBe(21);
});

test('the nearest stop next, from where the day starts; those without a place last', () => {
  const stops = [
    { id: 1, latitude: GULSHAN[0], longitude: GULSHAN[1] },
    { id: 2, latitude: null, longitude: null },
    { id: 3, latitude: MOTIJHEEL[0], longitude: MOTIJHEEL[1] },
    { id: 4, latitude: BANANI[0], longitude: BANANI[1] },
  ];
  // From the first located stop: Gulshan, then Banani next door, then Motijheel; the unknown one last.
  const day = routeOf(stops);
  expect(day.map((s) => s.id)).toEqual([1, 4, 3, 2]);
  expect(day[0]?.legKm).toBeNull();
  expect(day[1]?.legKm).toBeLessThan(0.3);
  expect(day[3]?.legKm).toBeNull();
  // Starting from Motijheel instead, Motijheel's visit comes first.
  expect(routeOf(stops, MOTIJHEEL).map((s) => s.id)).toEqual([3, 1, 4, 2]);
  expect(routeOf([])).toEqual([]);
});

test('a signature is a PNG or JPEG data address of a sensible size', () => {
  const png = `data:image/png;base64,${'A'.repeat(100)}`;
  expect(isSignature(png)).toBe(true);
  expect(isSignature(`data:image/jpeg;base64,${'B'.repeat(100)}==`)).toBe(true);
  expect(isSignature('data:image/svg+xml;base64,AAAA')).toBe(false);
  expect(isSignature('data:image/png;base64,AA')).toBe(false);
  expect(isSignature(`data:image/png;base64,${'A'.repeat(100)}<script>`)).toBe(false);
  expect(isSignature(`data:image/png;base64,${'A'.repeat(SIGNATURE_LIMIT)}`)).toBe(false);
  expect(isSignature(42)).toBe(false);
});
