/**
 * The OpenAPI 3.1 document of the installed module set (RFC 0002 §6.4), generated from the model metadata: one read
 * schema, one create schema and one update schema per model, the generated paths, and RFC 9457 problems. Per-user
 * restrictions (ACL, field groups, rules) are enforced at request time and visible in `/api/v1/meta/{model}`.
 */
import type { KoshModule } from '@kosh/modules-sdk';
import { buildKoshRegistry, KOSH_VERSION } from '../registry.js';
import { type ApiField, type ApiModel, defaultFields, publicApiModels } from './metadata.js';

type Schema = Record<string, unknown>;

const PROBLEM = { $ref: '#/components/schemas/Problem' };

function nullable(schema: Schema, required: boolean): Schema {
  if (required) return schema;
  if (typeof schema['type'] === 'string') return { ...schema, type: [schema['type'], 'null'] };
  return { oneOf: [schema, { type: 'null' }] };
}

/** The read schema of one field value. */
export function fieldSchema(field: ApiField): Schema {
  const base = ((): Schema => {
    switch (field.kind) {
      case 'char':
      case 'text':
      case 'html':
        return { type: 'string' };
      case 'boolean':
        return { type: 'boolean' };
      case 'integer':
      case 'bigint':
        return { type: 'integer' };
      case 'float':
        return { type: 'number' };
      case 'decimal':
        return {
          type: 'string',
          pattern: '^-?\\d+(\\.\\d+)?$',
          description: 'Exact decimal as a string (never a float).',
        };
      case 'monetary':
        return { $ref: '#/components/schemas/Money' };
      case 'quantity':
        return { $ref: '#/components/schemas/Quantity' };
      case 'date':
        return { type: 'string', format: 'date' };
      case 'datetime':
        return { type: 'string', format: 'date-time' };
      case 'selection':
      case 'state':
        return field.options === null
          ? { type: 'string' }
          : { type: 'string', enum: field.options.map(([v]) => v) };
      case 'many2one':
        return { type: 'integer', description: `Id of a ${field.target} record.` };
      case 'one2many':
      case 'many2many':
        return {
          type: 'array',
          items: { type: 'integer' },
          description: `Ids of ${field.target} records.`,
        };
      case 'binary':
        return { type: 'string', contentEncoding: 'base64' };
      default:
        return {};
    }
  })();
  return { ...nullable(base, field.required || field.key === 'id'), title: field.label };
}

function writeSchema(field: ApiField): Schema {
  if (field.kind === 'one2many' || field.kind === 'many2many')
    return {
      type: 'object',
      title: field.label,
      description: `Commands on ${field.target} records.`,
      properties: {
        create: { type: 'array', items: { type: 'object' } },
        update: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'integer' }, values: { type: 'object' } },
            required: ['id', 'values'],
          },
        },
        delete: { type: 'array', items: { type: 'integer' } },
        link: { type: 'array', items: { type: 'integer' } },
        unlink: { type: 'array', items: { type: 'integer' } },
        set: { type: 'array', items: { type: 'integer' } },
        clear: { type: 'boolean', const: true },
      },
      additionalProperties: false,
    };
  if (field.kind === 'monetary')
    return nullable(
      {
        type: 'string',
        pattern: '^-?\\d+(\\.\\d+)?$',
        description: 'Amount in the record currency.',
      },
      field.required,
    );
  if (field.translate)
    return nullable(
      { type: 'string', description: 'Text in the request language.' },
      field.required,
    );
  return fieldSchema(field);
}

function modelSchemas(model: ApiModel): Record<string, Schema> {
  const readable = model.fields.filter((f) => f.kind !== 'binary');
  const writable = model.fields.filter((f) => !f.readonly);
  return {
    [model.schemaName]: {
      type: 'object',
      title: model.label,
      properties: Object.fromEntries(readable.map((f) => [f.key, fieldSchema(f)])),
      required: defaultFields(model)
        .filter((f) => f.required || f.key === 'id')
        .map((f) => f.key),
    },
    [`${model.schemaName}Create`]: {
      type: 'object',
      properties: Object.fromEntries(writable.map((f) => [f.key, writeSchema(f)])),
      required: writable.filter((f) => f.requiredOnCreate).map((f) => f.key),
      additionalProperties: false,
    },
    [`${model.schemaName}Update`]: {
      type: 'object',
      properties: Object.fromEntries(writable.map((f) => [f.key, writeSchema(f)])),
      additionalProperties: false,
    },
  };
}

function responses(ok: Schema, okStatus = '200'): Schema {
  const problem = { content: { 'application/problem+json': { schema: PROBLEM } } };
  return {
    [okStatus]: { description: 'OK', content: { 'application/json': { schema: ok } } },
    '400': { description: 'Invalid request', ...problem },
    '401': { description: 'Not authenticated', ...problem },
    '403': { description: 'Forbidden', ...problem },
    '404': { description: 'Not found', ...problem },
    '412': { description: 'Changed since read (If-Match)', ...problem },
    '422': { description: 'Invalid values', ...problem },
    '429': { description: 'Rate limited', ...problem },
  };
}

const ID_PARAM = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'integer', minimum: 1 },
};
const IDEMPOTENCY = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  schema: { type: 'string', maxLength: 128 },
  description: 'Replays the first response for a retried request with the same key.',
};

function modelPaths(model: ApiModel): Record<string, Schema> {
  const s = model.schemaName;
  const ref = { $ref: `#/components/schemas/${s}` };
  const base = `/api/v1/models/${model.name}`;
  const tag = [model.name];
  const paths: Record<string, Schema> = {
    [base]: {
      get: {
        operationId: `list${s}`,
        tags: tag,
        summary: `Search ${model.label} records`,
        parameters: [
          {
            name: 'filter',
            in: 'query',
            schema: { type: 'string' },
            description: 'A Shutro domain as JSON, e.g. {"name":{"ilike":"acme%"}}.',
          },
          {
            name: 'order',
            in: 'query',
            schema: { type: 'string' },
            description: "Comma-separated, e.g. 'name asc,id desc'.",
          },
          {
            name: 'fields',
            in: 'query',
            schema: { type: 'string' },
            description: 'Comma-separated field keys.',
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 1000, default: 80 },
          },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
          {
            name: 'count',
            in: 'query',
            schema: { type: 'boolean' },
            description: 'Also return the total count.',
          },
        ],
        responses: responses({
          type: 'object',
          properties: { items: { type: 'array', items: ref }, count: { type: 'integer' } },
          required: ['items'],
        }),
      },
      post: {
        operationId: `create${s}`,
        tags: tag,
        summary: `Create ${model.label} records`,
        parameters: [IDEMPOTENCY],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${s}Create` } } },
        },
        responses: responses(ref, '201'),
      },
    },
    [`${base}/{id}`]: {
      get: { operationId: `get${s}`, tags: tag, parameters: [ID_PARAM], responses: responses(ref) },
      patch: {
        operationId: `update${s}`,
        tags: tag,
        parameters: [
          ID_PARAM,
          IDEMPOTENCY,
          {
            name: 'If-Match',
            in: 'header',
            schema: { type: 'string' },
            description:
              'The ETag read with the record: refuses the update (412) if it changed since.',
          },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${s}Update` } } },
        },
        responses: responses(ref),
      },
      delete: {
        operationId: `delete${s}`,
        tags: tag,
        parameters: [ID_PARAM, IDEMPOTENCY],
        responses: responses({ type: 'object', properties: { deleted: { type: 'integer' } } }),
      },
    },
    [`${base}/aggregate`]: {
      post: {
        operationId: `aggregate${s}`,
        tags: tag,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AggregateQuery' } },
          },
        },
        responses: responses({
          type: 'object',
          properties: { rows: { type: 'array', items: { type: 'object' } } },
        }),
      },
    },
    [`${base}/onchange`]: {
      post: {
        operationId: `onchange${s}`,
        tags: tag,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/OnchangeInput' } },
          },
        },
        responses: responses({ $ref: '#/components/schemas/OnchangeResult' }),
      },
    },
  };
  for (const t of model.transitions)
    paths[`${base}/{id}/transitions/${t}`] = {
      post: {
        operationId: `${t}${s}`,
        tags: tag,
        summary: `Transition: ${t}`,
        parameters: [ID_PARAM, IDEMPOTENCY],
        responses: responses(ref),
      },
    };
  return paths;
}

/** The OpenAPI 3.1 document for these models. */
export function openApiDocument(
  models: Iterable<ApiModel>,
  info: { readonly title: string; readonly version: string },
): Schema {
  const list = [...models];
  return {
    openapi: '3.1.0',
    info,
    paths: Object.assign({}, ...list.map(modelPaths)),
    // A session (sign-in) or an API key (RFC 0017 §5.1); cookie sessions also send X-CSRF-Token on changes.
    security: [{ session: [] }, { apiKey: [] }, { cookie: [] }],
    components: {
      securitySchemes: {
        session: {
          type: 'http',
          scheme: 'bearer',
          description: 'A session token from POST /api/v1/auth/login.',
        },
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Api-Key',
          description:
            'An API key (sk_…; also accepted as Authorization: Bearer). Its scopes — *, read:<app>, write:<app> — narrow the user’s rights.',
        },
        cookie: { type: 'apiKey', in: 'cookie', name: 'kosh_session' },
      },
      schemas: {
        Problem: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            hint: { type: 'string' },
          },
          required: ['type', 'title', 'status', 'detail'],
        },
        Money: {
          type: 'object',
          properties: { amount: { type: 'string' }, currency: { type: 'string' } },
          required: ['amount', 'currency'],
        },
        Quantity: {
          type: 'object',
          properties: { value: { type: 'string' }, uom: { type: 'string' } },
          required: ['value', 'uom'],
        },
        AggregateQuery: {
          type: 'object',
          properties: {
            where: { type: 'object' },
            groupBy: { type: 'array', items: { type: 'string' } },
            measures: { type: 'object' },
            order: { type: 'array', items: { type: 'string' } },
            limit: { type: 'integer' },
          },
          required: ['measures'],
        },
        OnchangeInput: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            values: { type: 'object' },
            changed: { type: 'array', items: { type: 'string' } },
          },
          required: ['values', 'changed'],
        },
        OnchangeResult: {
          type: 'object',
          properties: {
            values: { type: 'object' },
            warnings: { type: 'array', items: { type: 'string' } },
            children: { type: 'object' },
          },
        },
        ...Object.assign({}, ...list.map(modelSchemas)),
      },
    },
  };
}

/**
 * The OpenAPI document of a module set, without a database or a running server (what `kosh generate client` uses).
 * @throws {ServerConfigError} for modules that cannot load together
 */
export function openApiOf(modules: readonly KoshModule[]): Schema {
  const models = publicApiModels(buildKoshRegistry(modules));
  return openApiDocument(models.values(), { title: 'Shutro ERP API', version: KOSH_VERSION });
}
