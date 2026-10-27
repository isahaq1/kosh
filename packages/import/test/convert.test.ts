/**
 * Cells to values (RFC 0014 §5.1 step 3) and the guessed mapping (step 2).
 */
import { expect, test } from 'vitest';
import {
  type ConvertField,
  convertCell,
  guessMapping,
  parseDate,
  parseDateTime,
  plainNumber,
} from '../src/index.js';

const field = (kind: string, options: [string, string][] | null = null): ConvertField => ({
  key: 'x',
  kind,
  label: 'X',
  options,
});

test('numbers: grouping, the decimal comma, accounting negatives, currency signs, Bangla digits', () => {
  expect(plainNumber('1,234.50', '.')).toBe('1234.50');
  expect(plainNumber('1.234,50', ',')).toBe('1234.50');
  expect(plainNumber('12,5', ',')).toBe('12.5');
  expect(plainNumber('(1,200.00)', '.')).toBe('-1200.00');
  expect(plainNumber('৳ ১২,৫০০', '.')).toBe('12500');
  expect(plainNumber('-0', '.')).toBe('0');
  expect(plainNumber('.5', '.')).toBe('0.5');
  // Not numbers, or ambiguous: errors, never guesses.
  expect(plainNumber('1,5', '.')).toBeNull();
  expect(plainNumber('12abc', '.')).toBeNull();
  expect(plainNumber('1.2.3', '.')).toBeNull();
});

test('decimals stay exact text; integers and floats are numbers; bigints text', () => {
  expect(convertCell(field('monetary'), '1,250.505')).toEqual({ value: '1250.505' });
  expect(convertCell(field('decimal'), 0.1)).toEqual({ value: '0.1' });
  expect(convertCell(field('decimal'), 1e21)).toEqual({ value: '1000000000000000000000' });
  expect(convertCell(field('integer'), '42')).toEqual({ value: 42 });
  expect(convertCell(field('integer'), 4.5)).toMatchObject({ error: { code: 'not-an-integer' } });
  expect(convertCell(field('float'), '2.5')).toEqual({ value: 2.5 });
  expect(convertCell(field('bigint'), '9007199254740993')).toEqual({ value: '9007199254740993' });
  expect(convertCell(field('decimal'), true)).toMatchObject({ error: { code: 'not-a-number' } });
});

test('empty cells are left out', () => {
  expect(convertCell(field('char'), '  ')).toBeUndefined();
  expect(convertCell(field('integer'), null)).toBeUndefined();
});

test('dates: ISO, the day order, two-digit years, impossible days refused', () => {
  expect(parseDate('2026-04-03', 'mdy')).toBe('2026-04-03');
  expect(parseDate('03/04/2026', 'dmy')).toBe('2026-04-03');
  expect(parseDate('03/04/2026', 'mdy')).toBe('2026-03-04');
  expect(parseDate('3.4.26', 'dmy')).toBe('2026-04-03');
  expect(parseDate('2026/4/3', 'dmy')).toBe('2026-04-03');
  expect(parseDate('৩১/১২/২০২৬', 'dmy')).toBe('2026-12-31');
  expect(parseDate('31/02/2026', 'dmy')).toBeNull();
  expect(parseDate('next week', 'dmy')).toBeNull();
  expect(convertCell(field('date'), new Date(Date.UTC(2026, 0, 9)))).toEqual({
    value: '2026-01-09',
  });
});

test('date-times: offsets as given, wall-clock times in the file time zone, 12-hour clocks', () => {
  expect(parseDateTime('2026-04-03T10:00:00Z', 'dmy', 'Asia/Dhaka')?.toISOString()).toBe(
    '2026-04-03T10:00:00.000Z',
  );
  expect(parseDateTime('03/04/2026 16:30', 'dmy', 'Asia/Dhaka')?.toISOString()).toBe(
    '2026-04-03T10:30:00.000Z',
  );
  expect(parseDateTime('03/04/2026 4:30 PM', 'dmy', 'UTC')?.toISOString()).toBe(
    '2026-04-03T16:30:00.000Z',
  );
  expect(parseDateTime('03/04/2026', 'dmy', 'UTC')?.toISOString()).toBe('2026-04-03T00:00:00.000Z');
  expect(parseDateTime('03/04/2026 25:00', 'dmy', 'UTC')).toBeNull();
  // A spreadsheet date-time is a wall-clock time too.
  expect(
    convertCell(field('datetime'), new Date(Date.UTC(2026, 3, 3, 16, 30)), {
      timeZone: 'Asia/Dhaka',
    }),
  ).toEqual({ value: new Date('2026-04-03T10:30:00.000Z') });
});

test('booleans in English and Bangla; selections by value or label', () => {
  expect(convertCell(field('boolean'), 'Yes')).toEqual({ value: true });
  expect(convertCell(field('boolean'), 'না')).toEqual({ value: false });
  expect(convertCell(field('boolean'), 1)).toEqual({ value: true });
  expect(convertCell(field('boolean'), 'maybe')).toMatchObject({
    error: { code: 'not-a-boolean' },
  });
  const state = field('selection', [
    ['draft', 'Draft'],
    ['posted', 'Posted'],
  ]);
  expect(convertCell(state, 'posted')).toEqual({ value: 'posted' });
  expect(convertCell(state, 'DRAFT')).toEqual({ value: 'draft' });
  expect(convertCell(state, 'Cancelled')).toEqual({
    error: { code: 'not-an-option', message: 'X: "Cancelled" is not one of Draft, Posted.' },
  });
});

test('the mapping: keys, then labels, ignoring case and punctuation; each field once', () => {
  const fields = [
    { key: 'name', kind: 'char', label: 'Name' },
    { key: 'email', kind: 'char', label: 'Email' },
    { key: 'creditLimit', kind: 'monetary', label: 'Credit limit' },
    { key: 'image', kind: 'binary', label: 'Image' },
  ];
  expect(
    guessMapping(['NAME', 'E-mail', 'credit_limit', 'Image', 'Name', 'Notes'], fields),
  ).toEqual([
    { index: 0, header: 'NAME', field: 'name' },
    { index: 1, header: 'E-mail', field: 'email' },
    { index: 2, header: 'credit_limit', field: 'creditLimit' },
    { index: 3, header: 'Image', field: null },
    { index: 4, header: 'Name', field: null },
    { index: 5, header: 'Notes', field: null },
  ]);
});
