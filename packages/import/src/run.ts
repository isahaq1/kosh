/**
 * The import itself (RFC 0014 §5.1 steps 3–6): rows of cells become records of a model through the ORM, as the user.
 * A dry run does all of it — conversions, relation matches, onchange-free creates, computes, sequences, constraints,
 * record rules — in a savepoint that is rolled back. A commit is all-or-nothing: any error leaves nothing behind.
 * Errors name their row (as numbered in the file), column and cell.
 */
import { type ApiModel, problemOf } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import {
  type Cell,
  type CellError,
  type ConvertOptions,
  convertCell,
  importable,
} from './convert.js';
import type { ColumnMapping } from './mapping.js';
import { type Match, type MatchTarget, matchAll } from './match.js';

export interface ImportOptions extends ConvertOptions {
  /** Step 1: `create` only (updates by key come with RFC 0014 step 2). */
  readonly mode?: 'create';
  /** The file's first row holds the headers (default true). */
  readonly headerRow?: boolean;
}

export type RowErrorCode =
  | CellError['code']
  | 'not-found'
  | 'ambiguous'
  | 'missing-required'
  | 'rejected';

/** One error, where the user can find it: the row of the file (1-based) and the column, when known. */
export interface RowError {
  readonly row: number;
  readonly column: number | null;
  readonly field: string | null;
  readonly code: RowErrorCode;
  readonly message: string;
}

export interface ImportResult {
  /** Rows of data read (headers and empty rows excluded). */
  readonly rows: number;
  /** Records created; empty after a dry run or when there were errors. */
  readonly created: readonly number[];
  /** Records a dry run would create. */
  readonly wouldCreate: number;
  readonly errors: readonly RowError[];
  /** How each relation text was matched (by external id, key, name), for the user to check. */
  readonly matches: Readonly<Record<string, Readonly<Record<string, Match>>>>;
}

/** A field of the model the user can fill by import, with what a relation needs to be matched. */
export interface ImportField {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly required: boolean;
  readonly options: readonly (readonly [string, string])[] | null;
  readonly target: MatchTarget | null;
}

/** Thrown to roll back a dry run's savepoint; never escapes `runImport`. */
class Rollback extends Error {}

interface Created {
  readonly ids: readonly number[];
}
interface Ref {
  create(rows: readonly Record<string, unknown>[]): Promise<Created>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;

/** Field-mapped errors of a failing write: the columns of the fields the error names, else the row. */
function writeErrors(
  error: unknown,
  row: number,
  columnsByField: ReadonlyMap<string, number>,
): RowError[] {
  const problem = problemOf(error);
  if (problem.status >= 500) throw error; // a fault, not the data
  const fields = (error as { fields?: unknown }).fields;
  const named = Array.isArray(fields)
    ? fields.filter((f): f is string => typeof f === 'string' && columnsByField.has(f))
    : [];
  const message = problem.detail ?? problem.title;
  if (named.length === 0) return [{ row, column: null, field: null, code: 'rejected', message }];
  return named.map((field) => ({
    row,
    column: columnsByField.get(field) ?? null,
    field,
    code: 'rejected' as const,
    message,
  }));
}

/**
 * Imports `table` (cells by row) into `model` with `columns`. With `dryRun`, nothing is kept. Runs in the caller's
 * transaction: a commit that reports errors has rolled back its own savepoint.
 */
export async function runImport(
  env: Env,
  model: ApiModel,
  fields: ReadonlyMap<string, ImportField>,
  table: readonly (readonly Cell[])[],
  columns: readonly ColumnMapping[],
  options: ImportOptions & { readonly dryRun: boolean },
): Promise<ImportResult> {
  const first = options.headerRow === false ? 0 : 1;
  const mapped = columns.filter(
    (c): c is ColumnMapping & { field: string } => c.field !== null && fields.has(c.field),
  );
  const columnsByField = new Map(mapped.map((c) => [c.field, c.index]));
  const errors: RowError[] = [];
  // Required fields without a column: every row would fail the same way, so say it once.
  for (const field of fields.values())
    if (field.required && !columnsByField.has(field.key))
      errors.push({
        row: first,
        column: null,
        field: field.key,
        code: 'missing-required',
        message: `${field.label} is required: map a column to it.`,
      });

  // Convert every cell; collect the relation texts to match them once each.
  const records: { row: number; values: Record<string, unknown> }[] = [];
  const relationTexts = new Map<string, Set<string>>();
  for (let r = first; r < table.length; r++) {
    const cells = table[r] ?? [];
    if (cells.every((c) => c === null || (typeof c === 'string' && c.trim() === ''))) continue;
    const values: Record<string, unknown> = {};
    for (const column of mapped) {
      const field = fields.get(column.field) as ImportField;
      const converted = convertCell(field, cells[column.index] ?? null, options);
      if (converted === undefined) continue;
      if ('error' in converted) {
        errors.push({
          row: r + 1,
          column: column.index,
          field: field.key,
          code: converted.error.code,
          message: converted.error.message,
        });
        continue;
      }
      let value = converted.value;
      if (field.kind === 'many2many')
        value = String(value)
          .split(/[,;\n]/)
          .map((t) => t.trim())
          .filter((t) => t !== '');
      if (field.target !== null) {
        const texts = relationTexts.get(field.key) ?? new Set<string>();
        for (const t of Array.isArray(value) ? value : [value]) texts.add(String(t));
        relationTexts.set(field.key, texts);
      }
      values[field.key] = value;
    }
    records.push({ row: r + 1, values });
  }

  const matches: Record<string, Record<string, Match>> = {};
  for (const [key, texts] of relationTexts) {
    const target = (fields.get(key) as ImportField).target as MatchTarget;
    matches[key] = Object.fromEntries(await matchAll(env, target, texts));
  }
  // Relation texts to ids; an unmatched text is an error on its cell.
  const ready: { row: number; values: Record<string, unknown> }[] = [];
  const rowsWithErrors = new Set(errors.map((e) => e.row));
  for (const record of records) {
    let ok = !rowsWithErrors.has(record.row);
    for (const [key, value] of Object.entries(record.values)) {
      const field = fields.get(key) as ImportField;
      if (field.target === null) continue;
      const found = (Array.isArray(value) ? value : [value]).map((t) => ({
        text: String(t),
        match: matches[key]?.[String(t)] as Match,
      }));
      const ids: number[] = [];
      for (const { text, match } of found) {
        if ('id' in match) {
          ids.push(match.id);
          continue;
        }
        ok = false;
        errors.push({
          row: record.row,
          column: columnsByField.get(key) ?? null,
          field: key,
          code: match.error,
          message:
            match.error === 'ambiguous'
              ? `${field.label}: "${text}" matches several records; use its code or external id.`
              : `${field.label}: no record "${text}" was found.`,
        });
      }
      record.values[key] = field.kind === 'many2many' ? { set: ids } : ids[0];
    }
    if (ok) ready.push(record);
  }

  // The writes, in a savepoint: all rows at once; when that fails, row by row to find each failing row.
  let created: readonly number[] = [];
  let failed = 0;
  const keep = !options.dryRun && errors.length === 0;
  // A required field without a column fails every row the same way: no write would say more.
  if (errors.some((e) => e.code === 'missing-required')) ready.length = 0;
  try {
    await env.transaction(async (tx) => {
      if (ready.length > 0) {
        try {
          created = await tx.transaction(async (batch) => {
            const rows = await ref(batch, model.name).create(ready.map((r) => r.values));
            await batch.flush();
            return rows.ids;
          });
        } catch (error) {
          if (problemOf(error).status >= 500) throw error;
          created = [];
          for (const record of ready)
            try {
              await tx.transaction(async (one) => {
                await ref(one, model.name).create([record.values]);
                await one.flush();
              });
            } catch (rowError) {
              failed += 1;
              errors.push(...writeErrors(rowError, record.row, columnsByField));
            }
        }
      }
      if (!keep || errors.length > 0) throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
    return {
      rows: records.length,
      created: [],
      wouldCreate: options.dryRun ? ready.length - failed : 0,
      errors: sortErrors(errors),
      matches,
    };
  }
  return { rows: records.length, created, wouldCreate: 0, errors: [], matches };
}

function sortErrors(errors: readonly RowError[]): RowError[] {
  return [...errors].sort((a, b) => a.row - b.row || (a.column ?? -1) - (b.column ?? -1));
}

/** The fields of `model` the user may fill by import, keyed by field. */
export function importFields(
  env: Env,
  model: ApiModel,
  targets: (target: string) => MatchTarget | null,
): Map<string, ImportField> {
  const out = new Map<string, ImportField>();
  for (const f of model.fields) {
    if (f.readonly || !importable(f.kind) || f.key === 'id' || f.key === 'company') continue;
    if (!env.access.canField(model.name as never, f.key, 'write')) continue;
    let target: MatchTarget | null = null;
    if (f.kind === 'many2one' || f.kind === 'many2many') {
      if (f.target === null || !env.access.can(f.target as never, 'read')) continue;
      target = targets(f.target);
      if (target === null) continue;
    }
    out.set(f.key, {
      key: f.key,
      kind: f.kind,
      label: f.label,
      required: f.requiredOnCreate && f.kind !== 'many2many', // a set is never missing: it is empty
      options: f.options,
      target,
    });
  }
  return out;
}
