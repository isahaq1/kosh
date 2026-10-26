/**
 * Fallback channels (RFC 0006 §8.4): when a delivery on a channel ends without reaching its recipient — failed
 * after its last attempt, bounced, or skipped because the channel has nowhere to deliver — and no other channel of
 * the notification was sent, the recipient's fallback channel takes over: one new delivery (`fallbackOf`), run like
 * any other (quiet hours and the email mode apply). One level only: a fallback never falls back again, and a
 * channel is never its own fallback.
 */
import type { Env, Shutro, Worker } from '@kosh/server/orm';
import { scheduleDigest } from './digest.js';
import type { DeliveryContext } from './email.js';
import { DELIVER_JOB } from './jobs.js';
import { normalizePhone } from './messenger.js';
import { deliverySettingsOf, emailModeOf, holdUntil, wants } from './prefs.js';

type Row = Record<string, unknown>;
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
}
interface Ref {
  search(q: unknown): Promise<Rows>;
  browse(ids: readonly number[]): Rows;
  create(rows: readonly unknown[]): Promise<Rows>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;
const one = async (env: Env, model: string, id: number, keys: string[]): Promise<Row | undefined> =>
  (await ref(env, model).browse([id]).load(keys)).read(keys)[0];

/** The outbox event the mail package emits when an email we sent bounced (`{ delivery }`). */
export const BOUNCED_TOPIC = 'notify.delivery.bounced';

/** Skip reasons that are not "nowhere to deliver": the recipient read it, or may no longer read the record. */
const NOT_A_FAILURE = new Set(['read', 'no access']);
export const fallsBack = (state: unknown, error: unknown): boolean =>
  state === 'failed' ||
  state === 'bounced' ||
  (state === 'skipped' && !NOT_A_FAILURE.has(String(error ?? '')));

/**
 * Creates the fallback delivery of a delivery that did not reach its recipient, in the caller's transaction (the
 * system's, `su`; `env` enqueues). Returns its id, or null when there is no fallback to make.
 */
export async function queueFallback(
  context: DeliveryContext,
  env: Env,
  su: Env,
  deliveryId: number,
  options: {
    /** The delivery failed for good, as written outside this transaction (its snapshot may not show it). */
    readonly failed?: boolean;
  } = {},
): Promise<number | null> {
  const failed = await one(su, 'notify.delivery', deliveryId, [
    'channel',
    'notification',
    'fallbackOf',
    'state',
    'error',
  ]);
  if (failed === undefined || (failed['fallbackOf'] ?? null) !== null) return null;
  if (options.failed !== true && !fallsBack(failed['state'], failed['error'])) return null;
  const notification = failed['notification'] as number;
  const n = await one(su, 'notify.notification', notification, ['user', 'kind', 'readAt']);
  if (n === undefined || (n['readAt'] !== null && n['readAt'] !== undefined)) return null;
  const others = await ref(su, 'notify.delivery').search({ where: { notification } });
  const states =
    others.length === 0 ? [] : (await others.load(['channel', 'state'])).read(['channel', 'state']);
  if (states.some((d) => d['state'] === 'sent')) return null;
  const uid = n['user'] as number;
  const kind = String(n['kind']);
  const { fallback } = await deliverySettingsOf(su, uid);
  if (
    fallback === 'none' ||
    fallback === 'inapp' ||
    fallback === failed['channel'] ||
    states.some((d) => d['channel'] === fallback)
  )
    return null;

  let state: 'pending' | 'held' | 'digest' = 'pending';
  let notBefore: Date | null = null;
  if (fallback === 'email') {
    const user = await one(su, 'res.users', uid, ['email']);
    if (context.mailer === undefined || typeof user?.['email'] !== 'string' || user['email'] === '')
      return null;
    const mode = await emailModeOf(su, uid, kind);
    if (mode === 'off') return null;
    if (mode === 'daily') state = 'digest';
  } else if (fallback === 'webpush') {
    if (context.pusher === undefined || !(await wants(su, uid, kind, 'webpush'))) return null;
    const subscriptions = await ref(su, 'notify.push_subscription').search({
      where: { user: uid },
    });
    if (subscriptions.length === 0) return null;
  } else if (fallback === 'sms' || fallback === 'whatsapp') {
    const user = await one(su, 'res.users', uid, ['phone']);
    const phone = typeof user?.['phone'] === 'string' ? normalizePhone(user['phone']) : null;
    if (
      context.messenger === undefined ||
      !context.messenger.channels.includes(fallback) ||
      phone === null ||
      !(await wants(su, uid, kind, fallback))
    )
      return null;
  } else return null;
  if (state === 'pending' && fallback !== 'email') {
    notBefore = await holdUntil(su, uid);
    if (notBefore !== null) state = 'held';
  }
  const created = await ref(su, 'notify.delivery').create([
    { notification, channel: fallback, state, notBefore, attempts: 0, fallbackOf: deliveryId },
  ]);
  const id = created.ids[0] as number;
  if (state === 'digest') await scheduleDigest(env, su, uid);
  else
    await env.enqueue(
      DELIVER_JOB,
      { delivery: id },
      { key: `${DELIVER_JOB}:${id}`, ...(notBefore === null ? {} : { runAt: notBefore }) },
    );
  return id;
}

/** The subscriber that falls back from bounced emails (the mail package emits {@link BOUNCED_TOPIC}). */
export function fallbackWorker(context: DeliveryContext & { readonly shutro: Shutro }): Worker {
  return context.shutro.subscribe(
    'notify.fallback',
    BOUNCED_TOPIC,
    async (event, env) => {
      const id = Number((event.payload as { delivery?: unknown } | null)?.delivery);
      if (!Number.isSafeInteger(id)) return;
      await env.asSuperuser({ reason: 'notification fallback' }, (su) =>
        queueFallback(context, env, su, id),
      );
    },
    { pollMs: 5000 },
  );
}
