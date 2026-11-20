/**
 * Which rate an hour is billed at (RFC 0034 §2.5), without a database: the most specific line of the card wins.
 */
import { expect, test } from 'vitest';
import { type RateLine, rateFor } from '../src/rates.js';

const RAFI = 1;
const SUMI = 2;
const SENIOR = 10;
const JUNIOR = 11;
const DESIGN = 20;
const TRAVEL = 21;

const card: readonly RateLine[] = [
  { user: null, role: null, category: TRAVEL, rate: '500.00' },
  { user: null, role: SENIOR, category: null, rate: '3000.00' },
  { user: null, role: SENIOR, category: DESIGN, rate: '3500.00' },
  { user: RAFI, role: null, category: null, rate: '4000.00' },
  { user: RAFI, role: null, category: TRAVEL, rate: '800.00' },
];

test('a person before a role, a role before a kind of task; both named wins over one', () => {
  // Rafi has a rate of his own, whatever his role; another for travel.
  expect(rateFor(card, { user: RAFI, role: SENIOR, category: DESIGN }, '1500.00')).toEqual({
    rate: '4000.00',
    source: 'person',
  });
  expect(rateFor(card, { user: RAFI, role: SENIOR, category: TRAVEL }, '1500.00')).toEqual({
    rate: '800.00',
    source: 'person_and_task',
  });
  // Sumi is billed by her role; design work of a senior has its own rate.
  expect(rateFor(card, { user: SUMI, role: SENIOR, category: null }, '1500.00')).toEqual({
    rate: '3000.00',
    source: 'role',
  });
  expect(rateFor(card, { user: SUMI, role: SENIOR, category: DESIGN }, '1500.00')).toEqual({
    rate: '3500.00',
    source: 'role_and_task',
  });
  // A senior travelling: the role's line weighs more than the task's.
  expect(rateFor(card, { user: SUMI, role: SENIOR, category: TRAVEL }, '1500.00')).toEqual({
    rate: '3000.00',
    source: 'role',
  });
  // A junior travelling: only the task's line fits.
  expect(rateFor(card, { user: SUMI, role: JUNIOR, category: TRAVEL }, '1500.00')).toEqual({
    rate: '500.00',
    source: 'task',
  });
});

test('nobody named: the card’s rate for everyone else, and nothing when it has none', () => {
  expect(rateFor(card, { user: SUMI, role: JUNIOR, category: DESIGN }, '1500.00')).toEqual({
    rate: '1500.00',
    source: 'card',
  });
  expect(rateFor(card, { user: SUMI, role: null, category: null }, null)).toBeNull();
  expect(rateFor([], { user: SUMI, role: null, category: null }, '0.00')).toEqual({
    rate: '0.00',
    source: 'card',
  });
});

test('equals: the first in the card’s order; a line that names nothing is not a rate', () => {
  const twice: readonly RateLine[] = [
    { user: null, role: SENIOR, category: null, rate: '100.00' },
    { user: null, role: SENIOR, category: null, rate: '200.00' },
    { user: null, role: null, category: null, rate: '9.00' },
  ];
  expect(rateFor(twice, { user: SUMI, role: SENIOR, category: null }, null)?.rate).toBe('100.00');
  expect(rateFor(twice, { user: SUMI, role: JUNIOR, category: null }, null)).toBeNull();
});
