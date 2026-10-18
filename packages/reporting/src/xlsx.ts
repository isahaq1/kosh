/**
 * A minimal XLSX (Office Open XML) writer without dependencies: one or more sheets of typed cells (text, numbers,
 * exact decimals, dates, booleans), bold headers, frozen header rows, column widths and number formats, zipped with
 * `node:zlib` (deflate + CRC-32). Enough for formatted exports and scheduled reports; not a spreadsheet library.
 */
import { crc32, deflateRawSync } from 'node:zlib';

/** One cell. Decimals are strings (exact, written as numbers with the given format). */
export type Cell =
  | null
  | string
  | number
  | boolean
  | Date
  | { readonly decimal: string; readonly format?: string }
  | { readonly text: string; readonly bold?: boolean; readonly indent?: number };

export interface Sheet {
  readonly name: string;
  readonly rows: readonly (readonly Cell[])[];
  /** Header rows (bold, frozen). Default 1. */
  readonly headerRows?: number;
  /** Column widths in characters. */
  readonly widths?: readonly number[];
}

const xmlEscape = (text: string): string =>
  text
    .replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
    )
    // XML 1.0 forbids most control characters.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

function column(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Excel serial date (days since 1899-12-30, UTC). */
function serial(date: Date): number {
  return date.getTime() / 86_400_000 + 25_569;
}

// Style indexes in styles.xml: 0 normal, 1 bold, 2 date, 3 datetime, 4 integer grouping, 5 two decimals,
// 6 bold two decimals, 7+ custom number formats (registered per workbook).
const BOLD = 1;
const DATE = 2;
const DATETIME = 3;
const DECIMAL = 5;

class Styles {
  readonly formats = new Map<string, number>(); // format code → style index
  styleFor(format: string | undefined, bold: boolean): number {
    if (format === undefined) return bold ? 6 : DECIMAL;
    const key = `${bold ? 'b' : ''}${format}`;
    let index = this.formats.get(key);
    if (index === undefined) {
      index = 7 + this.formats.size;
      this.formats.set(key, index);
    }
    return index;
  }
  xml(): string {
    const custom = [...this.formats.keys()];
    const numFmts = [
      '<numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>',
      '<numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/>',
      ...custom.map(
        (k, i) => `<numFmt numFmtId="${166 + i}" formatCode="${xmlEscape(k.replace(/^b/, ''))}"/>`,
      ),
    ];
    const xfs = [
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
      '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
      '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
      '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
      '<xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>',
      ...custom.map(
        (k, i) =>
          `<xf numFmtId="${166 + i}" fontId="${k.startsWith('b') ? 1 : 0}" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"${k.startsWith('b') ? ' applyFont="1"' : ''}/>`,
      ),
    ];
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="${numFmts.length}">${numFmts.join('')}</numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs></styleSheet>`;
  }
}

function cellXml(ref: string, cell: Cell, header: boolean, styles: Styles): string {
  const s = (index: number) => (index === 0 ? '' : ` s="${index}"`);
  if (cell === null || cell === '') return '';
  if (typeof cell === 'string')
    return `<c r="${ref}" t="inlineStr"${s(header ? BOLD : 0)}><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`;
  if (typeof cell === 'number')
    return Number.isFinite(cell) ? `<c r="${ref}"${s(header ? BOLD : 0)}><v>${cell}</v></c>` : '';
  if (typeof cell === 'boolean') return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
  if (cell instanceof Date) {
    const midnight = cell.getUTCHours() + cell.getUTCMinutes() + cell.getUTCSeconds() === 0;
    return `<c r="${ref}"${s(midnight ? DATE : DATETIME)}><v>${serial(cell)}</v></c>`;
  }
  if ('decimal' in cell)
    return /^-?\d+(\.\d+)?$/.test(cell.decimal)
      ? `<c r="${ref}"${s(styles.styleFor(cell.format, header))}><v>${cell.decimal}</v></c>`
      : '';
  const bold = header || cell.bold === true;
  const pad = ' '.repeat(2 * (cell.indent ?? 0));
  return `<c r="${ref}" t="inlineStr"${s(bold ? BOLD : 0)}><is><t xml:space="preserve">${xmlEscape(pad + cell.text)}</t></is></c>`;
}

function sheetXml(sheet: Sheet, styles: Styles): string {
  const header = sheet.headerRows ?? 1;
  const cols =
    sheet.widths === undefined || sheet.widths.length === 0
      ? ''
      : `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
  const pane =
    header > 0
      ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${header}" topLeftCell="A${header + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      : '';
  const rows = sheet.rows
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row.map((c, i) => cellXml(`${column(i)}${r + 1}`, c, r < header, styles)).join('')}</row>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

/** A ZIP archive (deflate) of `files`. */
export function zip(files: readonly { readonly name: string; readonly data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const compressed = deflateRawSync(file.data);
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(0, 12);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += 30 + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** The workbook of `sheets` as an `.xlsx` file. */
export function workbook(sheets: readonly Sheet[]): Buffer {
  const styles = new Styles();
  const names = sheets.map((s, i) =>
    xmlEscape(s.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`),
  );
  const sheetFiles = sheets.map((sheet, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    data: Buffer.from(sheetXml(sheet, styles)),
  }));
  const files = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      ),
    },
    ...sheetFiles,
    { name: 'xl/styles.xml', data: Buffer.from(styles.xml()) },
  ];
  return zip(files);
}

/** The number format of a currency amount (`#,##0.00 "BDT"`). */
export function moneyFormat(currency: string, decimals = 2): string {
  return `#,##0${decimals > 0 ? `.${'0'.repeat(decimals)}` : ''} "${currency.replace(/"/g, '')}"`;
}
