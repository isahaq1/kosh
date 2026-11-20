/**
 * The live chat engine (RFC 0034 §2.6) without a database: who is there, who gets the next conversation, what a
 * message is kept as, and what time does to a conversation nobody tends.
 */
import { expect, test } from 'vitest';
import {
  cleanText,
  firstName,
  isThere,
  MAX_MESSAGE,
  type Operator,
  overdue,
  PRESENCE_TTL_MS,
  pickOperator,
  waited,
} from '../src/engine.js';

const NOW = Date.UTC(2026, 10, 20, 10, 0, 0);
const op = (id: number, over: Partial<Operator> = {}): Operator => ({
  id,
  there: true,
  open: 0,
  lastAssignedAt: null,
  ...over,
});

test('an operator is there when they said so and their inbox was open a moment ago', () => {
  expect(isThere({ available: true, seenAt: NOW - 10_000 }, NOW)).toBe(true);
  expect(isThere({ available: true, seenAt: NOW - PRESENCE_TTL_MS }, NOW)).toBe(true);
  expect(isThere({ available: true, seenAt: NOW - PRESENCE_TTL_MS - 1 }, NOW)).toBe(false);
  // They said no, or their inbox was never open.
  expect(isThere({ available: false, seenAt: NOW }, NOW)).toBe(false);
  expect(isThere({ available: true, seenAt: null }, NOW)).toBe(false);
  // A clock far ahead is not a presence.
  expect(isThere({ available: true, seenAt: NOW + 10 * PRESENCE_TTL_MS }, NOW)).toBe(false);
});

test('in turn: the one who waited longest for a conversation, among those who are there and free', () => {
  const team = [
    op(1, { lastAssignedAt: NOW - 1000 }),
    op(2, { lastAssignedAt: NOW - 5000 }),
    op(3, { lastAssignedAt: NOW - 9000, there: false }),
  ];
  expect(pickOperator(team, 'turn', 3)).toBe(2);
  // Never given one: first, and the lower id of two.
  expect(pickOperator([...team, op(5), op(4)], 'turn', 3)).toBe(4);
  // At the limit: passed over.
  expect(
    pickOperator([op(1, { open: 3 }), op(2, { open: 2, lastAssignedAt: NOW })], 'turn', 3),
  ).toBe(2);
});

test('to the least busy, then in turn; nobody when all are away or full; by hand gives to nobody', () => {
  const team = [
    op(1, { open: 2, lastAssignedAt: NOW - 9000 }),
    op(2, { open: 1, lastAssignedAt: NOW - 1000 }),
    op(3, { open: 1, lastAssignedAt: NOW - 5000 }),
  ];
  expect(pickOperator(team, 'load', 3)).toBe(3);
  expect(pickOperator(team, 'turn', 3)).toBe(1);
  expect(pickOperator([op(1, { there: false }), op(2, { open: 3 })], 'load', 3)).toBeNull();
  expect(pickOperator([], 'turn', 3)).toBeNull();
  expect(pickOperator(team, 'manual', 3)).toBeNull();
  // A limit below one still lets a free operator take one.
  expect(pickOperator([op(1)], 'turn', 0)).toBe(1);
});

test('what was typed is kept as text: no control characters, line ends alike, trimmed, cut', () => {
  expect(cleanText('  Hello\r\nthere\t!  ')).toBe('Hello\nthere !');
  expect(cleanText('a\n\n\n\n\nb')).toBe('a\n\nb');
  expect(cleanText('zero\u0000width\u0007bell line')).toBe('zerowidthbellline');
  // Markup is text like any other: the page writes it as text.
  expect(cleanText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  expect(cleanText('আপনি কি ডেলিভারি দেন?')).toBe('আপনি কি ডেলিভারি দেন?');
  expect(cleanText('x'.repeat(MAX_MESSAGE + 50))).toHaveLength(MAX_MESSAGE);
  expect(cleanText('   \n\t ')).toBe('');
  for (const nothing of [null, undefined, 12, {}, ['a']]) expect(cleanText(nothing)).toBe('');
});

test('a visitor sees the operator by their first name', () => {
  expect(firstName('Dina Rahman')).toBe('Dina');
  expect(firstName('  Rahim  ')).toBe('Rahim');
  expect(firstName('')).toBe('');
  expect(firstName(null)).toBe('');
});

test('left alone: a waiting conversation is missed, a quiet one closed, an ended one stays', () => {
  const limits = { missAfterMin: 10, closeAfterMin: 30 };
  const min = 60_000;
  expect(overdue({ state: 'waiting', lastAt: NOW - 9 * min }, NOW, limits)).toBeNull();
  expect(overdue({ state: 'waiting', lastAt: NOW - 10 * min }, NOW, limits)).toBe('miss');
  expect(overdue({ state: 'active', lastAt: NOW - 29 * min }, NOW, limits)).toBeNull();
  expect(overdue({ state: 'active', lastAt: NOW - 30 * min }, NOW, limits)).toBe('close');
  expect(overdue({ state: 'closed', lastAt: NOW - 900 * min }, NOW, limits)).toBeNull();
  expect(overdue({ state: 'missed', lastAt: NOW - 900 * min }, NOW, limits)).toBeNull();
});

test('the wait is from the first message to the first answer, never below zero', () => {
  expect(waited(NOW, NOW + 41_400)).toBe(41);
  expect(waited(NOW, NOW - 5000)).toBe(0);
});
