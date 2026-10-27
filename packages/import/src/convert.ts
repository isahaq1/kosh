/**
 * Cells to field values (RFC 0014 §5.1 step 3): numbers with the file's decimal separator, exact decimals as text
 * (money is never a JS `number`), dates in the file's day order or ISO, booleans in English and Bangla, selections by
 * value or label. Bangla digits read as digits. Relations are matched elsewhere (`match.ts`): here they are text.
 */

/** A cell as read from a file: CSV cells are text, XLSX cells are typed. */
export type Cell = string | number | boolean | Date | null;

export interface ConvertOptions {
  /** Day order of dates written as text (`03/04/2026`). Default `dmy`. */
  readonly dateOrder?: 'dmy' | 'mdy' | 'ymd';
  /** Decimal separator of numbers written as text. Default `.`. */
  readonly decimal?: '.' | ',';
  /** Time zone of date-times without an offset. Default `UTC`. */
  readonly timeZone?: string;
}

export interface ConvertField {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly options: readonly (readonly [string, string])[] | null;
}

/** Why a cell could not be read: a stable code for the UI's messages, and an English text. */
export interface CellError {
  readonly code:
    | 'not-a-number'
    | 'not-an-integer'
    | 'not-a-date'
    | 'not-a-datetime'
    | 'not-a-boolean'
    | 'not-an-option'
    | 'not-importable';
  readonly message: string;
}

export type Converted = { readonly value: unknown } | { readonly error: CellError };

const BANGLA_DIGITS = /[০-৯]/g;
/** Text with Bangla digits as ASCII digits. */
export function asciiDigits(text: string): string {
  return text.replace(BANGLA_DIGITS, (d) => String(d.charCodeAt(0) - 0x09e6));
}

const TRUE = new Set(['true', 'yes', 'y', '1', 'x', '✓', 'on', 'হ্যাঁ', 'সত্য', 'হাঁ']);
const FALSE = new Set(['false', 'no', 'n', '0', 'off', 'না', 'মিথ্যা']);

/** Whether a field kind can be imported from a cell (relations included; binary and json are not). */
export function importable(kind: string): boolean {
  return kind !== 'binary' && kind !== 'json' && kind !== 'one2many';
}

/** `1,234.50` (or `1.234,50`) → `1234.50`; null when it is not a number. */
export function plainNumber(text: string, decimal: '.' | ','): string | null {
  let v = asciiDigits(text.trim()).replace(/[\s  '৳$€£¥₹]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(v)) {
    negative = true; // accounting negatives: (1,200.00)
    v = v.slice(1, -1);
  }
  if (v.startsWith('-')) {
    negative = !negative;
    v = v.slice(1);
  } else if (v.startsWith('+')) v = v.slice(1);
  const thousands = decimal === '.' ? ',' : '.';
  if (v.includes(thousands)) {
    // Groups of three after the first: 1,234,567 — anything else is not a thousands separator.
    const [whole, ...rest] = v.split(decimal);
    if (rest.length > 1) return null;
    const groups = (whole ?? '').split(thousands);
    if (groups.slice(1).some((g) => g.length !== 3) || (groups[0] ?? '').length === 0) return null;
    v = [groups.join(''), ...rest].join('.');
  } else if (decimal === ',') v = v.replace(',', '.');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(v)) return null;
  if (v.startsWith('.')) v = `0${v}`;
  if (v.endsWith('.')) v = v.slice(0, -1);
  return negative && !/^0(\.0*)?$/.test(v) ? `-${v}` : v;
}

/** A JS number as plain decimal text (no exponent). */
function numberText(n: number): string {
  if (Number.isInteger(n)) return BigInt(n).toString();
  const text = String(n);
  if (!/e/i.test(text)) return text;
  return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const ymd = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

function validDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The calendar date of `text` (`2026-04-03`, `03/04/2026` in the day order, `3.4.26`), or null. */
export function parseDate(text: string, order: 'dmy' | 'mdy' | 'ymd'): string | null {
  const v = asciiDigits(text.trim());
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  let parts: [number, number, number] | null = null;
  if (iso !== null) parts = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else {
    const m = /^(\d{1,4})[/.\-\s](\d{1,2})[/.\-\s](\d{1,4})$/.exec(v);
    if (m === null) return null;
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if ((m[1] as string).length === 4) parts = [a, b, c];
    else {
      const year = (m[3] as string).length <= 2 ? 2000 + c : c;
      parts = order === 'mdy' ? [year, a, b] : [year, b, a];
    }
  }
  const [y, mo, d] = parts;
  return validDate(y, mo, d) ? ymd(y, mo, d) : null;
}

/** The offset of `timeZone` from UTC at `utc`, in milliseconds. */
function offsetOf(timeZone: string, utc: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utc));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return local - utc;
}

/** The instant of a wall-clock time in `timeZone`. */
export function zoned(
  wall: { y: number; mo: number; d: number; h: number; mi: number; s: number },
  timeZone: string,
): Date {
  const guess = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s);
  const first = guess - offsetOf(timeZone, guess);
  return new Date(guess - offsetOf(timeZone, first));
}

/** A date and time from text: ISO with an offset as is, else a wall-clock time in `timeZone`. */
export function parseDateTime(
  text: string,
  order: 'dmy' | 'mdy' | 'ymd',
  timeZone: string,
): Date | null {
  const v = asciiDigits(text.trim());
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
    const date = new Date(v);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const m = /^(.+?)(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(v);
  if (m === null) return null;
  const day = parseDate(m[1] as string, order);
  if (day === null) return null;
  let h = Number(m[2] ?? 0);
  const mi = Number(m[3] ?? 0);
  const s = Number(m[4] ?? 0);
  const meridiem = m[5]?.toLowerCase();
  if (meridiem !== undefined) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (meridiem === 'pm' ? 12 : 0);
  }
  if (h > 23 || mi > 59 || s > 59) return null;
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  return zoned({ y, mo, d, h, mi, s }, timeZone);
}

const fail = (
  code: CellError['code'],
  field: ConvertField,
  cell: Cell,
  what: string,
): Converted => ({
  error: { code, message: `${field.label}: "${String(cell)}" is not ${what}.` },
});

/**
 * One cell as a value of `field`. Empty cells are `undefined` (left out) — the caller decides between leaving the
 * field to its default and clearing it.
 */
export function convertCell(
  field: ConvertField,
  cell: Cell,
  options: ConvertOptions = {},
): Converted | undefined {
  if (cell === null || (typeof cell === 'string' && cell.trim() === '')) return undefined;
  const order = options.dateOrder ?? 'dmy';
  const decimal = options.decimal ?? '.';
  const timeZone = options.timeZone ?? 'UTC';
  switch (field.kind) {
    case 'char':
    case 'text':
    case 'html':
    case 'many2one':
    case 'many2many':
      if (cell instanceof Date)
        return { value: cell.toISOString().slice(0, cell.getUTCHours() === 0 ? 10 : 19) };
      return { value: typeof cell === 'number' ? numberText(cell) : String(cell).trim() };
    case 'boolean': {
      if (typeof cell === 'boolean') return { value: cell };
      if (typeof cell === 'number' && (cell === 0 || cell === 1)) return { value: cell === 1 };
      const v = String(cell).trim().toLowerCase();
      if (TRUE.has(v)) return { value: true };
      if (FALSE.has(v)) return { value: false };
      return fail('not-a-boolean', field, cell, 'yes or no');
    }
    case 'integer':
    case 'bigint': {
      const text = typeof cell === 'number' ? numberText(cell) : plainNumber(String(cell), decimal);
      if (text === null || !/^-?\d+$/.test(text))
        return fail('not-an-integer', field, cell, 'a whole number');
      return { value: field.kind === 'bigint' ? text : Number(text) };
    }
    case 'float':
    case 'decimal':
    case 'monetary':
    case 'quantity': {
      if (typeof cell === 'boolean' || cell instanceof Date)
        return fail('not-a-number', field, cell, 'a number');
      const text = typeof cell === 'number' ? numberText(cell) : plainNumber(cell, decimal);
      if (text === null) return fail('not-a-number', field, cell, 'a number');
      return { value: field.kind === 'float' ? Number(text) : text };
    }
    case 'date': {
      if (cell instanceof Date) return { value: cell.toISOString().slice(0, 10) };
      const day = typeof cell === 'string' ? parseDate(cell, order) : null;
      return day === null ? fail('not-a-date', field, cell, 'a date') : { value: day };
    }
    case 'datetime': {
      if (cell instanceof Date) {
        // Spreadsheet dates have no zone: their wall-clock time is in the file's time zone.
        const [y, mo, d, h, mi, s] = [
          cell.getUTCFullYear(),
          cell.getUTCMonth() + 1,
          cell.getUTCDate(),
          cell.getUTCHours(),
          cell.getUTCMinutes(),
          cell.getUTCSeconds(),
        ];
        return { value: zoned({ y, mo, d, h, mi, s }, timeZone) };
      }
      const at = typeof cell === 'string' ? parseDateTime(cell, order, timeZone) : null;
      return at === null ? fail('not-a-datetime', field, cell, 'a date and time') : { value: at };
    }
    case 'selection':
    case 'state': {
      const v = (typeof cell === 'number' ? numberText(cell) : String(cell)).trim();
      const lower = v.toLowerCase();
      const option = (field.options ?? []).find(
        ([value, label]) => value === v || label.toLowerCase() === lower,
      );
      return option === undefined
        ? fail(
            'not-an-option',
            field,
            cell,
            `one of ${(field.options ?? []).map(([, l]) => l).join(', ')}`,
          )
        : { value: option[0] };
    }
    default:
      return fail('not-importable', field, cell, 'importable');
  }
}
