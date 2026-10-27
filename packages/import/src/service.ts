/**
 * What the import routes and the background worker share (RFC 0014): reading sessions as their user, the fields of
 * a model, options, saved mappings and module templates, running an import and recording its outcome.
 */
import {
  type ApiModel,
  announceChange,
  audit,
  HttpProblem,
  type KoshRegistry,
  publicApiModels,
} from '@kosh/server';
import type { Driver, Env, Shutro } from '@kosh/server/orm';
import type { Cell } from './convert.js';
import { readCsv } from './csv.js';
import { type ColumnMapping, normalize } from './mapping.js';
import type { MatchTarget } from './match.js';
import {
  type ImportField,
  type ImportModels,
  type ImportOptions,
  type ImportResult,
  importFields,
  type RowError,
  runImport,
  type UndoData,
} from './run.js';
import { readXlsx, XlsxError, xlsxSheetNames } from './xlsx.js';

type Row = Record<string, unknown>;
export interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
  write(values: unknown): Promise<void>;
  unlink(): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Rows>;
  create(rows: readonly unknown[]): Promise<Rows>;
}
export const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;

/** Rows a file may have (`KOSH_IMPORT_MAX_ROWS`). */
export const IMPORT_ROWS = 1_000_000;
/** Rows run within the request; larger files run as a background job (RFC 0014 §5.3). */
export const INLINE_ROWS = 2_000;
/** The default file size limit (`KOSH_IMPORT_MAX_BYTES`). */
export const IMPORT_MAX_BYTES = 50_000_000;
/** How long an import can be undone (RFC 0014 §5.5). */
export const UNDO_DAYS = 7;
/** The background job that runs an import or its dry run: `{ session, dryRun }`. */
export const RUN_JOB = 'import.run';
/** The event a background run emits when it ends (a notification for its user). */
export const FINISHED_TOPIC = 'import.finished';
/** Rows of the file shown with the mapping. */
const SAMPLE_ROWS = 5;

const DATE_ORDERS = ['dmy', 'mdy', 'ymd'];
const MODES = ['create', 'update', 'upsert'];

const invalid = (detail: string) =>
  new HttpProblem(400, 'invalid-options', 'Invalid options', detail);

/** The options of a mapping request (or a template), checked. */
export function parseOptions(input: unknown): ImportOptions {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw invalid('options is an object.');
  const o = input as Record<string, unknown>;
  const out: { -readonly [K in keyof ImportOptions]: ImportOptions[K] } = {};
  if (o['dateOrder'] !== undefined) {
    if (!DATE_ORDERS.includes(String(o['dateOrder'])))
      throw invalid('dateOrder is dmy, mdy or ymd.');
    out.dateOrder = o['dateOrder'] as 'dmy' | 'mdy' | 'ymd';
  }
  if (o['decimal'] !== undefined) {
    if (o['decimal'] !== '.' && o['decimal'] !== ',') throw invalid('decimal is "." or ",".');
    out.decimal = o['decimal'];
  }
  if (o['timeZone'] !== undefined) {
    const zone = String(o['timeZone']);
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
    } catch {
      throw invalid(`No time zone '${zone}'.`);
    }
    out.timeZone = zone;
  }
  if (o['headerRow'] !== undefined) out.headerRow = o['headerRow'] === true;
  if (o['mode'] !== undefined) {
    if (!MODES.includes(String(o['mode']))) throw invalid('mode is create, update or upsert.');
    out.mode = o['mode'] as 'create' | 'update' | 'upsert';
  }
  if (o['onError'] !== undefined) {
    if (o['onError'] !== 'stop' && o['onError'] !== 'skip')
      throw invalid('onError is stop or skip.');
    out.onError = o['onError'];
  }
  if (o['key'] !== undefined && o['key'] !== null) out.key = String(o['key']);
  return out;
}

/** A result as the API shows it: undo data stays on the server. */
export const shown = ({ undo: _, ...result }: ImportResult): Omit<ImportResult, 'undo'> => result;

export const isXlsx = (bytes: Uint8Array): boolean =>
  bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

/** The cells of a file. @throws {HttpProblem} 422 when it cannot be read */
export function readTable(bytes: Uint8Array, type: 'csv' | 'xlsx', sheet: string | null): Cell[][] {
  try {
    return type === 'xlsx' ? readXlsx(bytes, sheet ?? undefined).rows : readCsv(bytes).rows;
  } catch (error) {
    if (!(error instanceof XlsxError)) throw error;
    throw new HttpProblem(422, 'unreadable-file', 'The file cannot be read', error.message);
  }
}

export const dataRows = (table: readonly (readonly Cell[])[], options: ImportOptions): number =>
  Math.max(0, table.length - (options.headerRow === false ? 0 : 1));

export interface Session {
  readonly id: number;
  readonly rows: Rows;
  readonly model: ApiModel;
  readonly fileName: string;
  readonly fileType: 'csv' | 'xlsx';
  readonly file: Uint8Array;
  readonly sheet: string | null;
  readonly columns: readonly ColumnMapping[];
  readonly options: ImportOptions;
  readonly state: string;
  readonly rowCount: number;
  readonly undo: UndoData | null;
  /** The errors and the file rows of the records left out. */
  readonly rejected: { readonly errors: readonly RowError[]; readonly rows: readonly number[] };
  readonly importedAt: Date | null;
  readonly result: unknown;
  readonly resultDry: boolean;
  readonly failure: string | null;
}

const SESSION_FIELDS = [
  'resModel',
  'fileName',
  'fileType',
  'file',
  'sheet',
  'columns',
  'options',
  'state',
  'rowCount',
  'undo',
  'rejected',
  'importedAt',
  'result',
  'resultDry',
  'failure',
];

/** A saved mapping or a module's template, as the screen lists them. */
export interface SavedMapping {
  /** A record id, or `module.key` for a template. */
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly template: boolean;
  readonly shared: boolean;
  readonly own: boolean;
  readonly columns: readonly { readonly header: string; readonly field: string }[];
  readonly options: ImportOptions;
}

export interface ImportContext {
  readonly shutro: Shutro;
  readonly driver: Driver;
  readonly registry: KoshRegistry;
}

export type ImportService = ReturnType<typeof createImportService>;

export function createImportService(
  context: ImportContext,
  limits: { readonly inlineRows?: number } = {},
) {
  const inlineRows = limits.inlineRows ?? INLINE_ROWS;
  const { driver, shutro } = context;
  const registry = context.registry.registry;
  const models = publicApiModels(context.registry);

  /** How records of `name` are found from text: its name field and its own unique char fields. */
  const targets = (name: string): MatchTarget | null => {
    if (!registry.models.has(name as never)) return null;
    const description = registry.describe(name as never);
    const keys = new Set<string>();
    const unique = [
      ...description.sqlConstraints.filter((c) => c.kind === 'unique').map((c) => c.fields),
      ...description.indexes.filter((i) => i.unique && !i.partial).map((i) => i.fields),
    ];
    for (const fields of unique) {
      const own = fields.filter((f) => f !== 'company');
      const [only] = own;
      if (own.length === 1 && only !== undefined && description.fields[only]?.kind === 'char')
        keys.add(only);
    }
    return { model: name, recName: description.recName, keys: [...keys] };
  };
  const catalog: ImportModels = {
    models,
    targets,
    inverseOf: (model, field) => {
      const raw = registry.get(model as never).model.fields as unknown as Readonly<
        Record<string, { readonly inverseField?: unknown }>
      >;
      const inverse = raw[field]?.inverseField;
      return typeof inverse === 'string' ? inverse : null;
    },
  };

  const guard = (env: Env): void => {
    if (!env.administrator && !env.groups.has('import.user'))
      throw new HttpProblem(
        403,
        'access',
        'Import users only',
        'Importing data needs the Import data access level.',
      );
  };
  /** The model a user may import into. */
  const modelFor = (env: Env, name: string): ApiModel => {
    const model = models.get(name);
    if (model === undefined)
      throw new HttpProblem(404, 'unknown-model', 'Unknown model', `No model is named '${name}'.`);
    env.access.check(name as never, 'import');
    // Creating or updating: one of them, checked again for the mode of the run.
    if (!env.access.can(name as never, 'create')) env.access.check(name as never, 'write');
    return model;
  };
  const fieldsOf = (env: Env, model: ApiModel): Map<string, ImportField> =>
    importFields(env, model, catalog);
  /** The fields a column may fill (not the one2many fields themselves: their lines' fields). */
  const columnFields = (fields: ReadonlyMap<string, ImportField>): ImportField[] =>
    [...fields.values()].filter((f) => f.kind !== 'one2many');

  /** The caller's session `id` (a record rule hides the others: 404). */
  const sessionOf = async (env: Env, id: number): Promise<Session> => {
    guard(env);
    const rows = await ref(env, 'import.session').search({ where: { id }, limit: 1 });
    const [row] = (await rows.load(SESSION_FIELDS)).read(SESSION_FIELDS);
    if (rows.length === 0 || row === undefined)
      throw new HttpProblem(404, 'not-found', 'No such import', `No import #${id} of yours.`);
    return {
      id,
      rows,
      model: modelFor(env, String(row['resModel'])),
      fileName: String(row['fileName']),
      fileType: row['fileType'] === 'xlsx' ? 'xlsx' : 'csv',
      file: row['file'] as Uint8Array,
      sheet: typeof row['sheet'] === 'string' ? row['sheet'] : null,
      columns: (row['columns'] as ColumnMapping[] | null) ?? [],
      options: (row['options'] as ImportOptions | null) ?? {},
      state: String(row['state']),
      rowCount: Number(row['rowCount']),
      undo: (row['undo'] as UndoData | null) ?? null,
      rejected: (row['rejected'] as Session['rejected'] | null) ?? { errors: [], rows: [] },
      importedAt: typeof row['importedAt'] === 'string' ? new Date(row['importedAt']) : null,
      result: row['result'] ?? null,
      resultDry: row['resultDry'] === true,
      failure: typeof row['failure'] === 'string' ? row['failure'] : null,
    };
  };

  /** How far a background run is (the progress row is the system's). */
  const progressOf = (env: Env, session: number) =>
    env.asSuperuser({ reason: 'import progress' }, async (su) => {
      const found = await ref(su, 'import.progress').search({ where: { session }, limit: 1 });
      const [row] = (await found.load(['done', 'total'])).read(['done', 'total']);
      return row === undefined ? null : { done: Number(row['done']), total: Number(row['total']) };
    });
  const writeProgress = async (su: Env, session: number, done: number, total: number) => {
    const found = await ref(su, 'import.progress').search({ where: { session }, limit: 1 });
    if (found.length === 0) await ref(su, 'import.progress').create([{ session, done, total }]);
    else await found.write({ done, total });
  };
  /** Starts a run's progress in the caller's transaction (it commits with the job it announces). */
  const startProgress = (env: Env, session: number, total: number) =>
    env.asSuperuser({ reason: 'import progress' }, (su) => writeProgress(su, session, 0, total));
  /** Writes progress in a short transaction of its own, so others see it while the run's goes on. */
  const reportProgress = (company: number, session: number, done: number, total: number) =>
    shutro.bootstrap({ reason: 'import progress', company }, (su) =>
      writeProgress(su, session, done, total),
    );

  /** What the screen shows of a session. */
  const describe = async (env: Env, session: Session, table: readonly (readonly Cell[])[]) => {
    const fields = fieldsOf(env, session.model);
    const header = session.options.headerRow === false ? [] : (table[0] ?? []);
    return {
      id: session.id,
      model: session.model.name,
      fileName: session.fileName,
      fileType: session.fileType,
      sheet: session.sheet,
      sheets: session.fileType === 'xlsx' ? xlsxSheetNames(session.file) : [],
      state: session.state,
      rowCount: session.rowCount,
      background: session.rowCount > inlineRows,
      headers: header.map((c) => (c === null ? '' : String(c))),
      sample: table
        .slice(session.options.headerRow === false ? 0 : 1, SAMPLE_ROWS + 1)
        .map((r) => r.map((c) => (c instanceof Date ? c.toISOString() : c))),
      columns: session.columns,
      options: session.options,
      fields: columnFields(fields).map((f) => ({
        key: f.key,
        kind: f.kind,
        label: f.label,
        required: f.required,
        keyable: f.keyable,
        ...(f.line === null ? {} : { line: f.line }),
        ...(f.target === null ? {} : { target: f.target.model }),
      })),
      progress: session.state === 'running' ? await progressOf(env, session.id) : null,
      result: session.result,
      resultDry: session.resultDry,
      failure: session.failure,
      importedAt: session.importedAt?.toISOString() ?? null,
      undoUntil:
        session.state === 'done' && session.importedAt !== null && session.undo !== null
          ? new Date(session.importedAt.getTime() + UNDO_DAYS * 86_400_000).toISOString()
          : null,
      rejected: session.rejected.rows.length,
    };
  };

  /** The saved mappings the user sees for `model`, and the templates installed modules ship for it. */
  const mappingsFor = async (env: Env, model: string): Promise<SavedMapping[]> => {
    const templates: SavedMapping[] = context.registry.loaded.modules.flatMap((m) =>
      (m.importTemplates ?? [])
        .filter((t) => t.model === model)
        .map((t) => ({
          id: `${m.name}.${t.key}`,
          name: t.label,
          model,
          template: true,
          shared: true,
          own: false,
          columns: t.columns,
          options: parseOptions(t.options),
        })),
    );
    const keys = ['name', 'user', 'shared', 'columns', 'options'];
    const found = await ref(env, 'import.mapping').search({ where: { resModel: model } });
    const saved = (await found.load(keys)).read(keys).map(
      (row): SavedMapping => ({
        id: String(row['id']),
        name: String(row['name']),
        model,
        template: false,
        shared: row['shared'] === true,
        own: row['user'] === env.uid,
        columns: (row['columns'] as SavedMapping['columns'] | null) ?? [],
        options: (row['options'] as ImportOptions | null) ?? {},
      }),
    );
    return [...templates, ...saved];
  };
  /** The mapping whose every header the file has, the one with the most columns; null when none fits. */
  const fitting = (
    mappings: readonly SavedMapping[],
    headers: readonly string[],
  ): SavedMapping | null => {
    const present = new Set(headers.map(normalize));
    let best: SavedMapping | null = null;
    for (const m of mappings)
      if (
        m.columns.length > 0 &&
        m.columns.every((c) => present.has(normalize(c.header))) &&
        (best === null || m.columns.length > best.columns.length)
      )
        best = m;
    return best;
  };
  /** The columns of a file under a saved mapping: by header; fields the user may not import are left out. */
  const applyMapping = (
    mapping: SavedMapping,
    headers: readonly string[],
    fields: ReadonlyMap<string, ImportField>,
  ): ColumnMapping[] => {
    const byHeader = new Map(mapping.columns.map((c) => [normalize(c.header), c.field]));
    const taken = new Set<string>();
    return headers.map((header, index) => {
      const field = byHeader.get(normalize(header)) ?? null;
      if (
        field === null ||
        taken.has(field) ||
        !fields.has(field) ||
        fields.get(field)?.kind === 'one2many'
      )
        return { index, header, field: null };
      taken.add(field);
      return { index, header, field };
    });
  };

  /** Runs the session's import (or its dry run) as `env`'s user, with the checks of its mode. */
  const execute = async (
    env: Env,
    session: Session,
    dryRun: boolean,
    onProgress?: (done: number, total: number) => Promise<void>,
  ): Promise<ImportResult> => {
    const mode = session.options.mode ?? 'create';
    if (mode !== 'update') env.access.check(session.model.name as never, 'create');
    if (mode !== 'create') env.access.check(session.model.name as never, 'write');
    const table = readTable(session.file, session.fileType, session.sheet);
    return runImport(env, session.model, fieldsOf(env, session.model), table, session.columns, {
      ...session.options,
      dryRun,
      ...(onProgress === undefined ? {} : { onProgress }),
    });
  };

  /** Records the outcome of a run on the session; a kept import is announced and audited. */
  const record = async (
    env: Env,
    session: Session,
    result: ImportResult,
    dryRun: boolean,
    ip?: string,
  ): Promise<void> => {
    const view = shown(result);
    if (dryRun || result.undo === null) {
      await session.rows.write({ state: 'draft', result: view, resultDry: dryRun, failure: null });
      return;
    }
    await session.rows.write({
      state: 'done',
      createdIds: [...result.created],
      undo: result.undo,
      rejected: { errors: [...result.errors], rows: [...result.rejectedRows] },
      importedAt: new Date(),
      result: view,
      resultDry: false,
      failure: null,
    });
    if (result.created.length > 0)
      announceChange(env, driver, {
        model: session.model.name,
        ids: [...result.created],
        op: 'create',
      });
    if (result.updated.length > 0)
      announceChange(env, driver, {
        model: session.model.name,
        ids: [...result.updated],
        op: 'update',
      });
    await audit(env, {
      kind: 'data.import',
      summary: `Imported ${session.fileName} into ${session.model.name}: ${result.created.length} created, ${result.updated.length} updated, ${result.skipped} left out.`,
      targetModel: session.model.name,
      details: {
        created: result.created.length,
        updated: result.updated.length,
        skipped: result.skipped,
        file: session.fileName,
        session: session.id,
      },
      ...(ip === undefined ? {} : { ip }),
    });
  };

  return {
    inlineRows,
    catalog,
    guard,
    modelFor,
    fieldsOf,
    columnFields,
    sessionOf,
    progressOf,
    startProgress,
    reportProgress,
    describe,
    mappingsFor,
    fitting,
    applyMapping,
    execute,
    record,
  };
}
