/**
 * Reading files (RFC 0014 §5.1): CSV encodings, separators and quoting; XLSX written by Kosh's own writer (shared
 * strings, numbers, dates, booleans) and by hand (inline strings, formulas, sparse cells, a second sheet).
 */
import { workbook, zip } from '@kosh/reporting';
import { expect, test } from 'vitest';
import {
  decodeText,
  guessSeparator,
  isDateFormat,
  parseCsvText,
  readCsv,
  readXlsx,
  XlsxError,
  xlsxSheetNames,
} from '../src/index.js';

const bytes = (text: string) => new TextEncoder().encode(text);

test('CSV: quoted separators, quotes and newlines; CRLF; trailing empty rows dropped', () => {
  const text = 'name,note\r\n"Acme, Ltd","said ""hi""\nthen left"\r\nGlobex,\r\n\r\n';
  expect(parseCsvText(text, ',')).toEqual([
    ['name', 'note'],
    ['Acme, Ltd', 'said "hi"\nthen left'],
    ['Globex', ''],
  ]);
});

test('CSV: the separator is the one counted the same on most lines', () => {
  expect(guessSeparator('a;b;c\n1,5;2;3\n4;5;6\n')).toBe(';');
  expect(guessSeparator('a\tb\n1\t2\n')).toBe('\t');
  expect(guessSeparator('a,b\n"x;y",2\n')).toBe(',');
  expect(guessSeparator('single column\nvalue\n')).toBe(',');
});

test('CSV: UTF-8 with or without a mark, UTF-16 by its mark, else Windows-1252', () => {
  expect(readCsv(bytes('﻿নাম,দাম\nচাল,৫০\n'))).toEqual({
    rows: [
      ['নাম', 'দাম'],
      ['চাল', '৫০'],
    ],
    separator: ',',
    encoding: 'utf-8',
  });
  const utf16 = new Uint8Array([
    0xff,
    0xfe,
    ...new Uint8Array(new Uint16Array([...'a,b'].map((c) => c.charCodeAt(0))).buffer),
  ]);
  expect(decodeText(utf16)).toEqual({ text: 'a,b', encoding: 'utf-16le' });
  // "Café" saved by an old Excel: 0xE9 is not UTF-8.
  expect(decodeText(new Uint8Array([0x43, 0x61, 0x66, 0xe9])).text).toBe('Café');
});

test('XLSX: a workbook of the Kosh writer reads back typed', () => {
  const file = workbook([
    {
      name: 'Partners',
      rows: [
        ['Name', 'Credit', 'Since', 'Active'],
        ['Acme & Sons <BD>', { decimal: '1250.50' }, new Date(Date.UTC(2026, 3, 3)), true],
        ['গ্লোবেক্স', 7, null, false],
      ],
    },
  ]);
  expect(xlsxSheetNames(file)).toEqual(['Partners']);
  const sheet = readXlsx(file);
  expect(sheet.name).toBe('Partners');
  expect(sheet.rows).toEqual([
    ['Name', 'Credit', 'Since', 'Active'],
    ['Acme & Sons <BD>', 1250.5, new Date(Date.UTC(2026, 3, 3)), true],
    ['গ্লোবেক্স', 7, null, false],
  ]);
});

test('XLSX: inline strings, cached formula values (never evaluated), gaps, rich text and a chosen sheet', () => {
  const xml = (s: string) => Buffer.from(s, 'utf8');
  const file = zip([
    {
      name: 'xl/workbook.xml',
      data: xml(
        '<workbook xmlns:r="r"><sheets><sheet name="One" sheetId="1" r:id="rId1"/><sheet name="Two" sheetId="2" r:id="rId2"/></sheets></workbook>',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: xml(
        '<Relationships><Relationship Id="rId1" Target="worksheets/a.xml"/><Relationship Id="rId2" Target="/xl/worksheets/b.xml"/></Relationships>',
      ),
    },
    {
      name: 'xl/sharedStrings.xml',
      data: xml(
        '<sst><si><r><t>Ri</t></r><r><t xml:space="preserve">ch &amp; bold</t></r></si><si/></sst>',
      ),
    },
    { name: 'xl/worksheets/a.xml', data: xml('<worksheet><sheetData/></worksheet>') },
    {
      name: 'xl/worksheets/b.xml',
      data: xml(
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Inline</t></is></c><c r="C1" t="s"><v>0</v></c></row>' +
          '<row r="3"><c r="B3"><f>1+1</f><v>2</v></c><c r="C3" t="str"><f>A1&amp;"x"</f><v>Inlinex</v></c><c r="D3" t="e"><v>#N/A</v></c><c r="E3" t="s"><v>1</v></c></row></sheetData></worksheet>',
      ),
    },
  ]);
  expect(readXlsx(file).rows).toEqual([]);
  expect(readXlsx(file, 'Two').rows).toEqual([
    ['Inline', null, 'Rich & bold'],
    [],
    [null, 2, 'Inlinex', '#N/A', ''],
  ]);
  expect(() => readXlsx(file, 'Three')).toThrow(XlsxError);
  expect(() => readXlsx(bytes('not a zip'))).toThrow(XlsxError);
});

test('XLSX: date formats are told from number formats', () => {
  expect(isDateFormat('dd/mm/yyyy')).toBe(true);
  expect(isDateFormat('[$-445]d mmmm yyyy;@')).toBe(true);
  expect(isDateFormat('h:mm AM/PM')).toBe(true);
  expect(isDateFormat('#,##0.00')).toBe(false);
  expect(isDateFormat('"৳" #,##0.00')).toBe(false);
  expect(isDateFormat('0.00 "days"')).toBe(false);
});
