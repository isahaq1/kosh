/**
 * Depreciation boards (RFC 0024 §2.5), without a database: straight line in full months and with a prorated first
 * month; declining balance switching to straight line and ending at the salvage value; units of production capped
 * at what remains; and the tax book's reducing balance.
 */
import { orm } from '@kosh/server/orm';
import { describe, expect, test } from 'vitest';
import { board, taxBook, unitsLine } from '../src/board.js';

const d = orm.toDecimal;
const sum = (lines: { amount: { toString(): string } }[]) =>
  lines.reduce((s, l) => s.plus(l.amount.toString()), d(0)).toString();

describe('straight line', () => {
  test('120 000 over twelve months from the 1st: 10 000 a month, to the year’s end', () => {
    const lines = board({
      bookValue: d('120000'),
      salvage: d(0),
      method: 'linear',
      months: 12,
      rate: d(0),
      from: '2026-01-01',
      prorata: true,
    });
    expect(lines).toHaveLength(12);
    expect(lines.every((l) => l.amount.eq(10000))).toBe(true);
    expect(lines.at(-1)?.date).toBe('2026-12-31');
    expect(lines.at(-1)?.remaining.toString()).toBe('0');
  });
  test('in use from the 16th: sixteen days of January, eleven full months, the rest in the thirteenth', () => {
    const lines = board({
      bookValue: d('120000'),
      salvage: d(0),
      method: 'linear',
      months: 12,
      rate: d(0),
      from: '2026-01-16',
      prorata: true,
    });
    expect(lines).toHaveLength(13);
    expect(lines[0]?.amount.toString()).toBe('5161.29'); // 10 000 × 16 / 31
    expect(lines.at(-1)?.amount.toString()).toBe('4838.71');
    expect(lines.at(-1)?.date).toBe('2027-01-31');
    expect(sum(lines)).toBe('120000');
  });
});

describe('declining balance', () => {
  test('30% a year on what remains, then straight line, ending at the salvage value', () => {
    const lines = board({
      bookValue: d('100000'),
      salvage: d('10000'),
      method: 'degressive',
      months: 60,
      rate: d('30'),
      from: '2026-01-01',
      prorata: false,
    });
    expect(lines).toHaveLength(60);
    expect(lines[0]?.amount.toString()).toBe('2500'); // 100 000 × 30% ÷ 12, above 90 000 ÷ 60
    expect(lines[1]?.amount.lt(lines[0]?.amount ?? 0)).toBe(true); // on what remains
    expect(lines.at(-1)?.remaining.toString()).toBe('10000');
    expect(sum(lines)).toBe('90000');
    // At the end the straight line over the months left is more: the amounts stop falling (a cent of rounding).
    const [a, b] = [lines.at(-3)?.amount, lines.at(-2)?.amount];
    expect(Math.abs(Number(a?.minus(b ?? 0)))).toBeLessThanOrEqual(0.01);
  });
});

describe('units of production and the tax book', () => {
  test('a month’s units at the depreciable amount per unit, never past what remains', () => {
    const base = { cost: d('100000'), salvage: d('10000'), totalUnits: d('9000') };
    expect(unitsLine({ ...base, units: d('900'), depreciated: d(0) }).toString()).toBe('9000');
    expect(unitsLine({ ...base, units: d('900'), depreciated: d('85000') }).toString()).toBe(
      '5000',
    );
  });
  test('reducing balance at 20% a year from the year of acquisition', () => {
    const years = taxBook({
      cost: d('100000'),
      rate: d('20'),
      acquiredYear: 2024,
      throughYear: 2026,
    });
    expect(years.map((y) => [y.year, y.depreciation.toString(), y.closing.toString()])).toEqual([
      [2024, '20000', '80000'],
      [2025, '16000', '64000'],
      [2026, '12800', '51200'],
    ]);
  });
});
