/**
 * The grid's pure parts: clipboard blocks as Excel writes them, texts turned into field values (numbers in any
 * locale, dates, yes/no, a choice by its label, a related record by name), and cells back to clipboard text.
 */
import { describe, expect, test } from 'vitest';
import {
  cellText,
  coerce,
  parseClipboard,
  rangeOf,
  toClipboard,
  type ViewField,
} from '../src/index.js';

const field = (kind: string, extra: Partial<ViewField> = {}): ViewField => ({
  key: 'x',
  kind,
  label: 'X',
  required: false,
  readonly: false,
  ...extra,
});
const messages = (key: string, params?: Record<string, unknown>) =>
  `${key}:${String(params?.['text'] ?? '')}`;
const noResolve = async () => [];

describe('parseClipboard', () => {
  test('tab-separated rows, Windows line ends, a trailing newline, quoted cells', () => {
    expect(parseClipboard('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseClipboard('"two\nlines"\t"say ""hi"""\nx')).toEqual([
      ['two\nlines', 'say "hi"'],
      ['x'],
    ]);
    expect(parseClipboard('')).toEqual([]);
    expect(parseClipboard('single')).toEqual([['single']]);
  });

  test('toClipboard quotes what needs it and round-trips', () => {
    const cells = [
      ['plain', 'with\ttab'],
      ['a "quote"', ''],
    ];
    expect(toClipboard(cells)).toBe('plain\t"with\ttab"\n"a ""quote"""\t');
    expect(parseClipboard(toClipboard(cells))).toEqual(cells);
  });
});

describe('coerce', () => {
  test('numbers in English and continental notation; integers refuse fractions', async () => {
    expect(await coerce(field('decimal'), '1,234.50', noResolve, messages)).toEqual({
      ok: true,
      value: '1234.50',
    });
    expect(await coerce(field('decimal'), '1.234,50', noResolve, messages)).toEqual({
      ok: true,
      value: '1234.50',
    });
    expect(await coerce(field('decimal'), '12,5', noResolve, messages)).toEqual({
      ok: true,
      value: '12.5',
    });
    expect(await coerce(field('integer'), ' 42 ', noResolve, messages)).toEqual({
      ok: true,
      value: 42,
    });
    expect(await coerce(field('integer'), '4.2', noResolve, messages)).toEqual({
      ok: false,
      reason: 'notNumber:4.2',
    });
    expect(await coerce(field('decimal'), 'abc', noResolve, messages)).toEqual({
      ok: false,
      reason: 'notNumber:abc',
    });
    expect(await coerce(field('decimal'), '', noResolve, messages)).toEqual({
      ok: true,
      value: null,
    });
  });

  test('yes/no, dates, a selection by label or value, text', async () => {
    expect(await coerce(field('boolean'), 'Yes', noResolve, messages)).toEqual({
      ok: true,
      value: true,
    });
    expect(await coerce(field('boolean'), 'না', noResolve, messages)).toEqual({
      ok: true,
      value: false,
    });
    expect(await coerce(field('boolean'), 'maybe', noResolve, messages)).toEqual({
      ok: false,
      reason: 'notOption:maybe',
    });
    expect(await coerce(field('date'), '2026-10-25', noResolve, messages)).toEqual({
      ok: true,
      value: '2026-10-25',
    });
    expect(await coerce(field('date'), 'not a date', noResolve, messages)).toEqual({
      ok: false,
      reason: 'notDate:not a date',
    });
    const stage = field('selection', {
      options: [
        { value: 'lead', label: 'Lead' },
        { value: 'customer', label: 'Customer' },
      ],
    });
    expect(await coerce(stage, 'customer', noResolve, messages)).toEqual({
      ok: true,
      value: 'customer',
    });
    expect(await coerce(stage, 'LEAD', noResolve, messages)).toEqual({ ok: true, value: 'lead' });
    expect(await coerce(stage, 'gone', noResolve, messages)).toEqual({
      ok: false,
      reason: 'notOption:gone',
    });
    expect(await coerce(field('char'), 'Dhaka', noResolve, messages)).toEqual({
      ok: true,
      value: 'Dhaka',
    });
    expect(await coerce(field('one2many'), 'x', noResolve, messages)).toEqual({
      ok: false,
      reason: 'notPasteable:',
    });
  });

  test('a related record by name: exact match wins, none or several is refused', async () => {
    const vendor = field('many2one', { target: 'res.partner' });
    const resolve = async (_target: string, q: string) =>
      q === 'Acme'
        ? [
            { id: 1, displayName: 'Acme' },
            { id: 2, displayName: 'Acme Trading' },
          ]
        : q === 'Bengal'
          ? [
              { id: 3, displayName: 'Bengal Steel' },
              { id: 4, displayName: 'Bengal Textiles' },
            ]
          : q === 'Padma'
            ? [{ id: 5, displayName: 'Padma Traders' }]
            : [];
    expect(await coerce(vendor, 'Acme', resolve, messages)).toEqual({ ok: true, value: 1 });
    expect(await coerce(vendor, 'Padma', resolve, messages)).toEqual({ ok: true, value: 5 });
    expect(await coerce(vendor, 'Bengal', resolve, messages)).toEqual({
      ok: false,
      reason: 'ambiguous:Bengal',
    });
    expect(await coerce(vendor, 'Nobody', resolve, messages)).toEqual({
      ok: false,
      reason: 'notFound:Nobody',
    });
  });
});

describe('cellText and ranges', () => {
  test('raw numbers, labels, names and dates for the clipboard', () => {
    const names = (target: string, id: number) =>
      target === 'res.partner' && id === 3 ? 'Bengal Steel' : undefined;
    expect(
      cellText(field('decimal'), { amount: '12.50', currency: 'BDT' }, names, ['Yes', 'No']),
    ).toBe('12.50');
    expect(cellText(field('boolean'), true, names, ['Yes', 'No'])).toBe('Yes');
    expect(cellText(field('many2one', { target: 'res.partner' }), 3, names, ['Yes', 'No'])).toBe(
      'Bengal Steel',
    );
    expect(
      cellText(field('many2one', { target: 'res.partner' }), { id: 9 }, names, ['Yes', 'No']),
    ).toBe('#9');
    expect(cellText(field('date'), '2026-10-25T00:00:00.000Z', names, ['Yes', 'No'])).toBe(
      '2026-10-25',
    );
    expect(cellText(field('char'), null, names, ['Yes', 'No'])).toBe('');
  });

  test('rangeOf normalizes corners', () => {
    expect(rangeOf({ row: 5, col: 2 }, { row: 1, col: 4 })).toEqual({
      top: 1,
      left: 2,
      bottom: 5,
      right: 4,
    });
  });
});
