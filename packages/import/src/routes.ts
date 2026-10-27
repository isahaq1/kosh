/**
 * The import API (RFC 0014 §5.7), for holders of `import.user` (and administrators) who also have the `import` and
 * `create` permissions on the model, checked on every call:
 *
 * - `POST /api/v1/imports?model=…[&sheet=…]`  the file as the body (`X-Filename`) → the session: headers, the first
 *                                              rows, the guessed mapping and the importable fields
 * - `GET  /api/v1/imports/:id`                 the same, later
 * - `PUT  /api/v1/imports/:id/mapping`         `{ columns: [{ index, field }], options }`
 * - `POST /api/v1/imports/:id/dry-run`         the whole import, rolled back: per-row errors and relation matches
 * - `POST /api/v1/imports/:id/commit`          the import, all-or-nothing (`Idempotency-Key`), audited
 *
 * Sessions are the uploader's own (a record rule); files are read on the server, never evaluated.
 */
import {
  type ApiModel,
  announceChange,
  audit,
  HttpProblem,
  idempotent,
  type ModuleContext,
  publicApiModels,
} from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Cell } from './convert.js';
import { readCsv } from './csv.js';
import { type ColumnMapping, guessMapping } from './mapping.js';
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
  undoImport,
} from './run.js';
import { readXlsx, XlsxError, xlsxSheetNames } from './xlsx.js';

type Row = Record<string, unknown>;
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
  write(values: unknown): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Rows>;
  create(rows: readonly unknown[]): Promise<Rows>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;

/** Rows imported within a request (larger files run as jobs, RFC 0014 step 3). */
export const IMPORT_ROWS = 10_000;
/** The default file size limit (`KOSH_IMPORT_MAX_BYTES`). */
export const IMPORT_MAX_BYTES = 50_000_000;
/** Rows of the file shown with the mapping. */
const SAMPLE_ROWS = 5;

export interface ImportRoutesOptions {
  /** Bytes per file. */
  readonly maxBytes?: number;
  /** Rows per import. */
  readonly maxRows?: number;
}

const DATE_ORDERS = ['dmy', 'mdy', 'ymd'];
const MODES = ['create', 'update', 'upsert'];
/** How long an import can be undone (RFC 0014 §5.5). */
export const UNDO_DAYS = 7;

/** The options of a mapping request, checked. */
function parseOptions(input: unknown): ImportOptions {
  if (input === undefined) return {};
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new HttpProblem(400, 'invalid-options', 'Invalid options', 'options is an object.');
  const o = input as Record<string, unknown>;
  const out: { -readonly [K in keyof ImportOptions]: ImportOptions[K] } = {};
  if (o['dateOrder'] !== undefined) {
    if (!DATE_ORDERS.includes(String(o['dateOrder'])))
      throw new HttpProblem(
        400,
        'invalid-options',
        'Invalid options',
        'dateOrder is dmy, mdy or ymd.',
      );
    out.dateOrder = o['dateOrder'] as 'dmy' | 'mdy' | 'ymd';
  }
  if (o['decimal'] !== undefined) {
    if (o['decimal'] !== '.' && o['decimal'] !== ',')
      throw new HttpProblem(400, 'invalid-options', 'Invalid options', 'decimal is "." or ",".');
    out.decimal = o['decimal'];
  }
  if (o['timeZone'] !== undefined) {
    const zone = String(o['timeZone']);
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
    } catch {
      throw new HttpProblem(400, 'invalid-options', 'Invalid options', `No time zone '${zone}'.`);
    }
    out.timeZone = zone;
  }
  if (o['headerRow'] !== undefined) out.headerRow = o['headerRow'] === true;
  if (o['mode'] !== undefined) {
    if (!MODES.includes(String(o['mode'])))
      throw new HttpProblem(
        400,
        'invalid-options',
        'Invalid options',
        'mode is create, update or upsert.',
      );
    out.mode = o['mode'] as 'create' | 'update' | 'upsert';
  }
  if (o['onError'] !== undefined) {
    if (o['onError'] !== 'stop' && o['onError'] !== 'skip')
      throw new HttpProblem(400, 'invalid-options', 'Invalid options', 'onError is stop or skip.');
    out.onError = o['onError'];
  }
  if (o['key'] !== undefined && o['key'] !== null) out.key = String(o['key']);
  return out;
}

/** A cell of the rejected-rows file: quoted when needed; formulas kept as text (never run by a spreadsheet). */
function csvCell(cell: Cell): string {
  let text =
    cell === null
      ? ''
      : cell instanceof Date
        ? cell.toISOString().replace(/T00:00:00\.000Z$/, '')
        : String(cell);
  if (/^[=+@\t\r]/.test(text) || /^-[^\d.]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A result as the API shows it: undo data stays on the server. */
const shown = ({ undo: _, ...result }: ImportResult) => result;

const isXlsx = (bytes: Uint8Array) =>
  bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

/** The cells of a file. @throws {HttpProblem} 422 when it cannot be read */
function readTable(bytes: Uint8Array, type: 'csv' | 'xlsx', sheet: string | null): Cell[][] {
  try {
    return type === 'xlsx' ? readXlsx(bytes, sheet ?? undefined).rows : readCsv(bytes).rows;
  } catch (error) {
    if (!(error instanceof XlsxError)) throw error;
    throw new HttpProblem(422, 'unreadable-file', 'The file cannot be read', error.message);
  }
}

export function registerImportRoutes(
  context: ModuleContext,
  options: ImportRoutesOptions = {},
): void {
  const { app, driver } = context;
  const registry = context.registry.registry;
  const models = publicApiModels(context.registry);
  const maxBytes = options.maxBytes ?? IMPORT_MAX_BYTES;
  const maxRows = options.maxRows ?? IMPORT_ROWS;

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
  const idOf = (params: unknown): number => {
    const id = Number((params as { id?: unknown }).id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'The id is a positive integer.');
    return id;
  };

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
    'createdIds',
    'undo',
    'rejected',
    'importedAt',
  ];
  interface Session {
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
    readonly createdIds: readonly number[];
    readonly undo: UndoData | null;
    /** The errors and the file rows of the records left out. */
    readonly rejected: { readonly errors: readonly RowError[]; readonly rows: readonly number[] };
    readonly importedAt: Date | null;
  }
  /** The caller's session `id` (a record rule hides the others: 404). */
  const sessionOf = async (env: Env, id: number): Promise<Session> => {
    guard(env);
    const rows = await ref(env, 'import.session').search({ where: { id }, limit: 1 });
    const [row] = (await rows.load(SESSION_FIELDS)).read(SESSION_FIELDS);
    if (rows.length === 0 || row === undefined)
      throw new HttpProblem(404, 'not-found', 'No such import', `No import #${id} of yours.`);
    const model = modelFor(env, String(row['resModel']));
    return {
      id,
      rows,
      model,
      fileName: String(row['fileName']),
      fileType: row['fileType'] === 'xlsx' ? 'xlsx' : 'csv',
      file: row['file'] as Uint8Array,
      sheet: typeof row['sheet'] === 'string' ? row['sheet'] : null,
      columns: (row['columns'] as ColumnMapping[] | null) ?? [],
      options: (row['options'] as ImportOptions | null) ?? {},
      state: String(row['state']),
      rowCount: Number(row['rowCount']),
      createdIds: (row['createdIds'] as number[] | null) ?? [],
      undo: (row['undo'] as UndoData | null) ?? null,
      rejected: (row['rejected'] as Session['rejected'] | null) ?? { errors: [], rows: [] },
      importedAt: typeof row['importedAt'] === 'string' ? new Date(row['importedAt']) : null,
    };
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
  const fieldsOf = (env: Env, model: ApiModel): Map<string, ImportField> =>
    importFields(env, model, catalog);
  /** The fields a column may fill (not the one2many fields themselves: their lines' fields). */
  const columnFields = (fields: ReadonlyMap<string, ImportField>) =>
    [...fields.values()].filter((f) => f.kind !== 'one2many');

  /** What the wizard shows of a session. */
  const describe = (env: Env, session: Session, table: readonly (readonly Cell[])[]) => {
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
      importedAt: session.importedAt?.toISOString() ?? null,
      undoUntil:
        session.state === 'done' && session.importedAt !== null && session.undo !== null
          ? new Date(session.importedAt.getTime() + UNDO_DAYS * 86_400_000).toISOString()
          : null,
      rejected: session.rejected.rows.length,
    };
  };
  const dataRows = (table: readonly (readonly Cell[])[], options: ImportOptions) =>
    Math.max(0, table.length - (options.headerRow === false ? 0 : 1));

  // Uploads: the body is the file. Own parser in an encapsulated context; the caller is checked before reading it.
  app.register(async (uploads: FastifyInstance) => {
    uploads.removeAllContentTypeParsers();
    uploads.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: maxBytes },
      (_req, body, done) => done(null, body),
    );
    uploads.addHook('onRequest', async (request) => {
      if (request.identity === null)
        throw new HttpProblem(401, 'unauthenticated', 'Sign in required', 'Sign in first.');
    });
    uploads.post('/api/v1/imports', async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const name = String(q['model'] ?? '');
      const sheet = typeof q['sheet'] === 'string' && q['sheet'] !== '' ? q['sheet'] : null;
      const body = request.body;
      if (!(body instanceof Uint8Array) || body.byteLength === 0)
        throw new HttpProblem(400, 'invalid-body', 'Empty file', 'The request body is the file.');
      let fileName = 'import';
      try {
        const header = request.headers['x-filename'];
        fileName = decodeURIComponent(typeof header === 'string' ? header : 'import').slice(0, 255);
      } catch {
        throw new HttpProblem(
          400,
          'invalid-name',
          'Invalid file name',
          'X-Filename is URI-encoded.',
        );
      }
      const file = new Uint8Array(body);
      const fileType = isXlsx(file) ? 'xlsx' : 'csv';
      const table = readTable(file, fileType, sheet);
      const created = await request.env(
        async (env) => {
          guard(env);
          const model = modelFor(env, name);
          const rowCount = dataRows(table, {});
          if (rowCount > maxRows)
            throw new HttpProblem(
              413,
              'too-many-rows',
              'Too many rows',
              `The file has ${rowCount} rows; at most ${maxRows} are imported at once.`,
              'Split the file.',
            );
          const columns = guessMapping(
            (table[0] ?? []).map((c) => (c === null ? '' : String(c))),
            columnFields(fieldsOf(env, model)),
          );
          const rows = await ref(env, 'import.session').create([
            {
              user: env.uid,
              resModel: model.name,
              fileName,
              fileType,
              file,
              sheet,
              columns,
              options: {},
              rowCount,
            },
          ]);
          const id = rows.ids[0] as number;
          return describe(env, await sessionOf(env, id), table);
        },
        { write: true },
      );
      return reply.code(201).send(created);
    });
  });

  app.get('/api/v1/imports/:id', async (request) =>
    request.env(async (env) => {
      const session = await sessionOf(env, idOf(request.params));
      return describe(env, session, readTable(session.file, session.fileType, session.sheet));
    }),
  );

  app.put('/api/v1/imports/:id/mapping', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const input = body['columns'];
    if (!Array.isArray(input))
      throw new HttpProblem(400, 'invalid-columns', 'Invalid columns', 'columns is an array.');
    const options = parseOptions(body['options']);
    return request.env(
      async (env) => {
        const session = await sessionOf(env, idOf(request.params));
        if (session.state !== 'draft')
          throw new HttpProblem(409, 'imported', 'Already imported', 'This file was imported.');
        const table = readTable(session.file, session.fileType, session.sheet);
        const headers = options.headerRow === false ? [] : (table[0] ?? []);
        const width = Math.max(0, ...table.slice(0, 50).map((r) => r.length));
        const fields = fieldsOf(env, session.model);
        const seen = new Set<string>();
        const columns: ColumnMapping[] = [];
        for (const raw of input) {
          const c = (raw ?? {}) as Record<string, unknown>;
          const index = Number(c['index']);
          const field = c['field'] === null || c['field'] === undefined ? null : String(c['field']);
          if (!Number.isInteger(index) || index < 0 || index >= width)
            throw new HttpProblem(400, 'invalid-columns', 'Invalid columns', `No column ${index}.`);
          if (field !== null) {
            if (!fields.has(field) || fields.get(field)?.kind === 'one2many')
              throw new HttpProblem(
                422,
                'unknown-field',
                'Field cannot be imported',
                `'${field}' is not a field you may import into.`,
              );
            if (seen.has(field))
              throw new HttpProblem(
                422,
                'duplicate-field',
                'Field mapped twice',
                `'${field}' is mapped twice.`,
              );
            seen.add(field);
          }
          const header = headers[index];
          if (columns.some((m) => m.index === index))
            throw new HttpProblem(
              400,
              'invalid-columns',
              'Invalid columns',
              `Column ${index} is given twice.`,
            );
          columns.push({
            index,
            header: header === null || header === undefined ? '' : String(header),
            field,
          });
        }
        if (options.key !== undefined && fields.get(options.key)?.keyable !== true)
          throw new HttpProblem(
            422,
            'invalid-key',
            'Not a key',
            `'${options.key}' cannot find records: use the id, an external id or a unique field.`,
          );
        await session.rows.write({
          columns,
          options,
          rowCount: dataRows(table, options),
        });
        return describe(env, { ...session, columns, options }, table);
      },
      { write: true },
    );
  });

  const run = async (request: FastifyRequest, env: Env, dryRun: boolean) => {
    const session = await sessionOf(env, idOf(request.params));
    if (session.state !== 'draft')
      throw new HttpProblem(409, 'imported', 'Already imported', 'This file was imported.');
    const mode = session.options.mode ?? 'create';
    if (mode !== 'update') env.access.check(session.model.name as never, 'create');
    if (mode !== 'create') env.access.check(session.model.name as never, 'write');
    const table = readTable(session.file, session.fileType, session.sheet);
    const result = await runImport(
      env,
      session.model,
      fieldsOf(env, session.model),
      table,
      session.columns,
      {
        ...session.options,
        dryRun,
      },
    );
    return { session, result };
  };

  app.post('/api/v1/imports/:id/dry-run', async (request) =>
    request.env(async (env) => shown((await run(request, env, true)).result), { write: true }),
  );

  app.post('/api/v1/imports/:id/commit', async (request, reply: FastifyReply) => {
    const outcome = await request.env(
      (env) =>
        idempotent(request, env, driver, async () => {
          const { session, result } = await run(request, env, false);
          if (result.undo === null) return { status: 422, body: shown(result) };
          await session.rows.write({
            state: 'done',
            createdIds: [...result.created],
            undo: result.undo,
            rejected: { errors: [...result.errors], rows: [...result.rejectedRows] },
            importedAt: new Date(),
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
            ip: request.ip,
          });
          return { status: 201, body: shown(result) };
        }),
      { write: true },
    );
    for (const [name, value] of Object.entries(outcome.headers ?? {})) reply.header(name, value);
    if (outcome.replayed === true) reply.header('idempotent-replayed', 'true');
    return reply.status(outcome.status).send(outcome.body);
  });

  app.post('/api/v1/imports/:id/undo', async (request) =>
    request.env(
      async (env) => {
        const session = await sessionOf(env, idOf(request.params));
        if (session.state !== 'done' || session.undo === null || session.importedAt === null)
          throw new HttpProblem(
            409,
            'not-imported',
            'Nothing to undo',
            'This file was not imported, or was undone.',
          );
        if (Date.now() - session.importedAt.getTime() > UNDO_DAYS * 86_400_000)
          throw new HttpProblem(
            409,
            'undo-expired',
            'Too late to undo',
            `An import can be undone for ${UNDO_DAYS} days.`,
          );
        if (session.undo.created.length > 0)
          env.access.check(session.model.name as never, 'unlink');
        if (session.undo.updated.length > 0) env.access.check(session.model.name as never, 'write');
        const result = await undoImport(
          env,
          session.model,
          fieldsOf(env, session.model),
          session.undo,
        );
        await session.rows.write({ state: 'undone', undo: null });
        if (session.undo.created.length > 0)
          announceChange(env, driver, {
            model: session.model.name,
            ids: [...session.undo.created],
            op: 'delete',
          });
        if (result.restored > 0)
          announceChange(env, driver, {
            model: session.model.name,
            ids: session.undo.updated.map((u) => u.id),
            op: 'update',
          });
        await audit(env, {
          kind: 'data.import.undo',
          summary: `Undid the import of ${session.fileName} into ${session.model.name}: ${result.deleted} deleted, ${result.restored} restored, ${result.changed.length} changed since.`,
          targetModel: session.model.name,
          details: { ...result, session: session.id },
          ip: request.ip,
        });
        return result;
      },
      { write: true },
    ),
  );

  // The rows left out, as CSV with an Error column: fix them and import the file again.
  app.get('/api/v1/imports/:id/rejected', async (request, reply) => {
    const { csv, name } = await request.env(async (env) => {
      const session = await sessionOf(env, idOf(request.params));
      const table = readTable(session.file, session.fileType, session.sheet);
      const messages = new Map<number, string[]>();
      for (const e of session.rejected.errors)
        messages.set(e.row, [...(messages.get(e.row) ?? []), e.message]);
      const width = Math.max(0, ...table.slice(0, 50).map((r) => r.length));
      const pad = (cells: readonly Cell[]) => [
        ...cells,
        ...Array.from({ length: Math.max(0, width - cells.length) }, () => null),
      ];
      const header = session.options.headerRow === false ? [] : [[...pad(table[0] ?? []), 'Error']];
      const body = session.rejected.rows.map((n) => [
        ...pad(table[n - 1] ?? []),
        (messages.get(n) ?? []).join(' '),
      ]);
      return {
        csv: [...header, ...body].map((r) => r.map(csvCell).join(',')).join('\r\n'),
        name: `rejected-${session.fileName.replace(/\.[^.]*$/, '')}.csv`.replace(/["\\\r\n]/g, '_'),
      };
    });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}"`)
      .send(`﻿${csv}\r\n`); // the mark: Excel reads UTF-8 (Bangla) correctly
  });
}
