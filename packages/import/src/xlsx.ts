/**
 * A minimal XLSX reader without dependencies (RFC 0014 §5.1), the counterpart of `@kosh/reporting`'s writer: the zip
 * is read with `node:zlib`, sheets with a small tag scanner. Cells come back typed: text (shared and inline
 * strings), numbers, booleans, and dates for numbers whose format is a date format. A formula is never evaluated:
 * its cached value is read. Errors (`#N/A`) read as text.
 */
import { inflateRawSync } from 'node:zlib';

export type XlsxCell = string | number | boolean | Date | null;

export interface XlsxSheet {
  readonly name: string;
  readonly rows: XlsxCell[][];
}

export class XlsxError extends Error {
  override readonly name = 'XlsxError';
}

/** The entries of a zip archive by name (stored or deflated; no ZIP64, no encryption). */
export function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new XlsxError('The file is not an XLSX workbook (no zip directory).');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50)
      throw new XlsxError('The zip directory is damaged.');
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (view.getUint32(local, true) !== 0x04034b50) throw new XlsxError('A zip entry is damaged.');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(data)));
    else throw new XlsxError(`Zip compression method ${method} is not supported.`);
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML text with its entities resolved. */
export function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (all, ref: string) => {
    if (ref.startsWith('#x')) return String.fromCodePoint(Number.parseInt(ref.slice(2), 16));
    if (ref.startsWith('#')) return String.fromCodePoint(Number.parseInt(ref.slice(1), 10));
    return ENTITIES[ref] ?? all;
  });
}

/** The value of attribute `name` in the attributes text of a tag. */
function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m === null ? undefined : unescapeXml(m[1] as string);
}

/** The text of the `<t>` elements in `xml` (a shared string or an inline string, rich runs joined). */
function texts(xml: string): string {
  let out = '';
  const visible = xml.replace(/<rPh[\s\S]*?<\/rPh>/g, ''); // phonetic guides are not the text
  for (const m of visible.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g))
    out += unescapeXml(m[1] as string);
  return out;
}

/** Built-in number formats that are dates or times. */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Whether a custom number format code shows a date or time (letters outside quotes and brackets). */
export function isDateFormat(code: string): boolean {
  const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  return /[dmyhs]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare);
}

/** For each cell style index: whether it formats a date. */
function dateStyles(xml: string | undefined): boolean[] {
  if (xml === undefined) return [];
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\s([^>]*?)\/?>/g)) {
    const id = Number(attr(m[1] as string, 'numFmtId'));
    custom.set(id, attr(m[1] as string, 'formatCode') ?? '');
  }
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  return [...xfs.matchAll(/<xf\s([^>]*?)\/?>/g)].map((m) => {
    const id = Number(attr(m[1] as string, 'numFmtId') ?? 0);
    const code = custom.get(id);
    return code === undefined ? DATE_FORMATS.has(id) : isDateFormat(code);
  });
}

/** An Excel serial date (days since 1899-12-30) as a UTC date, to the second. */
export function fromSerial(serial: number): Date {
  return new Date(Math.round((serial - 25_569) * 86_400) * 1000);
}

/** Column index of a cell reference (`C7` → 2). */
function columnOf(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function readSheet(
  xml: string,
  shared: readonly string[],
  dates: readonly boolean[],
): XlsxCell[][] {
  const rows: XlsxCell[][] = [];
  const data = /<sheetData[^>]*>([\s\S]*?)<\/sheetData>|<sheetData[^>]*\/>/.exec(xml)?.[1] ?? '';
  for (const rowMatch of data.matchAll(/<row(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const index = Number(attr(rowMatch[1] ?? '', 'r') ?? rows.length + 1) - 1;
    const row: XlsxCell[] = [];
    for (const cell of (rowMatch[2] ?? '').matchAll(/<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? '';
      const body = cell[2] ?? '';
      const ref = attr(attrs, 'r');
      const col = ref === undefined ? row.length : columnOf(ref);
      const type = attr(attrs, 't') ?? 'n';
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value: XlsxCell = null;
      if (type === 'inlineStr') value = texts(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
      else if (raw === undefined) value = null;
      else if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'b') value = raw === '1';
      else if (type === 'str' || type === 'e') value = unescapeXml(raw);
      else {
        const n = Number(raw);
        value = dates[Number(attr(attrs, 's') ?? 0)] === true ? fromSerial(n) : n;
      }
      while (row.length < col) row.push(null);
      row[col] = value;
    }
    while (rows.length < index) rows.push([]);
    rows[index] = row;
  }
  while (rows.length > 0 && (rows.at(-1) as XlsxCell[]).every((c) => c === null || c === ''))
    rows.pop();
  return rows;
}

/** The sheet names of a workbook, in order. */
export function xlsxSheetNames(bytes: Uint8Array): string[] {
  return sheetsOf(unzip(bytes)).map((s) => s.name);
}

function sheetsOf(files: Map<string, Uint8Array>): { name: string; path: string }[] {
  const text = (path: string) => {
    const b = files.get(path);
    return b === undefined ? undefined : new TextDecoder().decode(b);
  };
  const workbook = text('xl/workbook.xml');
  if (workbook === undefined)
    throw new XlsxError('The file is not an XLSX workbook (no workbook).');
  const targets = new Map<string, string>();
  for (const m of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(
    /<Relationship\s([^>]*?)\/?>/g,
  )) {
    const target = attr(m[1] as string, 'Target') ?? '';
    targets.set(
      attr(m[1] as string, 'Id') ?? '',
      target.startsWith('/') ? target.slice(1) : `xl/${target}`,
    );
  }
  return [...workbook.matchAll(/<sheet\s([^>]*?)\/?>/g)].map((m, i) => ({
    name: attr(m[1] as string, 'name') ?? `Sheet${i + 1}`,
    path: targets.get(attr(m[1] as string, 'r:id') ?? '') ?? `xl/worksheets/sheet${i + 1}.xml`,
  }));
}

/** Reads one sheet of a workbook: by name, else the first. @throws {XlsxError} */
export function readXlsx(bytes: Uint8Array, sheet?: string): XlsxSheet {
  const files = unzip(bytes);
  const text = (path: string) => {
    const b = files.get(path);
    return b === undefined ? undefined : new TextDecoder().decode(b);
  };
  const sheets = sheetsOf(files);
  const chosen = sheet === undefined ? sheets[0] : sheets.find((s) => s.name === sheet);
  if (chosen === undefined)
    throw new XlsxError(
      sheet === undefined ? 'The workbook has no sheet.' : `The workbook has no sheet '${sheet}'.`,
    );
  const xml = text(chosen.path);
  if (xml === undefined) throw new XlsxError(`The sheet '${chosen.name}' is missing.`);
  const shared = [
    ...(text('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g),
  ].map((m) => texts(m[1] ?? ''));
  return { name: chosen.name, rows: readSheet(xml, shared, dateStyles(text('xl/styles.xml'))) };
}
