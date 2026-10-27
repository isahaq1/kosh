/**
 * The import API (RFC 0014 §5.7), for holders of `import.user` (and administrators) who also have the `import`
 * permission and the create or write permission the mode needs on the model, checked on every call:
 *
 * - `POST   /api/v1/imports?model=…[&sheet=…]`  the file as the body (`X-Filename`) → the session: headers, the first
 *                                                rows, the mapping (a fitting saved mapping or template, else guessed)
 * - `GET    /api/v1/imports/:id`                 the same, later; with the progress of a background run
 * - `PUT    /api/v1/imports/:id/mapping`         `{ columns: [{ index, field }], options }`
 * - `POST   /api/v1/imports/:id/apply-mapping`   `{ mapping }`: a saved mapping's or template's columns and options
 * - `POST   /api/v1/imports/:id/save-mapping`    `{ name, shared }`: the session's mapping, saved by header
 * - `POST   /api/v1/imports/:id/dry-run`         the whole import, rolled back (a background job above 2,000 rows: 202)
 * - `POST   /api/v1/imports/:id/commit`          the import (`Idempotency-Key`; a background job above 2,000 rows)
 * - `POST   /api/v1/imports/:id/undo`            within 7 days, records nobody changed since
 * - `GET    /api/v1/imports/:id/rejected`        the rows left out, as CSV with an Error column
 * - `GET    /api/v1/import-mappings?model=…`     saved mappings (own and shared) and module templates
 * - `DELETE /api/v1/import-mappings/:id`         one of the user's own
 * - `GET    /api/v1/import-templates/:model[?mapping=…]`  a sample workbook: the headers, and a sheet describing them
 *
 * Sessions are the uploader's own (a record rule); files are read on the server, never evaluated.
 */
import { workbook } from '@kosh/reporting';
import { announceChange, audit, HttpProblem, idempotent, type ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Cell } from './convert.js';
import { type ColumnMapping, guessMapping } from './mapping.js';
import { EXTERNAL_ID_KEY, ID_KEY, type ImportField, undoImport } from './run.js';
import {
  createImportService,
  dataRows,
  IMPORT_MAX_BYTES,
  IMPORT_ROWS,
  type ImportService,
  INLINE_ROWS,
  isXlsx,
  parseOptions,
  RUN_JOB,
  readTable,
  ref,
  type SavedMapping,
  shown,
  UNDO_DAYS,
} from './service.js';

export interface ImportRoutesOptions {
  /** Bytes per file. */
  readonly maxBytes?: number;
  /** Rows per file. */
  readonly maxRows?: number;
  /** Rows run in the request; above, a background job. */
  readonly inlineRows?: number;
  /** The service the worker shares (made from the context by default). */
  readonly service?: ImportService;
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

const idOf = (params: unknown): number => {
  const id = Number((params as { id?: unknown }).id);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'The id is a positive integer.');
  return id;
};

/** What a column of a template expects, in words (the template's second sheet). */
function expects(field: ImportField): string {
  switch (field.kind) {
    case ID_KEY:
      return 'The record id (#42), to update records';
    case EXTERNAL_ID_KEY:
      return 'An external id (legacy.partner_42), to find the record again';
    case 'boolean':
      return 'Yes or No';
    case 'date':
      return 'A date: DD/MM/YYYY or YYYY-MM-DD';
    case 'datetime':
      return 'A date and time: DD/MM/YYYY HH:MM';
    case 'integer':
    case 'bigint':
      return 'A whole number';
    case 'float':
    case 'decimal':
    case 'monetary':
    case 'quantity':
      return 'A number: 1,250.50';
    case 'selection':
    case 'state':
      return `One of: ${(field.options ?? []).map(([, label]) => label).join(', ')}`;
    case 'many2one':
      return `The name, code or external id of a record (${field.target?.model ?? ''})`;
    case 'many2many':
      return `Names, codes or external ids, separated by commas (${field.target?.model ?? ''})`;
    default:
      return 'Text';
  }
}

export function registerImportRoutes(
  context: ModuleContext,
  options: ImportRoutesOptions = {},
): void {
  const { app, driver } = context;
  const service =
    options.service ??
    createImportService(
      context,
      options.inlineRows === undefined ? {} : { inlineRows: options.inlineRows },
    );
  const maxBytes = options.maxBytes ?? IMPORT_MAX_BYTES;
  const maxRows = options.maxRows ?? IMPORT_ROWS;
  const inlineRows = options.service?.inlineRows ?? options.inlineRows ?? INLINE_ROWS;
  const { sessionOf, describe, fieldsOf, columnFields } = service;
  const shownSession = async (env: Env, id: number) => {
    const session = await sessionOf(env, id);
    return describe(env, session, readTable(session.file, session.fileType, session.sheet));
  };
  const draftOnly = (state: string) => {
    if (state === 'running')
      throw new HttpProblem(409, 'running', 'Running', 'This import is running in the background.');
    if (state !== 'draft')
      throw new HttpProblem(409, 'imported', 'Already imported', 'This file was imported.');
  };

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
          service.guard(env);
          const model = service.modelFor(env, name);
          const rowCount = dataRows(table, {});
          if (rowCount > maxRows)
            throw new HttpProblem(
              413,
              'too-many-rows',
              'Too many rows',
              `The file has ${rowCount} rows; at most ${maxRows} are imported at once.`,
              'Split the file.',
            );
          const headers = (table[0] ?? []).map((c) => (c === null ? '' : String(c)));
          const fields = fieldsOf(env, model);
          // A saved mapping or a template whose every header the file has, else a guess.
          const applied = service.fitting(await service.mappingsFor(env, model.name), headers);
          const columns =
            applied === null
              ? guessMapping(headers, columnFields(fields))
              : service.applyMapping(applied, headers, fields);
          const rows = await ref(env, 'import.session').create([
            {
              user: env.uid,
              resModel: model.name,
              fileName,
              fileType,
              file,
              sheet,
              columns,
              options: applied?.options ?? {},
              rowCount,
            },
          ]);
          const session = await sessionOf(env, rows.ids[0] as number);
          return {
            ...(await describe(env, session, table)),
            applied: applied === null ? null : { id: applied.id, name: applied.name },
          };
        },
        { write: true },
      );
      return reply.code(201).send(created);
    });
  });

  app.get('/api/v1/imports/:id', async (request) =>
    // Write: progress is read in a system scope (Shutro request #12).
    request.env((env) => shownSession(env, idOf(request.params)), { write: true }),
  );

  /** Checks and stores a mapping on a draft session. */
  const storeMapping = async (
    env: Env,
    id: number,
    input: readonly unknown[],
    given: ReturnType<typeof parseOptions>,
  ) => {
    const session = await sessionOf(env, id);
    draftOnly(session.state);
    const table = readTable(session.file, session.fileType, session.sheet);
    const headers = given.headerRow === false ? [] : (table[0] ?? []);
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
      if (columns.some((m) => m.index === index))
        throw new HttpProblem(
          400,
          'invalid-columns',
          'Invalid columns',
          `Column ${index} is given twice.`,
        );
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
      columns.push({
        index,
        header: header === null || header === undefined ? '' : String(header),
        field,
      });
    }
    if (given.key !== undefined && fields.get(given.key)?.keyable !== true)
      throw new HttpProblem(
        422,
        'invalid-key',
        'Not a key',
        `'${given.key}' cannot find records: use the id, an external id or a unique field.`,
      );
    await session.rows.write({ columns, options: given, rowCount: dataRows(table, given) });
    return describe(env, { ...session, columns, options: given }, table);
  };

  app.put('/api/v1/imports/:id/mapping', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const input = body['columns'];
    if (!Array.isArray(input))
      throw new HttpProblem(400, 'invalid-columns', 'Invalid columns', 'columns is an array.');
    const given = parseOptions(body['options']);
    return request.env((env) => storeMapping(env, idOf(request.params), input, given), {
      write: true,
    });
  });

  app.post('/api/v1/imports/:id/apply-mapping', async (request) => {
    const wanted = String(((request.body ?? {}) as Record<string, unknown>)['mapping'] ?? '');
    return request.env(
      async (env) => {
        const session = await sessionOf(env, idOf(request.params));
        const mapping = (await service.mappingsFor(env, session.model.name)).find(
          (m) => m.id === wanted,
        );
        if (mapping === undefined)
          throw new HttpProblem(404, 'not-found', 'No such mapping', `No mapping '${wanted}'.`);
        const table = readTable(session.file, session.fileType, session.sheet);
        const headers = (table[0] ?? []).map((c) => (c === null ? '' : String(c)));
        const columns = service.applyMapping(mapping, headers, fieldsOf(env, session.model));
        return storeMapping(env, session.id, columns, mapping.options);
      },
      { write: true },
    );
  });

  app.post('/api/v1/imports/:id/save-mapping', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    if (name === '' || name.length > 100)
      throw new HttpProblem(400, 'invalid-name', 'Invalid name', 'name is 1–100 characters.');
    const saved = await request.env(
      async (env) => {
        const session = await sessionOf(env, idOf(request.params));
        const columns = session.columns.flatMap((c) =>
          c.field === null || c.header === '' ? [] : [{ header: c.header, field: c.field }],
        );
        if (columns.length === 0)
          throw new HttpProblem(422, 'empty-mapping', 'Nothing to save', 'Map a column first.');
        const rows = await ref(env, 'import.mapping').create([
          {
            name,
            resModel: session.model.name,
            user: env.uid,
            shared: body['shared'] === true,
            columns,
            options: session.options,
          },
        ]);
        return { id: String(rows.ids[0]), name };
      },
      { write: true },
    );
    return reply.code(201).send(saved);
  });

  app.get('/api/v1/import-mappings', async (request) => {
    const model = String(((request.query ?? {}) as Record<string, unknown>)['model'] ?? '');
    return request.env(async (env) => {
      service.guard(env);
      service.modelFor(env, model);
      return { mappings: await service.mappingsFor(env, model) };
    });
  });

  app.delete('/api/v1/import-mappings/:id', async (request, reply) => {
    const id = idOf(request.params);
    await request.env(
      async (env) => {
        service.guard(env);
        const found = await ref(env, 'import.mapping').search({ where: { id }, limit: 1 });
        if (found.length === 0)
          throw new HttpProblem(404, 'not-found', 'No such mapping', `No mapping #${id}.`);
        await found.unlink(); // the record rule: owners only
      },
      { write: true },
    );
    return reply.code(204).send();
  });

  app.get('/api/v1/import-templates/:model', async (request, reply) => {
    const name = String((request.params as { model?: unknown }).model ?? '');
    const wanted = (request.query as Record<string, unknown> | undefined)?.['mapping'];
    const { file, fileName } = await request.env(async (env) => {
      service.guard(env);
      const model = service.modelFor(env, name);
      const fields = fieldsOf(env, model);
      let mapping: SavedMapping | undefined;
      if (typeof wanted === 'string' && wanted !== '') {
        mapping = (await service.mappingsFor(env, name)).find((m) => m.id === wanted);
        if (mapping === undefined)
          throw new HttpProblem(404, 'not-found', 'No such mapping', `No mapping '${wanted}'.`);
      }
      // Without a mapping: every field of the record (lines aside), required ones first.
      const columns =
        mapping?.columns.filter((c) => fields.has(c.field)) ??
        columnFields(fields)
          .filter((f) => f.line === null && f.kind !== ID_KEY && f.kind !== EXTERNAL_ID_KEY)
          .sort((a, b) => Number(b.required) - Number(a.required))
          .map((f) => ({ header: f.label, field: f.key }));
      const help = columns.map((c) => {
        const field = fields.get(c.field) as ImportField;
        return [c.header, field.key, field.required ? 'Yes' : '', expects(field)];
      });
      return {
        file: workbook([
          { name: 'Data', rows: [columns.map((c) => c.header)], widths: columns.map(() => 20) },
          {
            name: 'Columns',
            rows: [['Column', 'Field', 'Required', 'What to write'], ...help],
            widths: [24, 24, 10, 60],
          },
        ]),
        fileName: `${(mapping?.name ?? model.label).replace(/[^\p{L}\p{N} _-]+/gu, '')} template.xlsx`,
      };
    });
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header(
        'content-disposition',
        `attachment; filename="template.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      )
      .send(file);
  });

  /** A run in the request, or, for a large file, a background job (202). */
  const start = async (request: FastifyRequest, env: Env, dryRun: boolean) => {
    const session = await sessionOf(env, idOf(request.params));
    draftOnly(session.state);
    if (session.rowCount <= inlineRows) {
      const result = await service.execute(env, session, dryRun);
      await service.record(env, session, result, dryRun, request.ip);
      return { status: dryRun ? 200 : result.undo === null ? 422 : 201, body: shown(result) };
    }
    const mode = session.options.mode ?? 'create';
    if (mode !== 'update') env.access.check(session.model.name as never, 'create');
    if (mode !== 'create') env.access.check(session.model.name as never, 'write');
    await session.rows.write({ state: 'running', result: null, failure: null });
    await env.enqueue(
      RUN_JOB,
      { session: session.id, dryRun },
      { key: `${RUN_JOB}:${session.id}` },
    );
    await service.startProgress(env, session.id, session.rowCount);
    return { status: 202, body: await shownSession(env, session.id) };
  };

  app.post('/api/v1/imports/:id/dry-run', async (request, reply) => {
    const outcome = await request.env((env) => start(request, env, true), { write: true });
    return reply.status(outcome.status).send(outcome.body);
  });

  app.post('/api/v1/imports/:id/commit', async (request, reply) => {
    const outcome = await request.env(
      (env) => idempotent(request, env, driver, () => start(request, env, false)),
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
