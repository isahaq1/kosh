/**
 * The inbox subscriber (RFC 0006 §5.2–5.3): Shutro outbox events become `notify.notification` rows, exactly once
 * per event (the handler's transaction advances the subscription cursor). For each event the recipients are
 * resolved (mentioned users, holders of the approver roles in the record's company, the requester, the assignee),
 * **each recipient's access to the record is re-checked as that user**, their preference for the kind is applied,
 * and the rows are written. Once the transaction commits, the gateway is told, so bells update at once.
 */
import { announceChange, type KoshRegistry, type ModuleContext } from '@kosh/server';
import type { Env, Shutro, Worker } from '@kosh/server/orm';
import { orm } from '@kosh/server/orm';
import { type DeliveryContext, queueEmails } from './email.js';
import type { Kind } from './models.js';

type Row = Record<string, unknown>;
interface Set {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
}
interface Ref {
  search(q: unknown): Promise<Set>;
  browse(ids: readonly number[]): Set;
  create(rows: readonly unknown[]): Promise<Set>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;
async function rows(env: Env, model: string, where: unknown, keys: string[]): Promise<Row[]> {
  const found = await ref(env, model).search({ where });
  return found.length === 0 ? [] : (await found.load(keys)).read(keys);
}

/** One recipient's notification, before the access re-check. */
interface Draft {
  readonly user: number;
  readonly kind: Kind;
  readonly params: Readonly<Record<string, unknown>>;
}

/** What the subscriber needs from the server. */
export interface InboxContext extends DeliveryContext {
  readonly shutro: Shutro;
  readonly driver: ModuleContext['driver'];
  readonly registry: KoshRegistry;
  readonly auth: ModuleContext['auth'];
}

/** The display name of a record and the name of a user, as the system (for the message's params). */
async function names(
  su: Env,
  model: string,
  id: number,
  actor: number | null,
): Promise<{ record: string; actor: string }> {
  const [row] = (await ref(su, model).browse([id]).load(['displayName'])).read(['displayName']);
  const shown = row?.['displayName'];
  const record = typeof shown === 'string' && shown !== '' ? shown : `#${id}`;
  if (actor === null) return { record, actor: '' };
  const [user] = (await ref(su, 'res.users').browse([actor]).load(['name'])).read(['name']);
  return { record, actor: String(user?.['name'] ?? '') };
}

/** Users holding one of `roles` in `company` (or in every company). */
async function roleHolders(su: Env, roles: readonly string[], company: number): Promise<number[]> {
  const found = await rows(
    su,
    'auth.user_group',
    { group: { in: roles }, or: [{ company: null }, { company }] },
    ['user'],
  );
  return [...new Set(found.map((r) => r['user'] as number))];
}

/**
 * True when `uid` may read the record: run as that user, read-only, in a transaction of its own (the check reads
 * only; the handler's transaction writes the rows).
 */
async function mayRead(
  context: InboxContext,
  uid: number,
  company: number,
  model: string,
  id: number,
): Promise<boolean> {
  const info = await context.auth?.verify(uid).catch(() => null);
  if (info === null || info === undefined) return false;
  const companies = info.companies.length === 0 ? [company] : info.companies;
  try {
    return await context.shutro.run(
      {
        user: uid,
        company: companies.includes(company) ? company : (companies[0] as number),
        companies,
        groups: info.groups,
        readOnly: true,
        reason: 'notification access check',
      },
      async (env) => {
        if (!env.access.can(model as never, 'read')) return false;
        await env.access.checkRecords(model as never, [id], 'read');
        return true;
      },
    );
  } catch {
    return false;
  }
}

/** The recipient's preference for the kind on a channel (enabled unless they switched it off). */
async function wants(su: Env, uid: number, kind: string, channel: string): Promise<boolean> {
  const [pref] = await rows(su, 'notify.preference', { user: uid, kind, channel }, ['enabled']);
  return pref === undefined || pref['enabled'] === true;
}

/** Turns one event into drafts (who, what); `null` when the event concerns nothing installed. */
async function draftsOf(
  context: InboxContext,
  su: Env,
  topic: string,
  payload: Record<string, unknown>,
  by: number,
  company: number,
): Promise<{ model: string; id: number; drafts: Draft[] } | null> {
  const model = String(payload['model'] ?? '');
  const id = Number(payload['id']);
  if (
    model === '' ||
    !Number.isSafeInteger(id) ||
    !context.registry.registry.models.has(model as never)
  )
    return null;
  switch (topic) {
    case 'mail.message.posted': {
      const mentions = (payload['mentions'] as number[] | undefined) ?? [];
      if (mentions.length === 0) return { model, id, drafts: [] };
      const { record, actor } = await names(su, model, id, by);
      const preview = String(payload['preview'] ?? '');
      return {
        model,
        id,
        drafts: mentions
          .filter((u) => u !== by)
          .map((user) => ({ user, kind: 'mention', params: { actor, record, preview } })),
      };
    }
    case 'approval.requested': {
      const roles = (payload['roles'] as string[] | undefined) ?? [];
      const holders = await roleHolders(su, roles, company);
      const { record, actor } = await names(su, model, id, by);
      return {
        model,
        id,
        drafts: holders
          .filter((u) => u !== by)
          .map((user) => ({ user, kind: 'approval.requested', params: { actor, record } })),
      };
    }
    case 'approval.decided': {
      if (!context.registry.registry.models.has('approval.request' as never)) return null;
      const [request] = await rows(su, 'approval.request', { id: Number(payload['request']) }, [
        'requestedBy',
      ]);
      const requester = request?.['requestedBy'] as number | null | undefined;
      if (requester === null || requester === undefined || requester === by)
        return { model, id, drafts: [] };
      const { record, actor } = await names(su, model, id, by);
      return {
        model,
        id,
        drafts: [
          {
            user: requester,
            kind: 'approval.decided',
            params: {
              actor,
              record,
              state: String(payload['state']),
              final: payload['final'] === true,
            },
          },
        ],
      };
    }
    case 'mail.activity.assigned': {
      const assignee = Number(payload['assignee']);
      if (!Number.isSafeInteger(assignee) || assignee === by) return { model, id, drafts: [] };
      const { record, actor } = await names(su, model, id, by);
      return {
        model,
        id,
        drafts: [
          {
            user: assignee,
            kind: 'activity.assigned',
            params: { actor, record, deadline: String(payload['deadline'] ?? '') },
          },
        ],
      };
    }
    default:
      return null;
  }
}

/** The topics the inbox subscribes to. */
export const TOPICS: readonly string[] = [
  'mail.message.posted',
  'approval.requested',
  'approval.decided',
  'mail.activity.assigned',
];

/**
 * Handles one delivered event in the subscriber's transaction: writes the recipients' notifications (as the
 * system; the rows belong to the recipients) and announces them once the transaction commits.
 */
export async function handleEvent(
  context: InboxContext,
  env: Env,
  event: {
    readonly topic: string;
    readonly payload: unknown;
    readonly uid: number;
    readonly companyId: number;
  },
): Promise<number> {
  const payload =
    typeof event.payload === 'object' && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : {};
  const ids = await env.asSuperuser({ reason: `notify ${event.topic}` }, async (su) => {
    const found = await draftsOf(context, su, event.topic, payload, event.uid, event.companyId);
    if (found === null || found.drafts.length === 0) return [] as number[];
    const kept: Draft[] = [];
    for (const draft of found.drafts)
      if (
        (await mayRead(context, draft.user, event.companyId, found.model, found.id)) &&
        (await wants(su, draft.user, draft.kind, 'inapp'))
      )
        kept.push(draft);
    if (kept.length === 0) return [] as number[];
    const created = await ref(su, 'notify.notification').create(
      kept.map((d) => ({
        user: d.user,
        kind: d.kind,
        params: d.params,
        resModel: found.model,
        resId: found.id,
        actor: event.uid === orm.SYSTEM_UID ? null : event.uid,
        company: event.companyId,
      })),
    );
    const ids = [...created.ids];
    // The other channels: one delivery and one job each, in this transaction (the job exists iff the rows do).
    await queueEmails(context, env, su, ids, (uid, kind) => wants(su, uid, kind, 'email'));
    return ids;
  });
  if (ids.length > 0)
    announceChange(env, context.driver, { model: 'notify.notification', ids, op: 'create' });
  return ids.length;
}

/** One subscriber per topic. `start()` them to run in the background; tests `drain()` them. */
export function inboxWorkers(context: InboxContext): Worker[] {
  return TOPICS.map((topic) =>
    context.shutro.subscribe(
      `notify.inapp.${topic}`,
      topic,
      async (event, env) => {
        await handleEvent(context, env, event);
      },
      { pollMs: 5000 },
    ),
  );
}
