/**
 * The QR and barcode blocks of document layouts, drawn by `isahaq-barcode`: a field's value as an SVG the page
 * sizes, its label; nothing for an empty value. The same content always gives the same code. Barcodes: a retail
 * number is drawn as what it is, anything else — or a number with a wrong check digit — as Code 128.
 */
import { expect, test } from 'vitest';
import {
  barcodeSvg,
  barcodeSymbology,
  type DocumentFields,
  qrSvg,
  renderHtml,
} from '../src/index.js';

const fields: DocumentFields = new Map([
  [
    'event.registration',
    new Map([
      ['code', { label: 'Check-in code', kind: 'char', target: null }],
      ['name', { label: 'Attendee', kind: 'char', target: null }],
    ]),
  ],
]);
const data = (code: string | null) => ({
  model: 'event.registration',
  record: { code, name: 'Nusrat Jahan' },
  company: { name: 'Padma Traders' },
  user: { name: 'Dina' },
  now: new Date('2026-10-31T10:00:00Z'),
});
const FORMAT = { locale: 'en', tz: 'Asia/Dhaka' };

/** The side of the drawing, in its own units: two to a module. */
function box(svg: string): number {
  const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  expect(m?.[1]).toBe(m?.[2]);
  return Number(m?.[1]);
}

test('a QR code as SVG: square, sized by the page, a quiet zone of 4, the same for the same content', () => {
  const svg = qrSvg('A1B2C3D4E5F6');
  // 12 characters at medium correction fit version 1: 21 modules and 4 of quiet zone on each side.
  expect(box(svg) / 2).toBe(21 + 8);
  expect(svg).toContain('role="img" aria-label="QR code"');
  expect(svg).not.toMatch(/<svg[^>]* width=/);
  expect(qrSvg('A1B2C3D4E5F6')).toBe(svg);
  expect(qrSvg('OTHER')).not.toBe(svg);
  // More to say, more modules.
  expect(
    box(qrSvg('https://erp.example.com/pay/9f2c1d7a5b3e4f60a1b2c3d4e5f60718')),
  ).toBeGreaterThan(58);
});

test('the QR block in a layout: sized, labelled; nothing for an empty value', () => {
  const layout = {
    blocks: [
      { kind: 'qr' as const, id: 'ticket', bind: 'code', size: 40, label: 'Show at the door' },
    ],
  };
  const html = renderHtml(layout, data('A1B2C3D4E5F6'), fields, FORMAT);
  expect(html).toContain('<div class="qr" style="width:40mm"><svg');
  expect(html).toContain('Show at the door');
  const empty = renderHtml(layout, data(null), fields, FORMAT);
  expect(empty).not.toContain('<svg');
});

test('the symbology of a value: retail numbers as what they are, the rest as Code 128', () => {
  expect(barcodeSymbology('8941100500019')).toBe('ean13');
  expect(barcodeSymbology('96385074')).toBe('ean8');
  expect(barcodeSymbology('036000291452')).toBe('upca');
  // Thirteen digits that are not an EAN (the check digit is wrong) still scan, as Code 128.
  expect(barcodeSymbology('8941100500012')).toBe('code128');
  expect(barcodeSymbology('SKU-0042/A')).toBe('code128');
  // Asked for an EAN-13 and given letters: Code 128 rather than nothing.
  expect(barcodeSymbology('SKU-0042', 'ean13')).toBe('code128');
  expect(barcodeSymbology('SKU-0042', 'code39')).toBe('code39');
  expect(barcodeSymbology('')).toBeNull();
  // Bangla letters fit no bar code here.
  expect(barcodeSymbology('পণ্য')).toBeNull();
  expect(barcodeSvg('পণ্য')).toBeNull();
});

test('a barcode as SVG: with its value in words unless asked not to, the same for the same content', () => {
  const svg = barcodeSvg('8941100500019');
  expect(svg).toContain('role="img" aria-label="Barcode"');
  expect(svg).not.toMatch(/<svg[^>]* width=/);
  expect(barcodeSvg('8941100500019')).toBe(svg);
  expect(barcodeSvg('8941100500019', { text: false })).not.toBe(svg);
  expect(barcodeSvg('8941100500019', { symbology: 'code128' })).not.toBe(svg);
  // Taller bars, a taller drawing.
  const height = (s: string | null) => Number(/viewBox="0 0 \d+ (\d+)"/.exec(s ?? '')?.[1]);
  expect(height(barcodeSvg('SKU-0042', { height: 120 }))).toBeGreaterThan(
    height(barcodeSvg('SKU-0042', { height: 40 })),
  );
});

test('the barcode block in a layout: sized, labelled; nothing for an empty or unprintable value', () => {
  const layout = {
    blocks: [
      {
        kind: 'barcode' as const,
        id: 'code',
        bind: 'code',
        size: 60,
        height: 18,
        label: 'Scan at the till',
      },
    ],
  };
  const html = renderHtml(layout, data(' SKU-0042 '), fields, FORMAT);
  expect(html).toContain('<div class="qr barcode" style="width:60mm"><svg');
  expect(html).toContain('Scan at the till');
  expect(renderHtml(layout, data(null), fields, FORMAT)).not.toContain('<svg');
  expect(renderHtml(layout, data('পণ্য'), fields, FORMAT)).not.toContain('<svg');
});
