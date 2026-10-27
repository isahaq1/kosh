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
import { type ImportField, type ImportOptions, importFields, runImport } from './run.js';
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
  if (o['mode'] !== undefined && o['mode'] !== 'create')
    throw new HttpProblem(400, 'invalid-options', 'Invalid options', 'mode is create.');
  return out;
}

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
    env.access.check(name as never, 'create');
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
    };
  };
  const fieldsOf = (env: Env, model: ApiModel): Map<string, ImportField> =>
    importFields(env, model, targets);

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
      fields: [...fields.values()].map((f) => ({
        key: f.key,
        kind: f.kind,
        label: f.label,
        required: f.required,
        ...(f.target === null ? {} : { target: f.target.model }),
      })),
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
            [...fieldsOf(env, model).values()],
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
            if (!fields.has(field))
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
          columns.push({
            index,
            header: header === null || header === undefined ? '' : String(header),
            field,
          });
        }
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
    request.env(async (env) => (await run(request, env, true)).result, { write: true }),
  );

  app.post('/api/v1/imports/:id/commit', async (request, reply: FastifyReply) => {
    const outcome = await request.env(
      (env) =>
        idempotent(request, env, driver, async () => {
          const { session, result } = await run(request, env, false);
          if (result.errors.length > 0) return { status: 422, body: result };
          await session.rows.write({ state: 'done', createdIds: [...result.created] });
          announceChange(env, driver, {
            model: session.model.name,
            ids: [...result.created],
            op: 'create',
          });
          await audit(env, {
            kind: 'data.import',
            summary: `Imported ${result.created.length} ${session.model.name} record(s) from ${session.fileName}.`,
            targetModel: session.model.name,
            details: { count: result.created.length, file: session.fileName, session: session.id },
            ip: request.ip,
          });
          return { status: 201, body: result };
        }),
      { write: true },
    );
    for (const [name, value] of Object.entries(outcome.headers ?? {})) reply.header(name, value);
    if (outcome.replayed === true) reply.header('idempotent-replayed', 'true');
    return reply.status(outcome.status).send(outcome.body);
  });
}
