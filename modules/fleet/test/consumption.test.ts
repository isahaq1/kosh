/**
 * Fleet's arithmetic without a database (RFC 0038): kilometres per litre between full tanks, and a paper's status
 * on a day.
 */
import { expect, test } from 'vitest';
import { kmPerLitre, measured } from '../src/consumption.js';
import { paperStatus } from '../src/module.js';

const fill = (km: number, litres: number, full = true) => ({
  odometer: km * 1000,
  volume: litres * 1000,
  full,
});

test('kilometres per litre: between the first full tank and the last', () => {
  // Nothing to measure with one full tank, or none.
  expect(kmPerLitre([])).toBeNull();
  expect(kmPerLitre([fill(41200, 48)])).toBeNull();
  expect(kmPerLitre([fill(41200, 48, false), fill(41680, 45, false)])).toBeNull();
  // 950 km on the 45 + 44 litres put in after the first fill.
  const three = [fill(41200, 48), fill(41680, 45), fill(42150, 44)];
  expect(measured(three)).toEqual({ distance: 950_000, volume: 89_000 });
  expect(kmPerLitre(three)).toBe('10.67');
  // In whatever order they were typed.
  expect(kmPerLitre([three[2], three[0], three[1]] as typeof three)).toBe('10.67');
});

test('a partial fill between two full tanks counts; one after the last full tank does not yet', () => {
  const withPartial = [fill(41200, 48), fill(41680, 45), fill(41900, 20, false), fill(42150, 44)];
  expect(kmPerLitre(withPartial)).toBe('8.72');
  expect(kmPerLitre([...withPartial, fill(42400, 15, false)])).toBe('8.72');
  // Before the first full tank, what was in the tank is unknown: left out.
  expect(kmPerLitre([fill(41000, 10, false), ...withPartial])).toBe('8.72');
});

test('a paper’s status follows the calendar', () => {
  expect(paperStatus('2026-12-31', 30, '2026-11-27')).toBe('valid');
  expect(paperStatus('2026-12-27', 30, '2026-11-27')).toBe('expiring');
  expect(paperStatus('2026-11-27', 30, '2026-11-27')).toBe('expiring');
  expect(paperStatus('2026-11-26', 30, '2026-11-27')).toBe('expired');
  // No reminder days: expiring on its last day only.
  expect(paperStatus('2026-11-28', 0, '2026-11-27')).toBe('valid');
  expect(paperStatus('2026-11-27', 0, '2026-11-27')).toBe('expiring');
});
