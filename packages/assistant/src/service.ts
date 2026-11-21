/**
 * The assistant for other apps on the server (RFC 0013 §5.1, RFC 0034 §2.6): one structured answer for a company,
 * under the same rules as the assistant's own features — off until an administrator switched it on for the
 * company, within the month's token budget, every call logged without its content. An app that answers people who
 * are not signed in (a site's chat) calls it here; nobody is named on such a call.
 *
 * No transaction stays open while the model answers: the checks and the log each have their own.
 */
import type { ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import type { AssistantClient, JsonRequest } from './client.js';

export interface AssistantAbout {
  readonly company: number;
  /** What the call is for, in the log (at most 20 characters): `livechat`. */
  readonly feature: string;
  /** The model the call is about, in the log. */
  readonly resModel?: string;
  /** Who asked, when somebody signed in did. */
  readonly user?: number | null;
}

export type AssistantResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly why: 'off' | 'budget' | 'refused' | 'failed' };

export interface AssistantService {
  /** Whether the assistant may answer for the company now: a key, switched on, budget left. */
  ready(company: number): Promise<'ok' | 'off' | 'budget'>;
  /** One answer constrained to the request's JSON schema. Checked, budgeted and logged. */
  json(about: AssistantAbout, request: JsonRequest): Promise<AssistantResult>;
}

type Row = Record<string, unknown>;
interface Ref {
  search(q: unknown): Promise<{
    readonly length: number;
    load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
  }>;
  create(rows: readonly unknown[]): Promise<unknown>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;

const services = new WeakMap<object, AssistantService>();

/** The assistant of a server, for the apps on it; `null` when the assistant is not installed. */
export function assistantService(context: Pick<ModuleContext, 'shutro'>): AssistantService | null {
  return services.get(context.shutro as object) ?? null;
}

/** Makes the service of a server (the assistant's own routes do, once). */
export function provideAssistantService(
  context: Pick<ModuleContext, 'shutro' | 'driver' | 'app'>,
  options: { readonly client: AssistantClient | null; readonly monthlyTokens: number },
): AssistantService {
  const { shutro, driver } = context;
  const { client } = options;
  const used = async (company: number): Promise<number> => {
    const [row] = await driver.query<{ used: string }>({
      text: `SELECT coalesce(sum(input_tokens + output_tokens + cached_tokens), 0)::text AS used
             FROM assistant_call WHERE company_id = $1 AND created_at >= date_trunc('month', now())`,
      params: [company],
    });
    return Number(row?.used ?? 0);
  };
  const ready = async (company: number): Promise<'ok' | 'off' | 'budget'> => {
    if (client === null) return 'off';
    const enabled = await shutro.bootstrap(
      { reason: 'assistant settings', company },
      async (env) => {
        const found = await ref(env as Env, 'assistant.config').search({ where: { company } });
        if (found.length === 0) return false;
        const [row] = (await found.load(['enabled'])).read(['enabled']);
        return row?.['enabled'] === true;
      },
    );
    if (!enabled) return 'off';
    return (await used(company)) >= options.monthlyTokens ? 'budget' : 'ok';
  };
  const log = (about: AssistantAbout, values: Row): Promise<unknown> =>
    shutro.bootstrap({ reason: 'assistant log', company: about.company }, (env) =>
      ref(env as Env, 'assistant.call').create([
        {
          user: about.user ?? null,
          company: about.company,
          feature: about.feature.slice(0, 20),
          resModel: about.resModel ?? null,
          ...values,
        },
      ]),
    );
  const service: AssistantService = {
    ready,
    async json(about, request) {
      const state = await ready(about.company);
      if (state !== 'ok' || client === null)
        return { ok: false, why: state === 'ok' ? 'off' : state };
      const started = Date.now();
      try {
        const answer = await client.json(request);
        await log(about, {
          llm: answer.model.slice(0, 60),
          inputTokens: answer.usage.input,
          outputTokens: answer.usage.output,
          cachedTokens: answer.usage.cached,
          durationMs: Date.now() - started,
          refused: answer.refused,
        });
        return answer.refused ? { ok: false, why: 'refused' } : { ok: true, data: answer.data };
      } catch (error) {
        context.app.log.warn({ err: error }, 'the assistant did not answer');
        await log(about, {
          llm: client.model.slice(0, 60),
          durationMs: Date.now() - started,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        }).catch(() => undefined);
        return { ok: false, why: 'failed' };
      }
    },
  };
  services.set(shutro as object, service);
  context.app.addHook('onClose', async () => {
    services.delete(shutro as object);
  });
  return service;
}
