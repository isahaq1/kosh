/**
 * The import itself (RFC 0014 §5.1–§5.5): rows of cells become records of a model through the ORM, as the user.
 *
 * - Records are created, updated or both (`mode`), matched on a key column: the record id, an external id, or a
 *   field the model keeps unique (a code, an email).
 * - A row whose own columns are empty continues the record above: its `lines.*` cells add a line (§5.2). Lines of an
 *   updated record replace its lines, so a file exported with its lines re-imports to the same records.
 * - A dry run does all of it — conversions, relation matches, creates and writes, computes, sequences, constraints,
 *   record rules — in a savepoint that is rolled back. A commit is all-or-nothing, or with `onError: 'skip'` keeps
 *   the records without errors.
 * - A commit returns what undo needs (§5.5): the created ids, the previous values of updated records and their lines,
 *   and each record's `updatedAt` after the import, to tell records changed since.
 *
 * Errors name their row (as numbered in the file), column and cell.
 */
import { type ApiModel, problemOf } from '@kosh/server';
import { type Env, orm } from '@kosh/server/orm';
import {
  type Cell,
  type CellError,
  type ConvertOptions,
  convertCell,
  importable,
} from './convert.js';
import type { ColumnMapping } from './mapping.js';
import { type Match, type MatchTarget, matchAll } from './match.js';

/** The record id as a key column (`#42` or `42`, as an export writes it). */
export const ID_KEY = 'id';
/** An external id as a key column (`legacy.partner_42`; a bare `partner_42` is `__import__.partner_42`). */
export const EXTERNAL_ID_KEY = 'externalId';
/** The module part of external ids an import gives (Shutro `env.setExternalId`). */
export const IMPORT_MODULE = '__import__';

export interface ImportOptions extends ConvertOptions {
  /** `create` (default), `update` existing records only, or `upsert`. */
  readonly mode?: 'create' | 'update' | 'upsert';
  /** The key column's field: `id`, `externalId`, or a unique field. Needed to update. */
  readonly key?: string;
  /** `stop` (default): any error keeps nothing. `skip`: records with errors are left out, the others kept. */
  readonly onError?: 'stop' | 'skip';
  /** The file's first row holds the headers (default true). */
  readonly headerRow?: boolean;
}

export type RowErrorCode =
  | CellError['code']
  | 'not-found'
  | 'ambiguous'
  | 'missing-required'
  | 'missing-key'
  | 'no-match'
  | 'exists'
  | 'duplicate-key'
  | 'rejected';

/** One error, where the user can find it: the row of the file (1-based) and the column, when known. */
export interface RowError {
  readonly row: number;
  readonly column: number | null;
  readonly field: string | null;
  readonly code: RowErrorCode;
  readonly message: string;
}

/** What undo needs (RFC 0014 §5.5). JSON: stored with the session. */
export interface UndoData {
  readonly created: readonly number[];
  readonly updated: readonly {
    readonly id: number;
    /** The previous values of the fields the import wrote (as `read()` gives them). */
    readonly before: Readonly<Record<string, unknown>>;
    /** The previous lines of the one2many fields the import replaced. */
    readonly lines: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
  }[];
  /** `updatedAt` of each touched record after the import (ISO). */
  readonly stamps: Readonly<Record<string, string>>;
}

export interface ImportResult {
  /** Records read (a record and its continuation rows count once). */
  readonly rows: number;
  /** Records created and updated; empty after a dry run or a commit that stopped on errors. */
  readonly created: readonly number[];
  readonly updated: readonly number[];
  /** What a dry run would create and update. */
  readonly wouldCreate: number;
  readonly wouldUpdate: number;
  /** Records left out for their errors (`onError: 'skip'`). */
  readonly skipped: number;
  /** The file rows of the records left out (their continuation rows included). */
  readonly rejectedRows: readonly number[];
  readonly errors: readonly RowError[];
  /** How each relation text was matched (by external id, key, name), by field path, for the user to check. */
  readonly matches: Readonly<Record<string, Readonly<Record<string, Match>>>>;
  /** Set when the import was kept. */
  readonly undo: UndoData | null;
}

/** A field the user can fill by import: of the model, a line field (`lines.product`), or a key column. */
export interface ImportField {
  /** The path: `name`, `lines.product`, `id`, `externalId`. */
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly required: boolean;
  readonly options: readonly (readonly [string, string])[] | null;
  readonly target: MatchTarget | null;
  /** The one2many field a line field belongs to, else null. */
  readonly line: string | null;
  /** The field key in its own model (`product` for `lines.product`). */
  readonly sub: string;
  /** Usable as the key column: the id, an external id, or a field the model keeps unique. */
  readonly keyable: boolean;
}

/** Records written per savepoint (and per progress report). */
export const WRITE_BATCH = 1000;

/** Thrown to roll back a savepoint; never escapes `runImport`. */
class Rollback extends Error {}

type Row = Record<string, unknown>;
interface Records {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[] | Readonly<Record<string, true>>): Promise<Records>;
  read(keys: readonly string[]): Row[];
  write(values: unknown): Promise<void>;
  unlink(): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Records>;
  browse(ids: readonly number[]): Records;
  create(rows: readonly Row[]): Promise<Records>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;

const empty = (c: Cell | undefined) =>
  c === undefined || c === null || (typeof c === 'string' && c.trim() === '');

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

/** The full external id of a key cell. */
export const externalIdOf = (text: string): string =>
  text.includes('.') ? text : `${IMPORT_MODULE}.${text}`;

/** A file's record: its first row, its continuation rows, values, lines and key. */
interface Draft {
  readonly row: number;
  readonly rows: number[];
  readonly values: Row;
  readonly lines: Map<string, { row: number; values: Row }[]>;
  key: string | null;
  ok: boolean;
  /** The existing record (update, upsert). */
  existing: number | null;
}

/**
 * Imports `table` (cells by row) into `model` with `columns`. With `dryRun`, nothing is kept. Runs in the caller's
 * transaction, in savepoints of its own.
 */
export async function runImport(
  env: Env,
  model: ApiModel,
  fields: ReadonlyMap<string, ImportField>,
  table: readonly (readonly Cell[])[],
  columns: readonly ColumnMapping[],
  options: ImportOptions & {
    readonly dryRun: boolean;
    /** Called before the writes and after each batch: records written so far, of how many. */
    readonly onProgress?: (done: number, total: number) => Promise<void>;
  },
): Promise<ImportResult> {
  const first = options.headerRow === false ? 0 : 1;
  const mode = options.mode ?? 'create';
  const skip = options.onError === 'skip';
  const mapped = columns.filter(
    (c): c is ColumnMapping & { field: string } => c.field !== null && fields.has(c.field),
  );
  const columnsByField = new Map(mapped.map((c) => [c.field, c.index]));
  const own = mapped.filter((c) => (fields.get(c.field) as ImportField).line === null);
  const lineColumns = mapped.filter((c) => (fields.get(c.field) as ImportField).line !== null);
  const keyField = options.key === undefined ? undefined : fields.get(options.key);
  const keyColumn = options.key === undefined ? undefined : columnsByField.get(options.key);
  const errors: RowError[] = [];
  const fail = (draft: Draft | undefined, error: RowError) => {
    errors.push(error);
    if (draft !== undefined) draft.ok = false;
  };

  // Mapping errors: every row would fail the same way, so they are said once and nothing is written.
  if (mode !== 'create' && (keyField === undefined || keyColumn === undefined))
    errors.push({
      row: first,
      column: null,
      field: options.key ?? null,
      code: 'missing-key',
      message: 'Updating records needs a key column: the id, an external id or a unique field.',
    });
  if (mode === 'create')
    for (const field of fields.values())
      if (field.required && field.line === null && !columnsByField.has(field.key))
        errors.push({
          row: first,
          column: null,
          field: field.key,
          code: 'missing-required',
          message: `${field.label} is required: map a column to it.`,
        });
  const mappingFailed = errors.length > 0;

  // Rows to records; cells to values; relation texts collected to match each once.
  const drafts: Draft[] = [];
  const relationTexts = new Map<string, Set<string>>();
  const convert = (
    draft: Draft,
    column: ColumnMapping & { field: string },
    cell: Cell,
    row: number,
  ) => {
    const field = fields.get(column.field) as ImportField;
    if (field.kind === ID_KEY || field.kind === EXTERNAL_ID_KEY) {
      if (!empty(cell)) draft.key ??= String(cell).trim();
      return undefined;
    }
    const converted = convertCell(field, cell, options);
    if (converted === undefined) return undefined;
    if ('error' in converted) {
      fail(draft, { row, column: column.index, field: field.key, ...converted.error });
      return undefined;
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
    return value;
  };
  for (let r = first; r < table.length; r++) {
    const cells = table[r] ?? [];
    if (cells.every(empty)) continue;
    const previous = drafts.at(-1);
    const continues =
      previous !== undefined &&
      own.every((c) => empty(cells[c.index])) &&
      lineColumns.some((c) => !empty(cells[c.index]));
    let draft: Draft;
    if (continues) {
      draft = previous;
      draft.rows.push(r + 1);
    } else {
      draft = {
        row: r + 1,
        rows: [r + 1],
        values: {},
        lines: new Map(),
        key: null,
        ok: true,
        existing: null,
      };
      drafts.push(draft);
      for (const column of own) {
        const value = convert(draft, column, cells[column.index] ?? null, r + 1);
        if (value !== undefined) draft.values[column.field] = value;
      }
      if (keyField !== undefined && keyField.kind !== ID_KEY && keyField.kind !== EXTERNAL_ID_KEY) {
        const value = draft.values[keyField.key];
        if (value !== undefined) draft.key = String(value);
      }
    }
    const lines = new Map<string, Row>();
    for (const column of lineColumns) {
      const field = fields.get(column.field) as ImportField;
      if (empty(cells[column.index])) continue;
      const line = lines.get(field.line as string) ?? {};
      const value = convert(draft, column, cells[column.index] ?? null, r + 1);
      if (value !== undefined) line[field.sub] = value;
      lines.set(field.line as string, line);
    }
    for (const [o2m, values] of lines) {
      const list = draft.lines.get(o2m) ?? [];
      list.push({ row: r + 1, values });
      draft.lines.set(o2m, list);
    }
  }

  // Relations: texts to ids, as the user; an unmatched text is an error on its cell.
  const matches: Record<string, Record<string, Match>> = {};
  for (const [key, texts] of relationTexts) {
    const target = (fields.get(key) as ImportField).target as MatchTarget;
    matches[key] = Object.fromEntries(await matchAll(env, target, texts));
  }
  const resolve = (draft: Draft, values: Row, prefix: string, row: number) => {
    for (const [sub, value] of Object.entries(values)) {
      const path = prefix === '' ? sub : `${prefix}.${sub}`;
      const field = fields.get(path) as ImportField;
      if (field.target === null) continue;
      const ids: number[] = [];
      for (const t of Array.isArray(value) ? value : [value]) {
        const text = String(t);
        const match = matches[path]?.[text] as Match;
        if ('id' in match) {
          ids.push(match.id);
          continue;
        }
        fail(draft, {
          row,
          column: columnsByField.get(path) ?? null,
          field: path,
          code: match.error,
          message:
            match.error === 'ambiguous'
              ? `${field.label}: "${text}" matches several records; use its code or external id.`
              : `${field.label}: no record "${text}" was found.`,
        });
      }
      values[sub] = field.kind === 'many2many' ? { set: ids } : ids[0];
    }
  };
  for (const draft of drafts) {
    resolve(draft, draft.values, '', draft.row);
    for (const [o2m, lines] of draft.lines)
      for (const line of lines) resolve(draft, line.values, o2m, line.row);
  }

  // Keys: the existing record of each draft (as the user), duplicates in the file, what the mode allows.
  if (keyField !== undefined && keyColumn !== undefined) {
    const seen = new Set<string>();
    const keyError = (draft: Draft, code: RowErrorCode, message: string) =>
      fail(draft, { row: draft.row, column: keyColumn, field: keyField.key, code, message });
    const byKey = new Map<string, number[]>();
    const keys = drafts.flatMap((d) => (d.key === null ? [] : [d.key]));
    if (keyField.kind === ID_KEY) {
      const ids = keys
        .map((k) => Number(k.replace(/^#/, '')))
        .filter((n) => Number.isSafeInteger(n) && n > 0);
      const found =
        ids.length === 0
          ? []
          : (await ref(env, model.name).search({ where: { id: { in: ids } } })).ids;
      for (const id of found) byKey.set(String(id), [id]);
    } else if (keyField.kind === EXTERNAL_ID_KEY) {
      for (const k of new Set(keys))
        try {
          const id = Number(await env.refId(model.name as never, externalIdOf(k)));
          const visible = await ref(env, model.name).search({ where: { id }, limit: 1 });
          if (visible.length === 1) byKey.set(k, [id]);
        } catch (error) {
          if (!(error instanceof orm.UnknownExternalIdError)) throw error; // unknown: no match
        }
    } else if (keys.length > 0) {
      const found = await ref(env, model.name).search({
        where: { [keyField.key]: { in: [...new Set(keys)] } },
      });
      for (const row of (await found.load([keyField.key])).read([keyField.key])) {
        const k = String(row[keyField.key]);
        byKey.set(k, [...(byKey.get(k) ?? []), row['id'] as number]);
      }
    }
    for (const draft of drafts) {
      if (draft.key === null) {
        if (mode !== 'create')
          keyError(
            draft,
            'missing-key',
            `${keyField.label} is empty: it finds the record to update.`,
          );
        continue;
      }
      const k = keyField.kind === ID_KEY ? draft.key.replace(/^#/, '') : draft.key;
      if (seen.has(k)) {
        keyError(
          draft,
          'duplicate-key',
          `${keyField.label} "${draft.key}" is on an earlier row too.`,
        );
        continue;
      }
      seen.add(k);
      const found = byKey.get(k) ?? [];
      if (found.length > 1)
        keyError(draft, 'ambiguous', `${keyField.label} "${draft.key}" matches several records.`);
      else if (found.length === 1) {
        if (mode === 'create')
          keyError(draft, 'exists', `${keyField.label} "${draft.key}" is an existing record.`);
        else draft.existing = found[0] as number;
      } else if (mode === 'update')
        keyError(draft, 'no-match', `No record has ${keyField.label} "${draft.key}".`);
      else if (keyField.kind === ID_KEY)
        keyError(draft, 'no-match', `No record has the id "${draft.key}"; ids cannot be chosen.`);
    }
  }

  const ready = mappingFailed ? [] : drafts.filter((d) => d.ok);
  const skipped = drafts.length - ready.length;
  const created: number[] = [];
  const updated: number[] = [];
  let undo: UndoData | null = null;
  let failed = 0;
  const failedDrafts = new Set<Draft>();
  const keep = !options.dryRun && (errors.length === 0 || (skip && !mappingFailed));

  // The values of a write: own fields, and the lines (an update replaces them).
  const linesFields = (o2m: string) =>
    [...fields.values()].filter((f) => f.line === o2m && f.kind !== ID_KEY).map((f) => f.sub);
  const valuesOf = (draft: Draft, oldLines: ReadonlyMap<string, readonly number[]>): Row => {
    const values: Row = { ...draft.values };
    for (const [o2m, lines] of draft.lines)
      values[o2m] = {
        ...(oldLines.has(o2m) ? { delete: oldLines.get(o2m) } : {}),
        create: lines.map((l) => l.values),
      };
    return values;
  };
  /** Before values of the drafts to update: the written fields, and the lines they replace. */
  const beforeOf = async (tx: Env, list: readonly Draft[]) => {
    const out = new Map<
      number,
      { before: Row; lines: Record<string, Row[]>; lineIds: Map<string, number[]> }
    >();
    for (const draft of list) {
      const id = draft.existing as number;
      const keys = Object.keys(draft.values);
      const o2ms = [...draft.lines.keys()];
      let records = ref(tx, model.name).browse([id]);
      if (keys.length > 0) records = await records.load(keys);
      if (o2ms.length > 0)
        records = await records.load(Object.fromEntries(o2ms.map((k) => [k, true])));
      const [row] = records.read([...keys, ...o2ms]);
      const before: Row = {};
      for (const key of keys) before[key] = row?.[key] ?? null;
      const lines: Record<string, Row[]> = {};
      const lineIds = new Map<string, number[]>();
      for (const o2m of o2ms) {
        const ids = (row?.[o2m] as number[] | undefined) ?? [];
        lineIds.set(o2m, ids);
        const subs = linesFields(o2m);
        const lineModel = lineModelOf(fields, o2m);
        lines[o2m] =
          ids.length === 0 || lineModel === null
            ? []
            : (await ref(tx, lineModel).browse(ids).load(subs))
                .read(subs)
                .map(({ id: _, ...rest }) => rest);
      }
      out.set(id, { before, lines, lineIds });
    }
    return out;
  };
  const write = async (tx: Env, list: readonly Draft[]) => {
    const creates = list.filter((d) => d.existing === null);
    const updates = list.filter((d) => d.existing !== null);
    const before = await beforeOf(tx, updates);
    const made =
      creates.length === 0
        ? []
        : (await ref(tx, model.name).create(creates.map((d) => valuesOf(d, new Map())))).ids;
    for (const [i, draft] of creates.entries())
      if (keyField?.kind === EXTERNAL_ID_KEY && draft.key !== null)
        await tx.setExternalId(model.name as never, made[i] as number, externalIdOf(draft.key));
    for (const draft of updates)
      await ref(tx, model.name)
        .browse([draft.existing as number])
        .write(valuesOf(draft, before.get(draft.existing as number)?.lineIds ?? new Map()));
    await tx.flush();
    return { made: [...made], updates: updates.map((d) => d.existing as number), before };
  };

  try {
    await env.transaction(async (tx) => {
      const done: {
        made: number[];
        updates: number[];
        before: Awaited<ReturnType<typeof beforeOf>>;
      }[] = [];
      // Batches of records, each in a savepoint; a failing batch again record by record, to find each failure.
      await options.onProgress?.(0, ready.length);
      for (let start = 0; start < ready.length; start += WRITE_BATCH) {
        const batch = ready.slice(start, start + WRITE_BATCH);
        try {
          done.push(await tx.transaction((b) => write(b, batch)));
        } catch (error) {
          if (problemOf(error).status >= 500) throw error;
          for (const draft of batch)
            try {
              done.push(await tx.transaction((one) => write(one, [draft])));
            } catch (rowError) {
              failed += 1;
              failedDrafts.add(draft);
              errors.push(...writeErrors(rowError, draft.row, columnsByField));
            }
        }
        await options.onProgress?.(Math.min(start + WRITE_BATCH, ready.length), ready.length);
      }
      for (const d of done) {
        created.push(...d.made);
        updated.push(...d.updates);
      }
      if (!keep || (!skip && errors.length > 0)) throw new Rollback();
      const touched = [...created, ...updated];
      const stamps: Record<string, string> = {};
      if (touched.length > 0)
        for (const row of (await ref(tx, model.name).browse(touched).load(['updatedAt'])).read([
          'updatedAt',
        ]))
          stamps[String(row['id'])] = String(row['updatedAt']);
      undo = {
        created,
        updated: done.flatMap((d) =>
          [...d.before].map(([id, b]) => ({ id, before: b.before, lines: b.lines })),
        ),
        stamps,
      };
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
    const wouldCreate = created.length;
    const rejectedRows = drafts.filter((d) => !d.ok || failedDrafts.has(d)).flatMap((d) => d.rows);
    const wouldUpdate = updated.length;
    return {
      rows: drafts.length,
      created: [],
      updated: [],
      wouldCreate: options.dryRun ? wouldCreate : 0,
      wouldUpdate: options.dryRun ? wouldUpdate : 0,
      skipped: skip ? skipped + failed : 0,
      rejectedRows: skip ? rejectedRows : [],
      errors: sortErrors(errors),
      matches,
      undo: null,
    };
  }
  return {
    rows: drafts.length,
    created,
    updated,
    wouldCreate: 0,
    wouldUpdate: 0,
    skipped: skipped + failed,
    rejectedRows: drafts.filter((d) => !d.ok || failedDrafts.has(d)).flatMap((d) => d.rows),
    errors: sortErrors(errors),
    matches,
    undo,
  };
}

function sortErrors(errors: readonly RowError[]): RowError[] {
  return [...errors].sort((a, b) => a.row - b.row || (a.column ?? -1) - (b.column ?? -1));
}

/** The model of a one2many's lines, from its line fields. */
function lineModelOf(fields: ReadonlyMap<string, ImportField>, o2m: string): string | null {
  return fields.get(o2m)?.target?.model ?? null;
}

/** A value as `read()` gave it, as a write takes it back. */
function writable(kind: string, value: unknown): unknown {
  if (value === null || value === undefined) return value === undefined ? null : value;
  if (kind === 'many2many') return { set: value };
  if (kind === 'datetime' && typeof value === 'string') return new Date(value);
  if (typeof value === 'object' && !Array.isArray(value) && 'amount' in value)
    return (value as { amount: unknown }).amount; // money: the amount (the currency is its own field)
  return value;
}

export interface UndoResult {
  readonly deleted: number;
  readonly restored: number;
  /** Records changed since the import: left as they are. */
  readonly changed: readonly number[];
}

/**
 * Undoes an import (RFC 0014 §5.5), as the user: deletes the records it created and restores the values it changed,
 * for the records nobody changed since (their `updatedAt` is still the import's). The others are listed.
 */
export async function undoImport(
  env: Env,
  model: ApiModel,
  fields: ReadonlyMap<string, ImportField>,
  undo: UndoData,
): Promise<UndoResult> {
  const touched = [...undo.created, ...undo.updated.map((u) => u.id)];
  const current = new Map<number, string>();
  if (touched.length > 0) {
    const found = await ref(env, model.name).search({ where: { id: { in: touched } } });
    for (const row of (await found.load(['updatedAt'])).read(['updatedAt']))
      current.set(row['id'] as number, String(row['updatedAt']));
  }
  const unchanged = (id: number) => current.has(id) && current.get(id) === undo.stamps[String(id)];
  const changed = touched.filter((id) => current.has(id) && !unchanged(id));
  const toDelete = undo.created.filter(unchanged);
  if (toDelete.length > 0) await ref(env, model.name).browse(toDelete).unlink();
  let restored = 0;
  for (const u of undo.updated) {
    if (!unchanged(u.id)) continue;
    const values: Row = {};
    for (const [key, value] of Object.entries(u.before))
      values[key] = writable(fields.get(key)?.kind ?? '', value);
    for (const [o2m, lines] of Object.entries(u.lines)) {
      let records = ref(env, model.name).browse([u.id]);
      records = await records.load({ [o2m]: true });
      const [row] = records.read([o2m]);
      values[o2m] = {
        delete: (row?.[o2m] as number[] | undefined) ?? [],
        create: lines.map((line) =>
          Object.fromEntries(
            Object.entries(line).map(([sub, v]) => [
              sub,
              writable(fields.get(`${o2m}.${sub}`)?.kind ?? '', v),
            ]),
          ),
        ),
      };
    }
    await ref(env, model.name).browse([u.id]).write(values);
    restored += 1;
  }
  await env.flush();
  return { deleted: toDelete.length, restored, changed };
}

/** What `importFields` needs to know about the models. */
export interface ImportModels {
  readonly models: ReadonlyMap<string, ApiModel>;
  /** How records of a model are found from text (its name field, its unique char fields). */
  targets(model: string): MatchTarget | null;
  /** The many2one a one2many's lines point back with. */
  inverseOf(model: string, field: string): string | null;
}

function fieldEntries(
  env: Env,
  model: ApiModel,
  catalog: ImportModels,
  line: string | null,
): ImportField[] {
  const out: ImportField[] = [];
  const keys = new Set(catalog.targets(model.name)?.keys ?? []);
  for (const f of model.fields) {
    if (f.readonly || !importable(f.kind) || f.key === 'id' || f.key === 'company') continue;
    if (!env.access.canField(model.name as never, f.key, 'write')) continue;
    let target: MatchTarget | null = null;
    if (f.kind === 'many2one' || f.kind === 'many2many') {
      if (f.target === null || !env.access.can(f.target as never, 'read')) continue;
      target = catalog.targets(f.target);
      if (target === null) continue;
    }
    out.push({
      key: line === null ? f.key : `${line}.${f.key}`,
      kind: f.kind,
      label: f.label,
      required: f.requiredOnCreate && f.kind !== 'many2many', // a set is never missing: it is empty
      options: f.options,
      target,
      line,
      sub: f.key,
      keyable: line === null && keys.has(f.key),
    });
  }
  return out;
}

/**
 * The fields of `model` the user may fill by import, by path: its own, the key columns (`id`, `externalId`), and
 * the fields of the lines of each one2many the user may write and whose lines they may create (without the link
 * back to the record).
 */
export function importFields(
  env: Env,
  model: ApiModel,
  catalog: ImportModels,
): Map<string, ImportField> {
  const out = new Map<string, ImportField>();
  const key = (k: string, label: string): ImportField => ({
    key: k,
    kind: k,
    label,
    required: false,
    options: null,
    target: null,
    line: null,
    sub: k,
    keyable: true,
  });
  out.set(ID_KEY, key(ID_KEY, 'ID'));
  out.set(EXTERNAL_ID_KEY, key(EXTERNAL_ID_KEY, 'External ID'));
  for (const f of fieldEntries(env, model, catalog, null)) out.set(f.key, f);
  for (const f of model.fields) {
    if (f.kind !== 'one2many' || f.readonly || f.target === null) continue;
    const lines = catalog.models.get(f.target);
    if (
      lines === undefined ||
      !env.access.canField(model.name as never, f.key, 'write') ||
      !env.access.can(f.target as never, 'create')
    )
      continue;
    const inverse = catalog.inverseOf(model.name, f.key);
    // The one2many itself, for its lines' model (not a column of its own).
    out.set(f.key, {
      key: f.key,
      kind: 'one2many',
      label: f.label,
      required: false,
      options: null,
      target: { model: f.target, recName: lines.recName ?? 'name', keys: [] },
      line: null,
      sub: f.key,
      keyable: false,
    });
    for (const sub of fieldEntries(env, lines, catalog, f.key))
      if (sub.sub !== inverse)
        out.set(sub.key, { ...sub, label: `${f.label} › ${sub.label}`, required: false });
  }
  return out;
}
