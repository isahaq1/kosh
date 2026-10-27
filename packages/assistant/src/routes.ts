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
import { HttpProblem, type ModuleContext, publicApiModels } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import type { FastifyRequest } from 'fastify';
import type { AssistantClient } from './client.js';
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

/** What a search request ends with: filters, a refusal, or an answer that could not be used. */
type SearchOutcome =
  | { readonly refused: true }
  | { readonly where: Readonly<Record<string, unknown>>; readonly unsupported: string }
  | { readonly invalid: string; readonly entry: Row };

export interface AssistantRoutesOptions {
  /** Null: no key, the assistant cannot answer (its UI stays hidden). */
  readonly client: AssistantClient | null;
  /** Tokens per company and month (input, output and cached together). */
  readonly monthlyTokens: number;
}

const MAX_TEXT = 500;
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
    const outcome = await request.env(
      async (env): Promise<SearchOutcome> => {
        if (client === null || !(await enabledFor(env)))
          throw new HttpProblem(
            409,
            'assistant-off',
            'The assistant is off',
            client === null
              ? 'No API key is configured on this server (ANTHROPIC_API_KEY).'
              : 'An administrator has not switched the assistant on for this company.',
          );
        if (!env.access.can(model as never, 'read'))
          throw new HttpProblem(403, 'access', 'Forbidden', `No read access to ${model}.`);
        if ((await usedThisMonth(env.companyId)) >= options.monthlyTokens)
          throw new HttpProblem(
            429,
            'assistant-budget',
            "The month's assistant budget is used up",
            `This company used its ${options.monthlyTokens} tokens of the month.`,
            'An administrator can raise KOSH_ASSISTANT_MONTHLY_TOKENS.',
          );
        const fields = searchFieldsFor(context, env, model);
        if (fields.length === 0)
          throw new HttpProblem(
            422,
            'assistant-no-fields',
            'Nothing to search on',
            `No field of ${model} to filter.`,
          );
        const label = publicApiModels(context.registry).get(model)?.label ?? model;
        const started = Date.now();
        const answer = await client.json({
          system: searchInstructions({
            model,
            modelLabel: label,
            fields,
            today: env.today(),
            timeZone: env.tz,
          }),
          user: text,
          schema: searchSchema(fields),
          effort: 'low',
          maxTokens: 2048,
        });
        const entry = {
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
          await log(env, entry);
          return { refused: true };
        }
        try {
          const { where, unsupported } = domainOf(answer.data, fields);
          // Run once as the user: a domain the search refuses is refused here, not in the list.
          await ref(env, model).search({ where, limit: 1 });
          await log(env, entry);
          return { where, unsupported };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            invalid: error instanceof SearchAnswerError ? error.problems.join('; ') : message,
            entry: { ...entry, error: message.slice(0, 500) },
          };
        }
      },
      { write: true },
    );
    if (!('invalid' in outcome)) return outcome;
    // The refusal is answered after the call is logged (the log commits; the 422 changes nothing else).
    await request.env((env) => log(env, outcome.entry), { write: true });
    throw new HttpProblem(
      422,
      'assistant-answer-invalid',
      'The assistant could not make filters of this',
      outcome.invalid,
      'Rephrase the search, or use the filters.',
    );
  });
}
