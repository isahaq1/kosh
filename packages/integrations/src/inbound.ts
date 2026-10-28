/**
 * Inbound webhooks (RFC 0017 §5.4). Modules declare endpoints (`inboundWebhooks` in their manifest); a company
 * switches one on (`webhook.endpoint`: a URL token and a secret). A call to `POST /api/v1/hooks/<token>` is checked
 * by the module's `verify` against the raw body, stored (refused calls too, for the log), and — once per event id —
 * handled by the module in a job, as the system in the endpoint's company, retried on failure. A repeated event id
 * is answered 200 and not handled again; a call can be handled again from the log (replay).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundCall, InboundWebhookSpec, KoshModule } from '@kosh/modules-sdk';
import type { KoshRegistry } from '@kosh/server';
import type { Env, Shutro } from '@kosh/server/orm';
import { ref } from './webhooks.js';

export const INBOUND_JOB = 'webhook.inbound';

/** The declared inbound webhooks of the loaded modules, by `<module>.<key>`. */
export function inboundHooks(
  registry: KoshRegistry,
): Map<string, InboundWebhookSpec & { readonly module: string }> {
  const out = new Map<string, InboundWebhookSpec & { readonly module: string }>();
  for (const m of registry.loaded.modules as readonly KoshModule[])
    for (const hook of m.inboundWebhooks ?? [])
      out.set(`${m.name}.${hook.key}`, { ...hook, module: m.name });
  return out;
}

/**
 * A `verify` for providers that sign with an HMAC of the raw body: the signature in `header` (hex or base64,
 * optionally after a prefix such as `sha256=`), compared in constant time; the event id from `eventId`.
 */
export function hmacVerifier(options: {
  readonly header: string;
  readonly algorithm?: 'sha256' | 'sha512' | 'sha1';
  readonly encoding?: 'hex' | 'base64';
  readonly prefix?: string;
  readonly eventId: (call: InboundCall) => string | null | undefined;
}): (call: InboundCall, secret: string) => string | null {
  return (call, secret) => {
    let given = call.headers[options.header.toLowerCase()] ?? '';
    if (options.prefix !== undefined) {
      if (!given.startsWith(options.prefix)) return null;
      given = given.slice(options.prefix.length);
    }
    const expected = createHmac(options.algorithm ?? 'sha256', secret)
      .update(call.body)
      .digest(options.encoding ?? 'hex');
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const id = options.eventId(call);
    return id === null || id === undefined || id === '' ? null : String(id);
  };
}

/** Headers worth keeping in the log (no cookies, no credentials). */
const KEPT = /^(content-type|user-agent|x-[a-z0-9-]+)$/;
function keptHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      (e): e is [string, string] =>
        e[1] !== undefined && KEPT.test(e[0]) && !/authorization|api-key|cookie/.test(e[0]),
    ),
  );
}

export interface ReceiveResult {
  readonly status: 202 | 200 | 401 | 404;
  readonly body: Record<string, unknown>;
}

/** Receives a call on the endpoint of `token`: checked, stored, queued once per event id. */
export async function receive(
  context: { readonly shutro: Shutro; readonly registry: KoshRegistry },
  token: string,
  call: InboundCall,
): Promise<ReceiveResult> {
  const hooks = inboundHooks(context.registry);
  // Which endpoint (and company) the token names: looked up across companies (the token is unique).
  const found = await context.shutro.bootstrap({ reason: 'inbound webhook: endpoint' }, (env) =>
    env.asSuperuser({ reason: 'inbound webhook: which endpoint' }, async (su) => {
      const set = await ref(su.withFlags({ checkCompany: false }), 'webhook.endpoint').search({
        where: { token, active: true },
        limit: 1,
      });
      if (set.length === 0) return null;
      const [row] = (await set.load(['hook', 'secret', 'company'])).read([
        'id',
        'hook',
        'secret',
        'company',
      ]);
      return row ?? null;
    }),
  );
  const hook = found === null ? undefined : hooks.get(String(found['hook']));
  if (found === null || hook === undefined)
    return { status: 404, body: { title: 'Not found', detail: 'No such webhook endpoint.' } };
  const company = found['company'] as number;
  let eventId: string | null = null;
  try {
    eventId = await hook.verify(call, String(found['secret']));
  } catch {
    eventId = null;
  }
  return context.shutro.bootstrap(
    { reason: `inbound webhook ${hook.module}.${hook.key}`, company },
    async (env) => {
      const calls = ref(env, 'webhook.inbound');
      const base = {
        endpoint: found['id'],
        headers: keptHeaders(call.headers as Record<string, string | undefined>),
        body: call.body.slice(0, 256 * 1024),
        company,
      };
      if (eventId === null) {
        await calls.create([{ ...base, verified: false, state: 'refused' }]);
        return {
          status: 401,
          body: { title: 'Not verified', detail: 'The call’s signature does not match.' },
        };
      }
      const seen = await calls.search({
        where: { endpoint: found['id'], eventId, verified: true },
        limit: 1,
      });
      if (seen.length > 0) return { status: 200, body: { duplicate: true, eventId } };
      const created = await calls.create([{ ...base, eventId, verified: true, state: 'received' }]);
      const id = created.ids[0] as number;
      await env.enqueue(INBOUND_JOB, { call: id, company }, { attempts: 6 });
      return { status: 202, body: { received: true, eventId } };
    },
  );
}

/**
 * Handles a stored call with its module's `handle`, as the system in the endpoint's company; records the outcome
 * in its own transaction. Throws to be retried while attempts remain.
 */
export async function handleInbound(
  context: { readonly shutro: Shutro; readonly registry: KoshRegistry },
  callId: number,
  company: number,
  last: boolean,
): Promise<void> {
  const hooks = inboundHooks(context.registry);
  const system = <T>(reason: string, fn: (env: Env) => Promise<T>) =>
    context.shutro.bootstrap({ reason, company }, fn);
  const found = await system('inbound webhook: the call', async (env) => {
    const set = ref(env, 'webhook.inbound').browse([callId]);
    const [c] = (await set.load(['endpoint', 'body', 'headers', 'state', 'attempts'])).read([
      'endpoint',
      'body',
      'headers',
      'state',
      'attempts',
    ]);
    if (c === undefined) return null;
    const [e] = (
      await ref(env, 'webhook.endpoint')
        .browse([c['endpoint'] as number])
        .load(['hook'])
    ).read(['hook']);
    return { row: c, hook: String(e?.['hook'] ?? '') };
  });
  if (found === null || found.row['state'] === 'done') return;
  const { row, hook: name } = found;
  const hook = hooks.get(name);
  const attempts = Number(row['attempts'] ?? 0) + 1;
  const write = (values: Record<string, unknown>) =>
    system('inbound webhook: the outcome', (env) =>
      ref(env, 'webhook.inbound').browse([callId]).write(values),
    );
  if (hook === undefined) {
    await write({
      state: 'failed',
      attempts,
      error: `The endpoint ${name} is no longer installed.`,
    });
    return;
  }
  const body = String(row['body']);
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  const call: InboundCall = {
    headers: (row['headers'] ?? {}) as Record<string, string>,
    query: {},
    body,
    json,
  };
  try {
    const result = await system(`inbound webhook ${name}`, (env) => hook.handle(env, call));
    await write({
      state: 'done',
      attempts,
      result: typeof result === 'string' ? result : null,
      error: null,
      handledAt: new Date(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await write({ state: last ? 'failed' : 'received', attempts, error: message });
    if (!last) throw error;
  }
}
