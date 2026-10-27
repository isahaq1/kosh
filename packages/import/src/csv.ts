/**
 * A CSV reader without dependencies (RFC 0014 §5.1): the encoding is read from the byte-order mark, else UTF-8 when
 * the bytes are valid UTF-8, else Windows-1252 (spreadsheets saved by older Excel); the separator is guessed from the
 * first lines (`,` `;` tab `|`); quoted cells may hold separators, quotes (`""`) and newlines (RFC 4180).
 */

export type CsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface CsvOptions {
  /** Default: guessed. */
  readonly separator?: string;
  /** Default: from the byte-order mark or the bytes. */
  readonly encoding?: CsvEncoding;
}

export interface CsvTable {
  readonly rows: string[][];
  readonly separator: string;
  readonly encoding: CsvEncoding;
}

const SEPARATORS = [',', ';', '\t', '|'];

/** The text of `bytes` and the encoding it was read in. */
export function decodeText(
  bytes: Uint8Array,
  given?: CsvEncoding,
): { text: string; encoding: CsvEncoding } {
  const [a, b, c] = bytes;
  let encoding = given;
  if (encoding === undefined) {
    if (a === 0xef && b === 0xbb && c === 0xbf) encoding = 'utf-8';
    else if (a === 0xff && b === 0xfe) encoding = 'utf-16le';
    else if (a === 0xfe && b === 0xff) encoding = 'utf-16be';
  }
  if (encoding !== undefined)
    // TextDecoder drops the byte-order mark of its own encoding.
    return { text: new TextDecoder(encoding).decode(bytes), encoding };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

/** Counts of `separator` outside quotes in each of the first lines. */
function counts(text: string, separator: string, lines: number): number[] {
  const out: number[] = [];
  let quoted = false;
  let n = 0;
  for (let i = 0; i < text.length && out.length < lines; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === separator) n += 1;
    else if (!quoted && ch === '\n') {
      out.push(n);
      n = 0;
    }
  }
  if (out.length < lines && n > 0) out.push(n);
  return out;
}

/** The separator found the same number of times on the most of the first lines (ties: the earlier in the list). */
export function guessSeparator(text: string): string {
  let best = ',';
  let bestScore = 0;
  for (const separator of SEPARATORS) {
    const seen = counts(text, separator, 10).filter((n) => n > 0);
    const first = seen[0];
    if (first === undefined) continue;
    const score = seen.filter((n) => n === first).length * 1000 + first;
    if (score > bestScore) {
      best = separator;
      bestScore = score;
    }
  }
  return best;
}

/** Splits `text` into rows of cells. Trailing empty rows are dropped. */
export function parseCsvText(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = false;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === separator) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  while (rows.length > 0 && (rows.at(-1) as string[]).every((c) => c === '')) rows.pop();
  return rows;
}

/** Reads a CSV file. */
export function readCsv(bytes: Uint8Array, options: CsvOptions = {}): CsvTable {
  const { text, encoding } = decodeText(bytes, options.encoding);
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const separator = options.separator ?? guessSeparator(body);
  return { rows: parseCsvText(body, separator), separator, encoding };
}
