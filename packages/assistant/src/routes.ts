/**
 * The assistant's API (RFC 0013), for holders of `assistant.user` (and administrators), checked on every call:
 *
 * - `GET  /api/v1/assistant`          whether the assistant can answer here (a key, the company switched on), the
 *                                      model and the month's usage of the company against its budget
 * - `POST /api/v1/assistant/search`   `{ model, text }` → `{ where, unsupported }`: the filters of a sentence, checked
 *                                      and run once through the normal search; or `{ refused: true }`
 * - `PUT  /api/v1/assistant/config`   `{ enabled }`: administrators switch the assistant on or off for their company
 * - `GET  /api/v1/assistant/calls`    administrators: the latest calls of the company (never their content)
 *
 * Everything is read as the user: only the fields they may read are described to the model, and the filters run
 * through the same search (record rules) as any typed filter.
 */

import { chatterContext } from '@kosh/messaging';
import { HttpProblem, type ModuleContext, publicApiModels } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AssistantClient, Attachment } from './client.js';
import { convert, type FormField, fillable, formInstructions, formSchema } from './form.js';
import { languageName, recordText, replyInstructions, summaryInstructions } from './record.js';
import {
  domainOf,
  SearchAnswerError,
  type SearchField,
  searchable,
  searchInstructions,
  searchSchema,
} from './search.js';

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

export interface AssistantRoutesOptions {
  /** Null: no key, the assistant cannot answer (its UI stays hidden). */
  readonly client: AssistantClient | null;
  /** Tokens per company and month (input, output and cached together). */
  readonly monthlyTokens: number;
}

const MAX_TEXT = 500;
/** A pasted document or a text file: characters read. */
const MAX_DOCUMENT = 50_000;
/** A PDF or an image: bytes (the JSON body carries it in base64). */
const MAX_FILE_BYTES = 10_000_000;
const FILE_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/plain',
];
/** Fields of a linked model offered one hop away. */
const LINKED_FIELDS = 25;

/** The fields a user may filter `model` on: its own, and one hop through the many2one fields they may follow. */
export function searchFieldsFor(context: ModuleContext, env: Env, model: string): SearchField[] {
  const models = publicApiModels(context.registry);
  const own = models.get(model);
  if (own === undefined) return [];
  const readable = (name: string, key: string) => env.access.canField(name as never, key, 'read');
  const out: SearchField[] = [];
  for (const f of own.fields) {
    if (!f.stored || !readable(model, f.key) || !searchable(f.kind)) continue;
    out.push({ key: f.key, label: f.label, kind: f.kind, options: f.options });
    if (f.kind !== 'many2one' || f.target === null) continue;
    const target = models.get(f.target);
    if (target === undefined || !env.access.can(f.target as never, 'read')) continue;
    let added = 0;
    for (const t of target.fields) {
      if (added >= LINKED_FIELDS) break;
      if (!t.stored || t.kind === 'many2one' || !searchable(t.kind) || !readable(f.target, t.key))
        continue;
      out.push({
        key: `${f.key}.${t.key}`,
        label: `${f.label} › ${t.label}`,
        kind: t.kind,
        options: t.options,
      });
      added += 1;
    }
  }
  return out;
}

/** The fields of a new record the user may write and a document can fill. */
export function formFieldsFor(context: ModuleContext, env: Env, model: string): FormField[] {
  const own = publicApiModels(context.registry).get(model);
  if (own === undefined) return [];
  return own.fields
    .filter(
      (f) =>
        f.stored &&
        !f.readonly &&
        fillable(f.kind) &&
        f.key !== 'company' &&
        env.access.canField(model as never, f.key, 'write'),
    )
    .slice(0, 60)
    .map((f) => ({
      key: f.key,
      label: f.label,
      kind: f.kind,
      options: f.options,
      target: f.target,
    }));
}

/** The one record of `model` the user may read whose name contains `name`; null when none or several. */
async function matchByName(
  context: ModuleContext,
  env: Env,
  model: string,
  name: string,
): Promise<number | null> {
  if (model === '' || !env.access.can(model as never, 'read')) return null;
  const registered = context.registry.registry.models.get(model as never) as
    | { readonly model: { readonly recName?: string } }
    | undefined;
  const key = registered?.model.recName ?? 'name';
  const escaped = name.replace(/[%_\\]/g, (m) => `\\${m}`);
  const exact = await ref(env, model).search({ where: { [key]: { ilike: escaped } }, limit: 2 });
  if (exact.length === 1) return exact.ids[0] ?? null;
  const found = await ref(env, model).search({
    where: { [key]: { ilike: `%${escaped}%` } },
    limit: 2,
  });
  return found.length === 1 ? (found.ids[0] ?? null) : null;
}

export function registerAssistantRoutes(
  context: ModuleContext,
  options: AssistantRoutesOptions,
): void {
  const { app, driver } = context;
  const { client } = options;

  const guard = async (request: FastifyRequest): Promise<void> =>
    request.env(async (env) => {
      if (!env.administrator && !env.groups.has('assistant.user'))
        throw new HttpProblem(
          403,
          'access',
          'Assistant users only',
          'The AI assistant needs the AI assistant access level.',
        );
    });
  const enabledFor = async (env: Env): Promise<boolean> =>
    env.asSuperuser({ reason: 'assistant settings' }, async (su) => {
      const found = await ref(su, 'assistant.config').search({ where: { company: env.companyId } });
      if (found.length === 0) return false;
      const [row] = (await found.load(['enabled'])).read(['enabled']);
      return row?.['enabled'] === true;
    });
  const usedThisMonth = async (company: number): Promise<number> => {
    const [row] = await driver.query<{ used: string }>({
      text: `SELECT coalesce(sum(input_tokens + output_tokens + cached_tokens), 0)::text AS used
             FROM assistant_call WHERE company_id = $1 AND created_at >= date_trunc('month', now())`,
      params: [company],
    });
    return Number(row?.used ?? 0);
  };
  const log = (env: Env, values: Row) =>
    env.asSuperuser({ reason: 'assistant log' }, (su) =>
      ref(su, 'assistant.call').create([{ user: env.uid, company: env.companyId, ...values }]),
    );

  app.get('/api/v1/assistant', async (request) => {
    await guard(request);
    return request.env(
      async (env) => ({
        available: client !== null,
        enabled: await enabledFor(env),
        model: client?.model ?? null,
        usage: { tokens: await usedThisMonth(env.companyId), budget: options.monthlyTokens },
      }),
      { write: true },
    );
  });

  app.put('/api/v1/assistant/config', async (request) => {
    const enabled = (request.body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== 'boolean')
      throw new HttpProblem(400, 'invalid-body', 'Invalid request', 'enabled: true or false.');
    return request.env(async (env) => {
      if (!env.administrator)
        throw new HttpProblem(
          403,
          'access',
          'Administrators only',
          'Only an administrator switches the assistant on for the company: its data then goes to the API.',
        );
      await env.asSuperuser({ reason: 'assistant settings' }, async (su) => {
        const found = await ref(su, 'assistant.config').search({
          where: { company: env.companyId },
        });
        if (found.length > 0) await found.write({ enabled });
        else await ref(su, 'assistant.config').create([{ company: env.companyId, enabled }]);
      });
      return { enabled };
    });
  });

  app.get('/api/v1/assistant/calls', async (request) =>
    request.env(
      async (env) => {
        if (!env.administrator)
          throw new HttpProblem(
            403,
            'access',
            'Administrators only',
            'The call log is for administrators.',
          );
        const keys = [
          'id',
          'user',
          'feature',
          'llm',
          'resModel',
          'inputTokens',
          'outputTokens',
          'cachedTokens',
          'durationMs',
          'refused',
          'error',
          'createdAt',
        ];
        const calls = await env.asSuperuser({ reason: 'assistant log' }, async (su) => {
          const found = await ref(su, 'assistant.call').search({
            where: { company: env.companyId },
            order: ['id desc'],
            limit: 50,
          });
          return found.length === 0 ? [] : (await found.load(keys)).read(keys);
        });
        return { calls };
      },
      { write: true },
    ),
  );

  /** The checks every model call passes first, in the user's scope: switched on, the budget left. */
  const ready = async (env: Env): Promise<AssistantClient> => {
    if (client === null || !(await enabledFor(env)))
      throw new HttpProblem(
        409,
        'assistant-off',
        'The assistant is off',
        client === null
          ? 'No API key is configured on this server (ANTHROPIC_API_KEY).'
          : 'An administrator has not switched the assistant on for this company.',
      );
    if ((await usedThisMonth(env.companyId)) >= options.monthlyTokens)
      throw new HttpProblem(
        429,
        'assistant-budget',
        "The month's assistant budget is used up",
        `This company used its ${options.monthlyTokens} tokens of the month.`,
        'An administrator can raise KOSH_ASSISTANT_MONTHLY_TOKENS.',
      );
    return client;
  };
  /** Logs a call in a transaction of its own (after the model answered: no transaction stays open meanwhile). */
  const logCall = (request: FastifyRequest, values: Row) =>
    request.env((env) => log(env, values), { write: true });

  app.post('/api/v1/assistant/search', async (request) => {
    await guard(request);
    const body = (request.body ?? {}) as { model?: unknown; text?: unknown };
    const model = typeof body.model === 'string' ? body.model : '';
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (model === '' || text === '' || text.length > MAX_TEXT)
      throw new HttpProblem(
        400,
        'invalid-body',
        'Invalid request',
        `model, and text (1–${MAX_TEXT} characters).`,
      );
    // 1. In the user's scope: the checks and what the model may be told.
    const prepared = await request.env(
      async (env) => {
        const assistant = await ready(env);
        if (!env.access.can(model as never, 'read'))
          throw new HttpProblem(403, 'access', 'Forbidden', `No read access to ${model}.`);
        const fields = searchFieldsFor(context, env, model);
        if (fields.length === 0)
          throw new HttpProblem(
            422,
            'assistant-no-fields',
            'Nothing to search on',
            `No field of ${model} to filter.`,
          );
        const label = publicApiModels(context.registry).get(model)?.label ?? model;
        return {
          assistant,
          fields,
          system: searchInstructions({
            model,
            modelLabel: label,
            fields,
            today: env.today(),
            timeZone: env.tz,
          }),
        };
      },
      { write: true },
    );
    // 2. The model, outside any transaction.
    const started = Date.now();
    const answer = await prepared.assistant.json({
      system: prepared.system,
      user: text,
      schema: searchSchema(prepared.fields),
      effort: 'low',
      maxTokens: 2048,
    });
    const entry: Row = {
      feature: 'search',
      llm: answer.model,
      resModel: model,
      inputTokens: answer.usage.input,
      outputTokens: answer.usage.output,
      cachedTokens: answer.usage.cached,
      durationMs: Date.now() - started,
      refused: answer.refused,
    };
    if (answer.refused) {
      await logCall(request, entry);
      return { refused: true };
    }
    // 3. The answer checked, and run once as the user (a domain the search refuses is refused here).
    let invalid: string | null = null;
    let found: { where: Readonly<Record<string, unknown>>; unsupported: string } | null = null;
    try {
      found = domainOf(answer.data, prepared.fields);
      const where = found.where;
      await request.env((env) => ref(env, model).search({ where, limit: 1 }));
    } catch (error) {
      invalid =
        error instanceof SearchAnswerError
          ? error.problems.join('; ')
          : String((error as Error).message ?? error);
    }
    await logCall(request, invalid === null ? entry : { ...entry, error: invalid.slice(0, 500) });
    if (invalid !== null || found === null)
      throw new HttpProblem(
        422,
        'assistant-answer-invalid',
        'The assistant could not make filters of this',
        invalid ?? 'No filter.',
        'Rephrase the search, or use the filters.',
      );
    return found;
  });

  /**
   * Streams a text answer as server-sent events: `data: {"text": "…"}` per piece, then `event: done` with the model
   * and whether it refused. Errors before the first byte are ordinary problems; after it, `event: error`.
   */
  const streamText = async (
    request: FastifyRequest,
    reply: FastifyReply,
    feature: 'summary' | 'reply',
    build: (
      env: Env,
    ) => Promise<{ readonly system: string; readonly user: string; readonly resModel: string }>,
  ): Promise<void> => {
    await guard(request);
    const prepared = await request.env(
      async (env) => ({ assistant: await ready(env), ...(await build(env)) }),
      { write: true },
    );
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    const send = (event: string | null, data: unknown) =>
      raw.write(`${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`);
    const started = Date.now();
    try {
      const answer = await prepared.assistant.text(
        { system: prepared.system, user: prepared.user, effort: 'medium', maxTokens: 2048 },
        (delta) => send(null, { text: delta }),
      );
      await logCall(request, {
        feature,
        llm: answer.model,
        resModel: prepared.resModel,
        inputTokens: answer.usage.input,
        outputTokens: answer.usage.output,
        cachedTokens: answer.usage.cached,
        durationMs: Date.now() - started,
        refused: answer.refused,
      });
      send('done', { model: answer.model, refused: answer.refused });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logCall(request, {
        feature,
        llm: prepared.assistant.model,
        resModel: prepared.resModel,
        durationMs: Date.now() - started,
        error: message.slice(0, 500),
      }).catch(() => undefined);
      send('error', { detail: 'The assistant could not answer. Try again later.' });
    } finally {
      raw.end();
    }
  };
  const target = (request: FastifyRequest): { model: string; id: number } => {
    const body = (request.body ?? {}) as { model?: unknown; id?: unknown };
    const model = typeof body.model === 'string' ? body.model : '';
    const id = Number(body.id);
    if (model === '' || !Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(400, 'invalid-body', 'Invalid request', 'model and id of a record.');
    return { model, id };
  };
  const chatter = chatterContext(context);

  app.post('/api/v1/assistant/summary', async (request, reply) => {
    const { model, id } = target(request);
    await streamText(request, reply, 'summary', async (env) => {
      const record = await recordText(context, chatter, env, model, id);
      return {
        system: summaryInstructions(languageName(env.lang)),
        user: record.text,
        resModel: model,
      };
    });
  });

  app.post('/api/v1/assistant/reply', async (request, reply) => {
    const { model, id } = target(request);
    const instruction = (request.body as { instruction?: unknown }).instruction;
    if (
      instruction !== undefined &&
      (typeof instruction !== 'string' || instruction.length > MAX_TEXT)
    )
      throw new HttpProblem(
        400,
        'invalid-body',
        'Invalid request',
        `instruction: up to ${MAX_TEXT} characters.`,
      );
    await streamText(request, reply, 'reply', async (env) => {
      const record = await recordText(context, chatter, env, model, id);
      const [me] = (
        await (
          env.model('res.users' as never) as unknown as {
            browse(ids: number[]): { load(k: string[]): Promise<{ read(k: string[]): Row[] }> };
          }
        )
          .browse([env.uid])
          .load(['name'])
      ).read(['name']);
      return {
        system: replyInstructions(languageName(env.lang), String(me?.['name'] ?? 'the author')),
        user: [
          record.text,
          ...(typeof instruction === 'string' && instruction.trim() !== ''
            ? ['', `The author asks: ${instruction.trim()}`]
            : []),
        ].join('\n'),
        resModel: model,
      };
    });
  });

  // A new record's values from a document: proposals the form shows, never saved (RFC 0013 §5.3, step 3).
  app.post('/api/v1/assistant/form', { bodyLimit: MAX_FILE_BYTES * 2 }, async (request) => {
    await guard(request);
    const body = (request.body ?? {}) as {
      model?: unknown;
      text?: unknown;
      file?: { name?: unknown; mediaType?: unknown; data?: unknown } | null;
    };
    const model = typeof body.model === 'string' ? body.model : '';
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const file = body.file ?? null;
    const mediaType = typeof file?.mediaType === 'string' ? file.mediaType : '';
    const data = typeof file?.data === 'string' ? file.data : '';
    if (model === '' || (text === '' && file === null) || text.length > MAX_DOCUMENT)
      throw new HttpProblem(
        400,
        'invalid-body',
        'Invalid request',
        `model, and text (up to ${MAX_DOCUMENT} characters) or a file.`,
      );
    if (
      file !== null &&
      (!FILE_TYPES.includes(mediaType) || data === '' || data.length > MAX_FILE_BYTES * 1.4)
    )
      throw new HttpProblem(
        400,
        'invalid-body',
        'Invalid file',
        `A PDF, an image (PNG, JPEG, WebP, GIF) or a text file, up to ${MAX_FILE_BYTES / 1_000_000} MB.`,
      );
    // A text file is text; PDFs and images go as they are.
    const document =
      mediaType === 'text/plain'
        ? `${text}\n${Buffer.from(data, 'base64').toString('utf8').slice(0, MAX_DOCUMENT)}`.trim()
        : text;
    const attachments: Attachment[] =
      file === null || mediaType === 'text/plain'
        ? []
        : [{ mediaType: mediaType as Attachment['mediaType'], data }];
    const prepared = await request.env(
      async (env) => {
        const assistant = await ready(env);
        if (!env.access.can(model as never, 'create'))
          throw new HttpProblem(403, 'access', 'Forbidden', `You may not create ${model} records.`);
        const fields = formFieldsFor(context, env, model);
        if (fields.length === 0)
          throw new HttpProblem(
            422,
            'assistant-no-fields',
            'Nothing to fill',
            `No field of ${model} to fill.`,
          );
        const label = publicApiModels(context.registry).get(model)?.label ?? model;
        return {
          assistant,
          fields,
          system: formInstructions({ model, modelLabel: label, fields, today: env.today() }),
        };
      },
      { write: true },
    );
    const started = Date.now();
    const answer = await prepared.assistant.json({
      system: prepared.system,
      user: document === '' ? 'Read the attached document.' : document,
      ...(attachments.length === 0 ? {} : { attachments }),
      schema: formSchema(prepared.fields),
      effort: 'medium',
      maxTokens: 4096,
    });
    const entry: Row = {
      feature: 'form',
      llm: answer.model,
      resModel: model,
      inputTokens: answer.usage.input,
      outputTokens: answer.usage.output,
      cachedTokens: answer.usage.cached,
      durationMs: Date.now() - started,
      refused: answer.refused,
    };
    if (answer.refused) {
      await logCall(request, entry);
      return { refused: true };
    }
    const raw = (answer.data ?? {}) as { fields?: Record<string, unknown>; notes?: unknown };
    const values: Record<string, unknown> = {};
    const skipped: string[] = [];
    await request.env(async (env) => {
      for (const field of prepared.fields) {
        const given = raw.fields?.[field.key];
        if (typeof given !== 'string' || given.trim() === '') continue;
        if (field.kind === 'many2one') {
          const id = await matchByName(context, env, field.target ?? '', given.trim());
          if (id === null) skipped.push(`${field.label}: no single "${given.trim()}" found`);
          else values[field.key] = id;
          continue;
        }
        const converted = convert(field, given);
        if ('skip' in converted) skipped.push(converted.skip);
        else values[field.key] = converted.value;
      }
    });
    await logCall(request, entry);
    return {
      values,
      proposed: Object.keys(values),
      skipped,
      notes: typeof raw.notes === 'string' ? raw.notes : '',
    };
  });
}
