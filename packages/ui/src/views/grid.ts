/**
 * Spreadsheet-grade list editing (RFC 0010 Phase B): the pure parts. A list's rows and visible columns form a
 * grid; the keyboard moves an active cell and extends a range; a block from a spreadsheet (tab-separated, as
 * Excel, Sheets and LibreOffice put it on the clipboard) lands cell by cell from the active one; each text is
 * turned into the field's value (numbers, dates, yes/no, a selection's label, a related record by name) and
 * refused with a reason when it cannot be. The writes themselves stay the API's: one update per row, with the
 * row's version.
 */
import type { ViewField } from '../api.js';

export interface CellRef {
  readonly row: number;
  readonly col: number;
}

export interface CellRange {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/** The rectangle between two cells. */
export function rangeOf(a: CellRef, b: CellRef): CellRange {
  return {
    top: Math.min(a.row, b.row),
    left: Math.min(a.col, b.col),
    bottom: Math.max(a.row, b.row),
    right: Math.max(a.col, b.col),
  };
}

export function inRange(range: CellRange, cell: CellRef): boolean {
  return (
    cell.row >= range.top &&
    cell.row <= range.bottom &&
    cell.col >= range.left &&
    cell.col <= range.right
  );
}

/**
 * The clipboard's text as rows of cells: tab-separated, one row per line. A cell Excel quoted (it held a tab, a
 * newline or a quote) is unquoted, with `""` as one quote. A single trailing newline is not a row.
 */
export function parseClipboard(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const atCellStart = () => cell === '' && !quoted;
  while (i < text.length) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += c;
      i += 1;
      continue;
    }
    if (c === '"' && atCellStart()) {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === '\t') {
      row.push(cell);
      cell = '';
      i += 1;
      continue;
    }
    if (c === '\n' || c === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cell += c;
    i += 1;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Cells as clipboard text (tab-separated; a cell with a tab, a newline or a quote is quoted as Excel does). */
export function toClipboard(cells: readonly (readonly string[])[]): string {
  const quote = (s: string) => (/[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return cells.map((row) => row.map(quote).join('\t')).join('\n');
}

/** Looks related records up by name (the API's name search). */
export type Resolve = (
  target: string,
  q: string,
) => Promise<readonly { readonly id: number; readonly displayName: string }[]>;

export type Coerced =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

const YES = new Set(['true', 'yes', 'y', '1', 'x', '✓', 'হ্যাঁ', 'oui', 'ja', 'sí', 'si']);
const NO = new Set(['false', 'no', 'n', '0', '', '✗', 'না', 'non', 'nein']);

/** A number as typed in a spreadsheet: thousands separators and spaces go, a decimal comma becomes a point. */
function numeric(text: string): string | null {
  const trimmed = text.trim().replace(/[\s ]/g, '');
  if (trimmed === '') return null;
  // "1,234.56" (English) or "1.234,56" (many locales): the last separator is the decimal one when both appear.
  const lastComma = trimmed.lastIndexOf(',');
  const lastPoint = trimmed.lastIndexOf('.');
  let normalized: string;
  if (lastComma !== -1 && lastPoint !== -1)
    normalized =
      lastComma > lastPoint
        ? trimmed.replace(/\./g, '').replace(',', '.')
        : trimmed.replace(/,/g, '');
  else if (lastComma !== -1)
    normalized =
      (trimmed.match(/,/g) ?? []).length === 1
        ? trimmed.replace(',', '.')
        : trimmed.replace(/,/g, '');
  else normalized = trimmed;
  return /^-?\d+(\.\d+)?$/.test(normalized) ? normalized : null;
}

/**
 * The field's value for a pasted text, or why the text cannot be it. `messages` gives the reasons in the user's
 * language (`notNumber`, `notDate`, `notOption`, `notFound`, `ambiguous`, `notPasteable`).
 */
export async function coerce(
  field: ViewField,
  text: string,
  resolve: Resolve,
  messages: (key: string, params?: Record<string, unknown>) => string,
): Promise<Coerced> {
  const raw = text.trim();
  switch (field.kind) {
    case 'char':
    case 'text':
    case 'html':
      return { ok: true, value: raw === '' ? null : text.replace(/\r?\n$/, '') };
    case 'integer': {
      const n = numeric(raw);
      if (raw === '') return { ok: true, value: null };
      if (n === null || !/^-?\d+$/.test(n))
        return { ok: false, reason: messages('notNumber', { text: raw }) };
      return { ok: true, value: Number(n) };
    }
    case 'decimal':
    case 'float':
    case 'monetary': {
      if (raw === '') return { ok: true, value: null };
      const n = numeric(raw);
      if (n === null) return { ok: false, reason: messages('notNumber', { text: raw }) };
      return { ok: true, value: n };
    }
    case 'boolean': {
      const key = raw.toLowerCase();
      if (YES.has(key)) return { ok: true, value: true };
      if (NO.has(key)) return { ok: true, value: false };
      return { ok: false, reason: messages('notOption', { text: raw }) };
    }
    case 'date':
    case 'datetime': {
      if (raw === '') return { ok: true, value: null };
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw;
      const date = new Date(iso);
      if (Number.isNaN(date.getTime()))
        return { ok: false, reason: messages('notDate', { text: raw }) };
      if (field.kind === 'date') {
        const pad = (n: number) => String(n).padStart(2, '0');
        return {
          ok: true,
          value: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
        };
      }
      return { ok: true, value: date.toISOString() };
    }
    case 'selection':
    case 'state': {
      if (raw === '') return { ok: true, value: null };
      const key = raw.toLowerCase();
      const option = (field.options ?? []).find(
        (o) => o.label.toLowerCase() === key || o.value.toLowerCase() === key,
      );
      if (option === undefined) return { ok: false, reason: messages('notOption', { text: raw }) };
      return { ok: true, value: option.value };
    }
    case 'many2one': {
      if (raw === '') return { ok: true, value: null };
      if (field.target === undefined) return { ok: false, reason: messages('notPasteable') };
      const found = await resolve(field.target, raw);
      const key = raw.toLowerCase();
      const exact = found.filter((r) => r.displayName.toLowerCase() === key);
      const candidates = exact.length > 0 ? exact : found;
      if (candidates.length === 0)
        return { ok: false, reason: messages('notFound', { text: raw }) };
      if (candidates.length > 1 && exact.length !== 1)
        return { ok: false, reason: messages('ambiguous', { text: raw }) };
      return { ok: true, value: (candidates[0] as { id: number }).id };
    }
    default:
      return { ok: false, reason: messages('notPasteable') };
  }
}

/** A cell's value as text for the clipboard (raw numbers, so a spreadsheet gets numbers). */
export function cellText(
  field: ViewField,
  value: unknown,
  names: (target: string, id: number) => string | undefined,
  yesNo: readonly [string, string],
): string {
  if (value === null || value === undefined) return '';
  switch (field.kind) {
    case 'boolean':
      return value === true ? yesNo[0] : yesNo[1];
    case 'decimal':
    case 'float':
    case 'monetary':
      return typeof value === 'object' && value !== null && 'amount' in value
        ? String((value as { amount: unknown }).amount)
        : String(value);
    case 'selection':
    case 'state':
      return (field.options ?? []).find((o) => o.value === value)?.label ?? String(value);
    case 'many2one': {
      const id =
        typeof value === 'number'
          ? value
          : typeof value === 'object' && value !== null && 'id' in value
            ? Number((value as { id: unknown }).id)
            : null;
      if (id === null) return String(value);
      return (field.target === undefined ? undefined : names(field.target, id)) ?? `#${id}`;
    }
    case 'date':
      return String(value).slice(0, 10);
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}
