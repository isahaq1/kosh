/**
 * The generated REST API (RFC 0002 §6.3): one set of routes serving every installed model from Shutro's metadata.
 * Each request runs in its own Shutro transaction as the caller, so ACL, record rules, field groups, company scope,
 * compare-and-set and constraints are Shutro's, never re-implemented here.
 *
 * - `GET    /api/v1/models/:model`                          search (filter, order, fields, limit, offset, count)
 * - `POST   /api/v1/models/:model`                          create (Idempotency-Key)
 * - `GET    /api/v1/models/:model/:id`                      read (ETag)
 * - `PATCH  /api/v1/models/:model/:id`                      update (If-Match → 412, Idempotency-Key)
 * - `DELETE /api/v1/models/:model/:id`                      delete (Idempotency-Key)
 * - `POST   /api/v1/models/:model/aggregate`                grouped totals
 * - `POST   /api/v1/models/:model/onchange`                 form assistance
 * - `POST   /api/v1/models/:model/:id/transitions/:name`    state transition (Idempotency-Key)
 * - `GET    /api/v1/meta/:model`                            the caller's view of the model
 * - `GET    /api/v1/openapi.json`                           the OpenAPI 3.1 document
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpProblem } from '../errors.js';
import type { Driver, Env } from '../orm.js';
import { idempotent, type Outcome } from './idempotency.js';
import { type ApiField, type ApiModel, defaultFields } from './metadata.js';

/** The dynamic recordset API the generic routes use (model names come from the URL). */
interface Records {
  readonly ids: readonly number[];
  readonly length: number;
  load(spec?: unknown): Promise<Records>;
  read(keys: readonly string[]): Record<string, unknown>[];
  write(values: unknown, options?: unknown): Promise<void>;
  unlink(): Promise<void>;
  first(): Record<string, unknown>;
}
interface Ref {
  search(query?: unknown): Promise<Records>;
  browse(ids: readonly number[]): Records;
  create(rows: readonly unknown[]): Promise<Records>;
  aggregate(query: unknown): Promise<unknown[]>;
  onchange(input: unknown): Promise<unknown>;
}
const ref = (env: Env, model: string): Ref => env.model(model as never) as unknown as Ref;

const PERMS = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

function problem(
  status: number,
  type: string,
  title: string,
  detail: string,
  hint?: string,
): HttpProblem {
  return new HttpProblem(status, type, title, detail, hint);
}

function list(text: unknown): string[] {
  return typeof text === 'string' && text.trim() !== ''
    ? text
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
    : [];
}

function parseFilter(text: unknown): Record<string, unknown> | undefined {
  if (text === undefined || text === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(String(text));
  } catch {
    throw problem(
      400,
      'invalid-filter',
      'Invalid filter',
      'filter is not valid JSON.',
      'Pass a Shutro domain as JSON, e.g. {"name":{"ilike":"acme%"}}.',
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw problem(
      400,
      'invalid-filter',
      'Invalid filter',
      'filter must be a JSON object (a Shutro domain).',
    );
  return value as Record<string, unknown>;
}

function parseOrder(model: ApiModel, text: unknown): string[] {
  return list(text).map((term) => {
    const [key = '', direction = 'asc', extra] = term.split(/\s+/);
    const field = model.byKey.get(key);
    if (
      field === undefined ||
      !field.stored ||
      extra !== undefined ||
      (direction !== 'asc' && direction !== 'desc')
    )
      throw problem(
        400,
        'invalid-order',
        'Invalid order',
        `Cannot order ${model.name} by '${term}'.`,
        "Use stored fields: 'name asc,id desc'.",
      );
    return `${key} ${direction}`;
  });
}

/** The fields to return: requested ones (checked to exist), or the defaults the caller may read. */
function fieldsOf(model: ApiModel, env: Env, requested: unknown): ApiField[] {
  const keys = list(requested);
  if (keys.length === 0)
    return defaultFields(model).filter((f) =>
      env.access.canField(model.name as never, f.key, 'read'),
    );
  return keys.map((key) => {
    const field = model.byKey.get(key);
    if (field === undefined || field.kind === 'binary')
      throw problem(
        400,
        'invalid-fields',
        'Invalid fields',
        `'${key}' is not a readable field of ${model.name}.`,
      );
    return field;
  });
}

/** Loads what the response needs (restricted fields are refused by Shutro: 403) and returns plain rows. */
async function rows(
  records: Records,
  fields: readonly ApiField[],
): Promise<Record<string, unknown>[]> {
  if (records.length === 0) return [];
  const scalar = fields
    .filter((f) => f.kind !== 'one2many' && f.kind !== 'many2many')
    .map((f) => f.key);
  const x2many = fields
    .filter((f) => f.kind === 'one2many' || f.kind === 'many2many')
    .map((f) => f.key);
  let loaded = await records.load([...new Set(['id', ...scalar])]);
  if (x2many.length > 0)
    loaded = await loaded.load(Object.fromEntries(x2many.map((k) => [k, true])));
  return loaded.read(['id', ...fields.map((f) => f.key).filter((k) => k !== 'id')]);
}

function etagOf(records: Records): string | undefined {
  const updatedAt = records.length === 1 ? records.first()['updatedAt'] : undefined;
  return updatedAt instanceof Date ? `"${updatedAt.getTime()}"` : undefined;
}

function ifMatch(request: FastifyRequest): Date | undefined {
  const header = request.headers['if-match'];
  if (header === undefined) return undefined;
  const m = /^(?:W\/)?"(\d+)"$/.exec(String(header).trim());
  if (m === null)
    throw problem(
      400,
      'invalid-if-match',
      'Invalid If-Match',
      'If-Match must be an ETag returned by this API.',
    );
  return new Date(Number(m[1]));
}

async function record(
  env: Env,
  model: ApiModel,
  id: number,
  fields?: readonly ApiField[],
): Promise<Outcome> {
  const set = await ref(env, model.name).browse([id]).load(['id', 'updatedAt']);
  const [row] = await rows(set, fields ?? fieldsOf(model, env, undefined));
  const etag = etagOf(set);
  return { status: 200, body: row, ...(etag === undefined ? {} : { headers: { etag } }) };
}

async function send(reply: FastifyReply, outcome: Outcome): Promise<void> {
  for (const [name, value] of Object.entries(outcome.headers ?? {})) reply.header(name, value);
  if (outcome.replayed === true) reply.header('idempotent-replayed', 'true');
  await reply.status(outcome.status).send(outcome.body);
}

function idOf(params: unknown): number {
  const id = Number((params as { id?: unknown }).id);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw problem(400, 'invalid-id', 'Invalid id', 'The record id must be a positive integer.');
  return id;
}

/** Registers the generated routes for `models`. */
export function registerRestApi(
  app: FastifyInstance,
  options: {
    readonly models: ReadonlyMap<string, ApiModel>;
    readonly driver: Driver;
    readonly openapi: () => unknown;
  },
): void {
  const { models, driver } = options;
  const modelOf = (params: unknown): ApiModel => {
    const name = String((params as { model?: unknown }).model ?? '');
    const model = models.get(name);
    if (model === undefined)
      throw problem(
        404,
        'unknown-model',
        'Unknown model',
        `No installed model is named '${name}'.`,
      );
    return model;
  };
  const query = (request: FastifyRequest): Record<string, unknown> =>
    (request.query ?? {}) as Record<string, unknown>;
  const body = (request: FastifyRequest): Record<string, unknown> => {
    const b = request.body;
    if (typeof b !== 'object' || b === null || Array.isArray(b))
      throw problem(400, 'invalid-body', 'Invalid body', 'The body must be a JSON object.');
    return b as Record<string, unknown>;
  };

  app.get('/api/v1/models/:model', async (request) => {
    const model = modelOf(request.params);
    const q = query(request);
    const limit = q['limit'] === undefined ? 80 : Number(q['limit']);
    const offset = q['offset'] === undefined ? 0 : Number(q['offset']);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw problem(400, 'invalid-limit', 'Invalid limit', 'limit must be 1–1000.');
    if (!Number.isInteger(offset) || offset < 0)
      throw problem(400, 'invalid-offset', 'Invalid offset', 'offset must be 0 or more.');
    const where = parseFilter(q['filter']);
    const order = parseOrder(model, q['order']);
    return request.env(async (env) => {
      const fields = fieldsOf(model, env, q['fields']);
      const found = await ref(env, model.name).search({
        ...(where === undefined ? {} : { where }),
        ...(order.length > 0 ? { order } : {}),
        limit,
        offset,
      });
      const items = await rows(found, fields);
      if (q['count'] !== 'true') return { items };
      const [total] = (await ref(env, model.name).aggregate({
        ...(where === undefined ? {} : { where }),
        measures: { count: 'count' },
      })) as { count: number }[];
      return { items, count: total?.count ?? 0 };
    });
  });

  app.post('/api/v1/models/:model', async (request, reply) => {
    const model = modelOf(request.params);
    const values = body(request);
    const outcome = await request.env((env) =>
      idempotent(request, env, driver, async () => {
        const created = await ref(env, model.name).create([values]);
        await env.flush(); // computes and constraints run now: the response shows the stored record
        const result = await record(env, model, created.ids[0] as number);
        return {
          ...result,
          status: 201,
          headers: {
            ...result.headers,
            location: `/api/v1/models/${model.name}/${created.ids[0]}`,
          },
        };
      }),
    );
    await send(reply, outcome);
  });

  app.get('/api/v1/models/:model/:id', async (request, reply) => {
    const model = modelOf(request.params);
    const id = idOf(request.params);
    const outcome = await request.env((env) =>
      record(
        env,
        model,
        id,
        list(query(request)['fields']).length > 0
          ? fieldsOf(model, env, query(request)['fields'])
          : undefined,
      ),
    );
    await send(reply, outcome);
  });

  app.patch('/api/v1/models/:model/:id', async (request, reply) => {
    const model = modelOf(request.params);
    const id = idOf(request.params);
    const values = body(request);
    const expected = ifMatch(request);
    const outcome = await request.env((env) =>
      idempotent(request, env, driver, async () => {
        await ref(env, model.name)
          .browse([id])
          .write(values, expected === undefined ? {} : { expect: { updatedAt: expected } });
        await env.flush();
        return record(env, model, id);
      }),
    );
    await send(reply, outcome);
  });

  app.delete('/api/v1/models/:model/:id', async (request, reply) => {
    const model = modelOf(request.params);
    const id = idOf(request.params);
    const expected = ifMatch(request);
    const outcome = await request.env((env) =>
      idempotent(request, env, driver, async () => {
        const target = ref(env, model.name).browse([id]);
        if (expected !== undefined) await target.write({}, { expect: { updatedAt: expected } }); // locks and compares
        await target.unlink();
        return { status: 200, body: { deleted: 1 } };
      }),
    );
    await send(reply, outcome);
  });

  app.post('/api/v1/models/:model/aggregate', async (request) => {
    const model = modelOf(request.params);
    const q = body(request);
    return request.env(async (env) => ({ rows: await ref(env, model.name).aggregate(q) }));
  });

  app.post('/api/v1/models/:model/onchange', async (request) => {
    const model = modelOf(request.params);
    const input = body(request);
    return request.env((env) => ref(env, model.name).onchange(input));
  });

  app.post('/api/v1/models/:model/:id/transitions/:name', async (request, reply) => {
    const model = modelOf(request.params);
    const id = idOf(request.params);
    const name = String((request.params as { name?: unknown }).name ?? '');
    if (!model.transitions.includes(name))
      throw problem(
        404,
        'unknown-transition',
        'Unknown transition',
        `${model.name} has no transition '${name}'.`,
        `Transitions: ${model.transitions.join(', ') || 'none'}.`,
      );
    const outcome = await request.env((env) =>
      idempotent(request, env, driver, async () => {
        const target = ref(env, model.name).browse([id]) as unknown as Record<
          string,
          () => Promise<void>
        >;
        await (target[name] as () => Promise<void>).call(target);
        await env.flush();
        return record(env, model, id);
      }),
    );
    await send(reply, outcome);
  });

  app.get('/api/v1/meta/:model', async (request) => {
    const model = modelOf(request.params);
    return request.env(async (env) => ({
      name: model.name,
      label: model.label,
      operations: Object.fromEntries(PERMS.map((p) => [p, env.access.can(model.name as never, p)])),
      transitions: model.transitions,
      onchange: model.onchange,
      fields: model.fields
        .filter((f) => env.access.canField(model.name as never, f.key, 'read'))
        .map((f) => ({
          key: f.key,
          kind: f.kind,
          label: f.label,
          required: f.required,
          readonly: f.readonly || !env.access.canField(model.name as never, f.key, 'write'),
          ...(f.target === null ? {} : { target: f.target }),
          ...(f.options === null
            ? {}
            : { options: f.options.map(([value, label]) => ({ value, label })) }),
        })),
    }));
  });

  app.get('/api/v1/openapi.json', async (request) => {
    if (request.identity === null)
      throw problem(
        401,
        'unauthenticated',
        'Not authenticated',
        'The API description needs an authenticated user.',
        'Sign in first.',
      );
    return options.openapi();
  });
}
