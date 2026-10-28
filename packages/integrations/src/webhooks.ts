/**
 * Outbound webhooks (RFC 0017 §5.3). Events — a record created, updated or deleted (Shutro's change events), or an
 * event a module declares (`account.move.posted`) — become deliveries for the active subscriptions that want them;
 * each delivery is a job that POSTs `{ id, event, occurredAt, data }`, signed, and records every attempt. A failure
 * is retried with Shutro's back-off; the last one marks the delivery failed. The record in a payload is what the
 * subscription's user would get from `GET /api/v1/models/<model>/<id>`: their rights, their fields.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { KoshModule } from '@kosh/modules-sdk';
import {
  type ApiModel,
  type AuthService,
  type KoshRegistry,
  publicApiModels,
  readApiRecord,
} from '@kosh/server';
import type { Env, Shutro } from '@kosh/server/orm';

export const DELIVER_JOB = 'webhook.deliver';
export const CHANGE_TOPIC = 'record.changed';
/** Shutro's change actions and the events they are. */
export const CHANGE_EVENTS: Readonly<Record<string, string>> = {
  create: 'created',
  write: 'updated',
  unlink: 'deleted',
};
/** The test event a "send a test" sends. */
export const PING_EVENT = 'webhook.ping';

export interface IntegrationsContext {
  readonly shutro: Shutro;
  readonly registry: KoshRegistry;
  readonly auth?: AuthService | undefined;
  /** For tests: the HTTP client deliveries use. */
  readonly fetch?: typeof fetch;
}

/** The hosts webhooks may call (`SHUTRO_ERP_WEBHOOK_HOSTS`, else automation's list; `*.example.com` allowed). */
export function webhookHosts(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return (env['KOSH_WEBHOOK_HOSTS'] ?? env['KOSH_AUTOMATION_WEBHOOK_HOSTS'] ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '');
}

/** Why a URL may not be called, or `null`: https (http for localhost), and a host on the allow-list. */
export function urlProblem(url: string, hosts: readonly string[] = webhookHosts()): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Not a URL: '${url}'.`;
  }
  const host = parsed.hostname.toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local))
    return 'Webhooks call https URLs (http only for localhost).';
  if (!hosts.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h)))
    return `The host ${host} is not on the webhook allow-list (SHUTRO_ERP_WEBHOOK_HOSTS).`;
  return null;
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`: what receivers check (and reject when old). */
export function signature(secret: string, body: string, time: number): string {
  return `t=${time},v1=${createHmac('sha256', secret).update(`${time}.${body}`).digest('hex')}`;
}

export interface WebhookEvent {
  readonly event: string;
  readonly model: string;
  readonly label: string;
}

/** The events subscriptions may want here: each served model's changes, and the modules' declared events. */
export function webhookEvents(registry: KoshRegistry): WebhookEvent[] {
  const out: WebhookEvent[] = [];
  for (const model of publicApiModels(registry).values())
    for (const [, verb] of Object.entries(CHANGE_EVENTS))
      out.push({
        event: `${model.name}.${verb}`,
        model: model.name,
        label: `${model.label} ${verb}`,
      });
  for (const m of registry.loaded.modules as readonly KoshModule[])
    for (const e of m.events ?? []) out.push({ event: e.topic, model: e.model, label: e.label });
  return out.sort((a, b) => a.event.localeCompare(b.event));
}

// Loosely typed ORM access to this package's models.
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(spec: unknown): Promise<Rows>;
  read(keys: readonly string[]): Record<string, unknown>[];
  write(values: unknown): Promise<void>;
}
interface Ref {
  search(query: unknown): Promise<Rows>;
  browse(ids: readonly number[]): Rows;
  create(rows: readonly unknown[]): Promise<Rows>;
}
export const ref = (env: Env, model: string): Ref => env.model(model as never) as unknown as Ref;

async function rowsOf(set: Rows, keys: readonly string[]): Promise<Record<string, unknown>[]> {
  return set.length === 0 ? [] : (await set.load(keys)).read(['id', ...keys]);
}

/** Runs `fn` as `user` in `company` (their groups and grants), for reading what they may see. */
async function asUser<T>(
  context: IntegrationsContext,
  user: number,
  company: number,
  fn: (env: Env) => Promise<T>,
): Promise<T | null> {
  const identity = await context.auth?.verify(user);
  if (identity === null || identity === undefined || !identity.companies.includes(company))
    return null;
  try {
    return await context.shutro.run(
      {
        user,
        company,
        groups: [...identity.groups],
        grants: [...(identity.grants ?? [])],
      } as never,
      fn,
    );
  } catch (error) {
    // Their roles do not let them read it: as good as not visible.
    if (error instanceof Error && error.name === 'AccessError') return null;
    throw error;
  }
}

/** Whether record `id` of `model` still exists (whoever may see it). */
async function exists(
  context: IntegrationsContext,
  model: string,
  id: number,
  company: number,
): Promise<boolean> {
  return context.shutro.bootstrap({ reason: 'webhooks: still there?', company }, async (env) =>
    env.asSuperuser(
      { reason: 'webhooks: does the record still exist' },
      async (su) => (await ref(su, model).search({ where: { id }, limit: 1 })).length > 0,
    ),
  );
}

/**
 * Turns an event into deliveries for the matching active subscriptions of `company`, one per record, and queues
 * them. Returns the deliveries made.
 */
export async function fanOut(
  context: IntegrationsContext,
  input: {
    readonly event: string;
    readonly model: string;
    readonly ids: readonly number[];
    readonly company: number;
    readonly extra?: Readonly<Record<string, unknown>>;
  },
): Promise<number[]> {
  // System work outside any company (installation) has no company's webhooks to tell.
  if (!(Number.isSafeInteger(input.company) && input.company > 0)) return [];
  const apiModel: ApiModel | undefined = publicApiModels(context.registry).get(input.model);
  const subscriptions = await context.shutro.bootstrap(
    { reason: `webhooks: ${input.event}`, company: input.company },
    async (env) =>
      (
        await rowsOf(
          await ref(env, 'webhook.subscription').search({
            where: { active: true, company: input.company },
          }),
          ['events', 'runAs', 'createdBy'],
        )
      ).filter((s) => String(s['events']).split(/\s+/).includes(input.event)),
  );
  if (subscriptions.length === 0) return [];
  const made: number[] = [];
  for (const sub of subscriptions) {
    const user = (sub['runAs'] ?? sub['createdBy']) as number | null;
    for (const id of input.ids) {
      let record: Record<string, unknown> | null = null;
      if (!input.event.endsWith('.deleted') && apiModel !== undefined && user !== null) {
        record = await asUser(context, user, input.company, (env) =>
          readApiRecord(env, apiModel, id),
        );
        // Not theirs to see: nothing is sent. Gone since (deleted after this change): sent without the record.
        if (record === null && (await exists(context, input.model, id, input.company))) continue;
      }
      const payload = {
        id: randomUUID(),
        event: input.event,
        occurredAt: new Date().toISOString(),
        data: { model: input.model, id, record, ...input.extra },
      };
      made.push(await queue(context, sub['id'] as number, input.company, input.event, payload));
    }
  }
  return made;
}

/** A new delivery of `payload` to a subscription, queued; returns its id. */
export async function queue(
  context: IntegrationsContext,
  subscription: number,
  company: number,
  event: string,
  payload: Record<string, unknown>,
  replayOf?: number,
): Promise<number> {
  return context.shutro.bootstrap({ reason: `webhook delivery ${event}`, company }, async (env) => {
    const created = await ref(env, 'webhook.delivery').create([
      { subscription, event, payload, company, ...(replayOf === undefined ? {} : { replayOf }) },
    ]);
    const id = created.ids[0] as number;
    await env.enqueue(DELIVER_JOB, { delivery: id, company }, { attempts: 8 });
    return id;
  });
}

/**
 * Sends one delivery and records the attempt (in its own transaction, so a retry keeps it). Throws to be retried
 * while attempts remain; the last failure marks the delivery failed and counts against the subscription.
 */
export async function deliver(
  context: IntegrationsContext,
  delivery: number,
  company: number,
  attempt: { readonly number: number; readonly last: boolean },
): Promise<void> {
  const system = <T>(fn: (env: Env) => Promise<T>) =>
    context.shutro.bootstrap({ reason: `webhook delivery ${delivery}`, company }, fn);
  const found = await system(async (env) => {
    const [d] = await rowsOf(ref(env, 'webhook.delivery').browse([delivery]), [
      'subscription',
      'event',
      'payload',
      'attempts',
      'state',
    ]);
    if (d === undefined) return null;
    const [s] = await rowsOf(
      ref(env, 'webhook.subscription').browse([d['subscription'] as number]),
      ['url', 'secret', 'active', 'failures'],
    );
    return s === undefined ? null : { d, s };
  });
  if (found === null || found.d['state'] === 'done') return;
  const { d, s } = found;
  const record = (values: Record<string, unknown>, subscription?: Record<string, unknown>) =>
    system(async (env) => {
      await ref(env, 'webhook.delivery').browse([delivery]).write(values);
      if (subscription !== undefined)
        await ref(env, 'webhook.subscription')
          .browse([s['id'] as number])
          .write(subscription);
    });
  const attempts = Number(d['attempts'] ?? 0) + 1;
  const problem =
    s['active'] !== true ? 'The webhook is switched off.' : urlProblem(String(s['url']));
  if (problem !== null) {
    await record({ state: 'failed', attempts, error: problem });
    return;
  }
  const body = JSON.stringify(d['payload']);
  const payload = d['payload'] as { id?: string };
  const started = Date.now();
  let status: number | null = null;
  let text = '';
  let error: string | null = null;
  try {
    const response = await (context.fetch ?? fetch)(String(s['url']), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Shutro-ERP-Webhooks/1',
        'x-shutro-event': String(d['event']),
        'x-shutro-delivery': String(payload.id ?? delivery),
        'x-shutro-signature': signature(String(s['secret']), body, Math.floor(started / 1000)),
      },
      body,
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });
    status = response.status;
    text = (await response.text().catch(() => '')).slice(0, 2048);
    if (!response.ok) error = `The endpoint answered ${response.status}.`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const outcome = {
    attempts,
    responseStatus: status,
    responseBody: text,
    durationMs: Date.now() - started,
    error,
  };
  if (error === null) {
    await record(
      { ...outcome, state: 'done', deliveredAt: new Date() },
      { failures: 0, lastDeliveryAt: new Date() },
    );
    return;
  }
  if (!attempt.last) {
    await record({ ...outcome, state: 'pending' });
    throw new Error(error); // retried with back-off
  }
  await record({ ...outcome, state: 'failed' }, { failures: Number(s['failures'] ?? 0) + 1 });
}
