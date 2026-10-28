/**
 * RFC 0018 step 1: typed dates in the user's language, the company's brand colour as the accent (hue and chroma
 * only), state badges by meaning, list footers without "Total Total".
 */
import { describe, expect, test } from 'vitest';
import { accentVariables, hexToOklch } from '../src/lib/accent.js';
import { parseTypedDate } from '../src/views/DateField.js';
import { totalLabel } from '../src/views/ListView.js';
import { toneOf } from '../src/views/widgets.js';

describe('typed dates', () => {
  test('ISO, and day / month / year in the language’s order', () => {
    expect(parseTypedDate('2026-10-28', 'en-GB')).toBe('2026-10-28');
    expect(parseTypedDate('28/10/2026', 'en-GB')).toBe('2026-10-28');
    expect(parseTypedDate('10/28/2026', 'en-US')).toBe('2026-10-28');
    expect(parseTypedDate('28.10.26', 'en-GB')).toBe('2026-10-28');
    expect(parseTypedDate('২৮/১০/২০২৬', 'bn')).toBe('2026-10-28');
  });
  test('impossible or partial dates are refused', () => {
    expect(parseTypedDate('31/02/2026', 'en-GB')).toBeNull();
    expect(parseTypedDate('28/10', 'en-GB')).toBeNull();
    expect(parseTypedDate('soon', 'en-GB')).toBeNull();
    expect(parseTypedDate('', 'en-GB')).toBeNull();
  });
});

describe('the accent', () => {
  test('a brand colour gives its hue and (capped) chroma; none gives the default', () => {
    const indigo = hexToOklch('#4f46e5');
    expect(indigo?.h).toBeGreaterThan(260);
    expect(indigo?.h).toBeLessThan(290);
    expect(hexToOklch('#ffffff')?.l).toBeCloseTo(1, 2);
    expect(hexToOklch('nope')).toBeNull();
    const red = accentVariables('#ff0000');
    expect(Number(red['--accent-h'])).toBeCloseTo(29.2, 0);
    expect(Number(red['--accent-c'])).toBe(0.2); // capped
    expect(accentVariables(null)).toEqual({});
    expect(Number(accentVariables('#808080')['--accent-c'])).toBeLessThan(0.01); // grey stays grey
  });
});

describe('meanings', () => {
  test('badge tones follow what a state means', () => {
    expect(toneOf('posted')).toBe('success');
    expect(toneOf('paid')).toBe('success');
    expect(toneOf('not_paid')).toBe('warning');
    expect(toneOf('to_approve')).toBe('warning');
    expect(toneOf('cancel')).toBe('danger');
    expect(toneOf('sent')).toBe('info');
    expect(toneOf('draft')).toBe('neutral');
  });
  test('sum labels', () => {
    expect(totalLabel('Total', 'Total')).toBe('Total');
    expect(totalLabel('Total', 'Credit limit')).toBe('Total Credit limit');
    expect(totalLabel('মোট', 'মোট পরিমাণ')).toBe('মোট পরিমাণ');
  });
});
