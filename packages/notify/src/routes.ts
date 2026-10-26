/**
 * The inbox API (RFC 0006 §5.4, in-app channel), every route for the caller's own notifications only (record
 * rules on the private models):
 *
 * - `GET  /api/v1/notifications?unread=true&limit=50`   newest first
 * - `GET  /api/v1/notifications/count`                   unread count
 * - `POST /api/v1/notifications/:id/read`               mark one read
 * - `POST /api/v1/notifications/read-all`
 * - `GET  /api/v1/notifications/preferences`            per kind: whether the inbox gets it
 * - `PUT  /api/v1/notifications/preferences`            `{ kind, channel, enabled }`
 * - `GET  /api/v1/notifications/push/key`               the public VAPID key (404 when push is not set up)
 * - `POST /api/v1/notifications/push`                   `{ endpoint, keys: { p256dh, auth } }`: this device
 * - `DELETE /api/v1/notifications/push`                 `{ endpoint }`
 */
import { HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import type { FastifyRequest } from 'fastify';
import { defaultEnabled } from './inbox.js';
import { CHANNELS, KINDS } from './models.js';
import { type Pusher, subscribePush, unsubscribePush } from './push.js';

type Row = Record<string, unknown>;
interface Set {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
  write(values: unknown): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Set>;
  browse(ids: readonly number[]): Set;
  create(rows: readonly unknown[]): Promise<Set>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;

const KEYS = ['id', 'kind', 'params', 'resModel', 'resId', 'actor', 'readAt', 'createdAt'];

/** One notification as the API serves it. */
export interface NotificationItem {
  readonly id: number;
  readonly kind: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly model: string;
  readonly resId: number;
  readonly readAt: string | null;
  readonly createdAt: string;
}

function item(row: Row): NotificationItem {
  const at = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null ? null : String(v));
  return {
    id: row['id'] as number,
    kind: String(row['kind']),
    params: (row['params'] as Record<string, unknown> | null) ?? {},
    model: String(row['resModel']),
    resId: row['resId'] as number,
    readAt: at(row['readAt']),
    createdAt: at(row['createdAt']) ?? '',
  };
}

function idParam(request: FastifyRequest): number {
  const id = Number((request.params as { id?: unknown }).id);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'id must be a positive integer.');
  return id;
}

/** The caller's unread notifications count. */
export async function unreadCount(env: Env): Promise<number> {
  return (await ref(env, 'notify.notification').search({ where: { readAt: null } })).length;
}

/** Registers the routes. */
export function registerNotifyRoutes(
  { app }: ModuleContext,
  options: { readonly pusher?: Pusher | undefined } = {},
): void {
  app.get('/api/v1/notifications/push/key', async (request) => {
    await request.env(async () => undefined); // signed in
    if (options.pusher === undefined)
      throw new HttpProblem(
        404,
        'push-not-configured',
        'Push is not set up',
        'This installation has no VAPID keys.',
        'Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (kosh init writes them).',
      );
    return { publicKey: options.pusher.publicKey };
  });

  app.post('/api/v1/notifications/push', async (request) => {
    const body = (request.body ?? {}) as {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
    };
    const endpoint = body.endpoint;
    const p256dh = body.keys?.p256dh;
    const auth = body.keys?.auth;
    if (
      typeof endpoint !== 'string' ||
      !/^https:\/\/[^\s]{1,1990}$/.test(endpoint) ||
      typeof p256dh !== 'string' ||
      p256dh === '' ||
      p256dh.length > 500 ||
      typeof auth !== 'string' ||
      auth === '' ||
      auth.length > 200
    )
      throw new HttpProblem(
        400,
        'invalid-subscription',
        'Invalid subscription',
        'A push subscription is { endpoint: https URL, keys: { p256dh, auth } } as the browser serializes it.',
      );
    await request.env((env) =>
      subscribePush(env, { endpoint, keys: { p256dh, auth } }, request.headers['user-agent']),
    );
    return { subscribed: true };
  });

  app.delete('/api/v1/notifications/push', async (request) => {
    const endpoint = (request.body as { endpoint?: unknown } | null)?.endpoint;
    if (typeof endpoint !== 'string')
      throw new HttpProblem(400, 'invalid-body', 'Invalid request', 'endpoint is required.');
    return request.env(async (env) => ({ removed: await unsubscribePush(env, endpoint) }));
  });

  app.get('/api/v1/notifications', async (request) => {
    const q = (request.query ?? {}) as { unread?: unknown; limit?: unknown };
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new HttpProblem(400, 'invalid-limit', 'Invalid limit', 'limit must be 1–200.');
    return request.env(async (env) => {
      const found = await ref(env, 'notify.notification').search({
        ...(q.unread === 'true' ? { where: { readAt: null } } : {}),
        order: ['createdAt desc', 'id desc'],
        limit,
      });
      const items = found.length === 0 ? [] : (await found.load(KEYS)).read(KEYS).map(item);
      return { items, unread: await unreadCount(env) };
    });
  });

  app.get('/api/v1/notifications/count', async (request) =>
    request.env(async (env) => ({ unread: await unreadCount(env) })),
  );

  app.post('/api/v1/notifications/read-all', async (request) =>
    request.env(async (env) => {
      const unread = await ref(env, 'notify.notification').search({ where: { readAt: null } });
      if (unread.length > 0) await unread.write({ readAt: new Date() });
      return { read: unread.length };
    }),
  );

  app.post('/api/v1/notifications/:id/read', async (request) => {
    const id = idParam(request);
    return request.env(async (env) => {
      const one = await ref(env, 'notify.notification').search({ where: { id } }); // rules: own only
      if (one.length === 0)
        throw new HttpProblem(404, 'not-found', 'Not found', `No notification ${id}.`);
      await one.write({ readAt: new Date() });
      return { unread: await unreadCount(env) };
    });
  });

  app.get('/api/v1/notifications/preferences', async (request) =>
    request.env(async (env) => {
      const found = await ref(env, 'notify.preference').search({ where: {} });
      const rows =
        found.length === 0
          ? []
          : (await found.load(['kind', 'channel', 'enabled'])).read(['kind', 'channel', 'enabled']);
      const enabled = (kind: string, channel: string) => {
        const row = rows.find((r) => r['kind'] === kind && r['channel'] === channel);
        return row === undefined ? defaultEnabled(kind, channel) : row['enabled'] === true;
      };
      return {
        kinds: KINDS.map((kind) => ({
          kind,
          channels: Object.fromEntries(CHANNELS.map((c) => [c, enabled(kind, c)])),
        })),
      };
    }),
  );

  app.put('/api/v1/notifications/preferences', async (request) => {
    const body = (request.body ?? {}) as { kind?: unknown; channel?: unknown; enabled?: unknown };
    if (
      !KINDS.includes(body.kind as never) ||
      !CHANNELS.includes(body.channel as never) ||
      typeof body.enabled !== 'boolean'
    )
      throw new HttpProblem(
        400,
        'invalid-body',
        'Invalid preference',
        `kind is one of ${KINDS.join(', ')}; channel one of ${CHANNELS.join(', ')}; enabled a boolean.`,
      );
    const { kind, channel, enabled } = body as { kind: string; channel: string; enabled: boolean };
    return request.env(async (env) => {
      const existing = await ref(env, 'notify.preference').search({ where: { kind, channel } });
      if (existing.length > 0) await existing.write({ enabled });
      else await ref(env, 'notify.preference').create([{ user: env.uid, kind, channel, enabled }]);
      return { kind, channel, enabled };
    });
  });
}
