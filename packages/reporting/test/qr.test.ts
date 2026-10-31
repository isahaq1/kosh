/**
 * The QR block of document layouts: a field's value drawn as an SVG QR code (dark modules in one path, a quiet zone),
 * its size and label; nothing for an empty value. The same content always gives the same code.
 */
import QRCode from 'qrcode';
import { expect, test } from 'vitest';
import { type DocumentFields, qrSvg, renderHtml } from '../src/index.js';

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

test('a QR code as SVG: the modules of the content, with a quiet zone', () => {
  const svg = qrSvg('A1B2C3D4E5F6');
  const { modules } = QRCode.create('A1B2C3D4E5F6', { errorCorrectionLevel: 'M' });
  expect(svg).toContain(`viewBox="0 0 ${modules.size + 8} ${modules.size + 8}"`);
  const dark = Array.from(modules.data).filter(Boolean).length;
  expect(svg.match(/h1v1h-1z/g)?.length).toBe(dark);
  expect(qrSvg('A1B2C3D4E5F6')).toBe(svg);
  expect(qrSvg('OTHER')).not.toBe(svg);
});

test('the QR block in a layout: sized, labelled; nothing for an empty value', () => {
  const layout = {
    blocks: [
      { kind: 'qr' as const, id: 'ticket', bind: 'code', size: 40, label: 'Show at the door' },
    ],
  };
  const html = renderHtml(layout, data('A1B2C3D4E5F6'), fields, { locale: 'en', tz: 'Asia/Dhaka' });
  expect(html).toContain('<div class="qr" style="width:40mm"><svg');
  expect(html).toContain('Show at the door');
  const empty = renderHtml(layout, data(null), fields, { locale: 'en', tz: 'Asia/Dhaka' });
  expect(empty).not.toContain('<svg');
});
