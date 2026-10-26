/**
 * The web push channel (RFC 0006 §5.4): browsers that opted in on a device keep a `notify.push_subscription`
 * (the push service's endpoint and the encryption keys the browser made). A notification wanted on this channel
 * gets one `notify.delivery` whose job sends an encrypted payload (title, body, the record's link) to every
 * subscription of the recipient; a subscription the push service reports gone (404, 410) is deleted. Keys are
 * VAPID (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`): `kosh init` generates them.
 */
import type { Env } from '@kosh/server/orm';
import webpush from 'web-push';
import { sentence } from './messages.js';

type Row = Record<string, unknown>;
interface Set {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
  write(values: unknown): Promise<void>;
  unlink(): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Set>;
  browse(ids: readonly number[]): Set;
  create(rows: readonly unknown[]): Promise<Set>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;

/** A browser's push subscription, as `PushManager.subscribe()` serializes it. */
export interface PushSubscriptionInput {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

/** What a push message carries (the service worker reads it). */
export interface PushPayload {
  readonly title: string;
  readonly body: string;
  /** Where a click goes (`/open/<model>/<id>`, relative to the app). */
  readonly url: string;
  /** The notification's id, so a click can mark it read. */
  readonly id: number;
}

/** Sends push messages; the push service's answer. */
export interface Pusher {
  readonly publicKey: string;
  send(
    subscription: PushSubscriptionInput,
    payload: PushPayload,
  ): Promise<{ readonly status: number }>;
}

/** The VAPID keys of an installation. */
export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
  /** `mailto:` or `https:` contact of the operator, sent to push services. */
  readonly subject: string;
}

/** New VAPID keys (once per installation; `kosh init` writes them to `.env`). */
export function generateVapidKeys(): { readonly publicKey: string; readonly privateKey: string } {
  const keys = webpush.generateVAPIDKeys();
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
}

/** The pusher on web-push: encrypted payloads signed with the VAPID keys. */
export function createWebPusher(keys: VapidKeys): Pusher {
  return {
    publicKey: keys.publicKey,
    async send(subscription, payload) {
      try {
        const result = await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: { ...subscription.keys } },
          JSON.stringify(payload),
          {
            vapidDetails: {
              subject: keys.subject,
              publicKey: keys.publicKey,
              privateKey: keys.privateKey,
            },
            TTL: 24 * 3600,
          },
        );
        return { status: result.statusCode };
      } catch (error) {
        if (error instanceof webpush.WebPushError) return { status: error.statusCode };
        throw error;
      }
    },
  };
}

/** A pusher from the environment, or none when the keys are not set. */
export function pusherFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Pusher | undefined {
  const publicKey = env['VAPID_PUBLIC_KEY'];
  const privateKey = env['VAPID_PRIVATE_KEY'];
  if (publicKey === undefined || publicKey === '' || privateKey === undefined || privateKey === '')
    return undefined;
  return createWebPusher({
    publicKey,
    privateKey,
    subject: env['VAPID_SUBJECT'] ?? 'mailto:admin@localhost',
  });
}

/** A pusher that keeps what it is given and answers a status per endpoint (tests). */
export function createMemoryPusher(
  statusOf: (endpoint: string) => number = () => 201,
): Pusher & { readonly sent: { subscription: PushSubscriptionInput; payload: PushPayload }[] } {
  const sent: { subscription: PushSubscriptionInput; payload: PushPayload }[] = [];
  return {
    publicKey: 'memory',
    sent,
    async send(subscription, payload) {
      sent.push({ subscription, payload });
      return { status: statusOf(subscription.endpoint) };
    },
  };
}

/** Saves a browser's subscription for the caller (an endpoint already saved is refreshed). */
export async function subscribePush(
  env: Env,
  input: PushSubscriptionInput,
  userAgent: string | undefined,
): Promise<void> {
  const existing = await ref(env, 'notify.push_subscription').search({
    where: { endpoint: input.endpoint },
  });
  const values = {
    user: env.uid,
    endpoint: input.endpoint,
    p256dh: input.keys.p256dh,
    auth: input.keys.auth,
    userAgent: userAgent?.slice(0, 200) ?? null,
    lastSeenAt: new Date(),
  };
  if (existing.length > 0) await existing.write(values);
  else await ref(env, 'notify.push_subscription').create([values]);
}

/** Forgets a subscription of the caller. */
export async function unsubscribePush(env: Env, endpoint: string): Promise<boolean> {
  const found = await ref(env, 'notify.push_subscription').search({ where: { endpoint } });
  if (found.length === 0) return false;
  await found.unlink();
  return true;
}

/**
 * Creates the push deliveries of freshly written notifications and enqueues their jobs, in the caller's
 * transaction. Recipients without a subscription get none.
 */
export async function queuePush(
  context: { readonly pusher?: Pusher | undefined },
  enqueue: (deliveryId: number, runAt?: Date) => Promise<void>,
  su: Env,
  notificationIds: readonly number[],
  wants: (uid: number, kind: string) => Promise<boolean>,
  holdUntil: (uid: number) => Promise<Date | null> = async () => null,
): Promise<number> {
  if (context.pusher === undefined || notificationIds.length === 0) return 0;
  const keys = ['id', 'user', 'kind'];
  const rows = (await ref(su, 'notify.notification').browse(notificationIds).load(keys)).read(keys);
  let queued = 0;
  for (const n of rows) {
    const uid = n['user'] as number;
    if (!(await wants(uid, String(n['kind'])))) continue;
    const subscriptions = await ref(su, 'notify.push_subscription').search({
      where: { user: uid },
    });
    if (subscriptions.length === 0) continue;
    // Quiet hours hold push until they end (RFC 0006 §8.2).
    const hold = await holdUntil(uid);
    const created = await ref(su, 'notify.delivery').create([
      {
        notification: n['id'],
        channel: 'webpush',
        state: hold === null ? 'pending' : 'held',
        notBefore: hold,
        attempts: 0,
      },
    ]);
    await enqueue(created.ids[0] as number, hold ?? undefined);
    queued += 1;
  }
  return queued;
}

/**
 * Sends one push delivery to every subscription of the recipient: gone subscriptions (404, 410) are deleted;
 * the delivery is `sent` when at least one push service accepted, `skipped` when no subscription is left.
 * @throws when a push service answered with another error, to make Shutro retry (the attempt is recorded first).
 */
export async function sendPush(
  context: {
    readonly pusher?: Pusher | undefined;
    readonly driver: { query(q: { text: string; params: unknown[] }): Promise<unknown> };
  },
  su: Env,
  deliveryId: number,
  notification: {
    readonly id: number;
    readonly user: number;
    readonly kind: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly model: string;
    readonly resId: number;
  },
  lang: string | null,
): Promise<void> {
  const pusher = context.pusher;
  const delivery = ref(su, 'notify.delivery').browse([deliveryId]);
  if (pusher === undefined) {
    await delivery.write({ state: 'skipped', error: 'no push keys' });
    return;
  }
  const keys = ['id', 'endpoint', 'p256dh', 'auth'];
  const found = await ref(su, 'notify.push_subscription').search({
    where: { user: notification.user },
  });
  const subscriptions = found.length === 0 ? [] : (await found.load(keys)).read(keys);
  const preview = notification.params['preview'];
  const payload: PushPayload = {
    title: sentence(lang, notification.kind, notification.params),
    body: typeof preview === 'string' ? preview : '',
    url: `/open/${encodeURIComponent(notification.model)}/${notification.resId}`,
    id: notification.id,
  };
  let accepted = 0;
  const gone: number[] = [];
  let failure: string | null = null;
  for (const s of subscriptions) {
    const { status } = await pusher.send(
      {
        endpoint: String(s['endpoint']),
        keys: { p256dh: String(s['p256dh']), auth: String(s['auth']) },
      },
      payload,
    );
    if (status >= 200 && status < 300) accepted += 1;
    else if (status === 404 || status === 410) gone.push(s['id'] as number);
    else failure = `push service answered ${status}`;
  }
  if (gone.length > 0) await ref(su, 'notify.push_subscription').browse(gone).unlink();
  if (accepted > 0) {
    await delivery.write({ state: 'sent', sentAt: new Date(), error: null });
    return;
  }
  if (failure === null) {
    await delivery.write({ state: 'skipped', error: 'no subscription left' });
    return;
  }
  await context.driver.query({
    text: `UPDATE notify_delivery SET attempts = attempts + 1, error = $2, state = 'failed' WHERE id = $1`,
    params: [deliveryId, failure],
  });
  throw new Error(failure);
}
