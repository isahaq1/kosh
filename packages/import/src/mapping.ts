/**
 * Columns to fields (RFC 0014 §5.1 step 2): each header is matched to a field by its key or its label, ignoring case,
 * spaces and punctuation, so an export of Kosh (headers are labels) re-imports without edits. Unmatched columns
 * are skipped until the user maps them.
 */
import { importable } from './convert.js';

export interface MappableField {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
}

/** A column of the file and the field it fills, or null to skip it. */
export interface ColumnMapping {
  readonly index: number;
  readonly header: string;
  readonly field: string | null;
}

/** Lower case, letters and digits only (Bangla letters kept). */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

/** The field each header most likely fills: an exact key, then an exact label; each field once. */
export function guessMapping(
  headers: readonly string[],
  fields: readonly MappableField[],
): ColumnMapping[] {
  const candidates = fields.filter((f) => importable(f.kind));
  const taken = new Set<string>();
  const byKey = new Map(candidates.map((f) => [normalize(f.key), f.key]));
  const byLabel = new Map<string, string>();
  for (const f of candidates) {
    const label = normalize(f.label);
    if (!byLabel.has(label)) byLabel.set(label, f.key);
  }
  return headers.map((header, index) => {
    const n = normalize(header);
    const found = byKey.get(n) ?? byLabel.get(n) ?? null;
    if (found === null || taken.has(found) || n === '') return { index, header, field: null };
    taken.add(found);
    return { index, header, field: found };
  });
}
