/**
 * The email channel (RFC 0006 §5.4): one `notify.delivery` per notification and channel, sent by a job
 * (`notify.deliver`, Shutro's transactional jobs) through the configured {@link Mailer}. The job renders the message
 * in the recipient's language with a link that opens the record (`/open/<model>/<id>`), marks the delivery sent in
 * its own transaction, and leaves a failed attempt recorded for the retries (exponential backoff, then `failed`).
 */
import { layout, type Mailer } from '@kosh/mail';
import type { Driver, Env, Shutro, Worker } from '@kosh/server/orm';
import { sentence, textsFor } from './messages.js';
import { type Messenger, normalizePhone } from './messenger.js';
import { type Pusher, sendPush } from './push.js';

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

/** The job's name. */
export const DELIVER_JOB = 'notify.deliver';

/** What delivering needs. */
export interface DeliveryContext {
  readonly shutro: Shutro;
  readonly driver: Driver;
  /** The email provider; without it, no email deliveries are created. */
  readonly mailer?: Mailer | undefined;
  /** The web push provider; without it, no push deliveries are created. */
  readonly pusher?: Pusher | undefined;
  /** The SMS / WhatsApp provider; without it, no text deliveries are created. */
  readonly messenger?: Messenger | undefined;
  /** Where the back-office is reached (`KOSH_BASE_URL`), for the links in messages. */
  readonly baseUrl: string;
  /** The reply address of a record email to a recipient (RFC 0006 §7.1), when replies by email are on. */
  readonly replyAddress?:
    | ((target: { readonly model: string; readonly id: number; readonly uid: number }) => string)
    | undefined;
}

/** Renders the email of a notification for a recipient. */
export function renderEmail(
  context: Pick<DeliveryContext, 'baseUrl'>,
  recipient: { readonly name: string; readonly lang: string | null },
  notification: {
    readonly kind: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly model: string;
    readonly resId: number;
  },
): { readonly subject: string; readonly html: string; readonly text: string } {
  const texts = textsFor(recipient.lang);
  const subject = sentence(recipient.lang, notification.kind, notification.params);
  const preview = notification.params['preview'];
  const url = `${context.baseUrl.replace(/\/$/, '')}/open/${encodeURIComponent(notification.model)}/${notification.resId}`;
  const rendered = layout({
    title: subject,
    paragraphs: typeof preview === 'string' && preview !== '' ? [`“${preview}”`] : [],
    action: { label: texts.email.open, url },
    footer: texts.email.why,
    lang: (recipient.lang ?? 'en').split(/[_-]/)[0] ?? 'en',
    dir: /^(ar|fa|he|ur)/.test(recipient.lang ?? '') ? 'rtl' : 'ltr',
  });
  return { subject, ...rendered };
}

/**
 * Creates the SMS and WhatsApp deliveries of freshly written notifications and enqueues their jobs, in the
 * caller's transaction. Recipients without a phone number get none; both channels are opt-in per user.
 */
export async function queueMessages(
  context: DeliveryContext,
  env: Env,
  su: Env,
  notificationIds: readonly number[],
  wants: (uid: number, kind: string, channel: string) => Promise<boolean>,
): Promise<number> {
  const messenger = context.messenger;
  if (messenger === undefined || notificationIds.length === 0) return 0;
  const keys = ['id', 'user', 'kind'];
  const rows = (await ref(su, 'notify.notification').browse(notificationIds).load(keys)).read(keys);
  let queued = 0;
  for (const n of rows) {
    const uid = n['user'] as number;
    const [user] = (await ref(su, 'res.users').browse([uid]).load(['phone'])).read(['phone']);
    const phone = typeof user?.['phone'] === 'string' ? normalizePhone(user['phone']) : null;
    if (phone === null) continue;
    for (const channel of messenger.channels) {
      if (!(await wants(uid, String(n['kind']), channel))) continue;
      const created = await ref(su, 'notify.delivery').create([
        { notification: n['id'], channel, state: 'pending', attempts: 0 },
      ]);
      const id = created.ids[0] as number;
      await env.enqueue(DELIVER_JOB, { delivery: id }, { key: `${DELIVER_JOB}:${id}` });
      queued += 1;
    }
  }
  return queued;
}

/** The text of a notification for SMS or WhatsApp: the sentence and the record's link. */
export function renderText(
  context: Pick<DeliveryContext, 'baseUrl'>,
  lang: string | null,
  notification: {
    readonly kind: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly model: string;
    readonly resId: number;
  },
): string {
  const line = sentence(lang, notification.kind, notification.params);
  const url = `${context.baseUrl.replace(/\/$/, '')}/open/${encodeURIComponent(notification.model)}/${notification.resId}`;
  return `${line}\n${url}`;
}

/**
 * Creates the email deliveries of freshly written notifications and enqueues their jobs, in the caller's
 * transaction (the system's). Recipients without an email address get none.
 */
export async function queueEmails(
  context: DeliveryContext,
  env: Env,
  su: Env,
  notificationIds: readonly number[],
  wants: (uid: number, kind: string) => Promise<boolean>,
): Promise<number> {
  if (context.mailer === undefined || notificationIds.length === 0) return 0;
  const keys = ['id', 'user', 'kind'];
  const rows = (await ref(su, 'notify.notification').browse(notificationIds).load(keys)).read(keys);
  let queued = 0;
  for (const n of rows) {
    const uid = n['user'] as number;
    if (!(await wants(uid, String(n['kind'])))) continue;
    const [user] = (await ref(su, 'res.users').browse([uid]).load(['email'])).read(['email']);
    const email = user?.['email'];
    if (typeof email !== 'string' || email === '') continue;
    const created = await ref(su, 'notify.delivery').create([
      { notification: n['id'], channel: 'email', state: 'pending', attempts: 0 },
    ]);
    const id = created.ids[0] as number;
    await env.enqueue(DELIVER_JOB, { delivery: id }, { key: `${DELIVER_JOB}:${id}` });
    queued += 1;
  }
  return queued;
}

/** Sends one delivery: the job's handler. @throws to make Shutro retry (the attempt is recorded first). */
export async function deliver(context: DeliveryContext, env: Env, payload: unknown): Promise<void> {
  const id = Number((payload as { delivery?: unknown } | null)?.delivery);
  if (!Number.isSafeInteger(id)) return;
  const mailer = context.mailer;
  await env.asSuperuser({ reason: `deliver ${id}` }, async (su) => {
    const [delivery] = (
      await ref(su, 'notify.delivery')
        .browse([id])
        .load(['id', 'notification', 'channel', 'state', 'attempts'])
    ).read(['id', 'notification', 'channel', 'state', 'attempts']);
    if (delivery === undefined || delivery['state'] === 'sent') return;
    const nKeys = ['kind', 'params', 'resModel', 'resId', 'user'];
    const [n] = (
      await ref(su, 'notify.notification')
        .browse([delivery['notification'] as number])
        .load(nKeys)
    ).read(nKeys);
    if (n === undefined) return;
    const uKeys = ['name', 'email', 'lang'];
    const [user] = (
      await ref(su, 'res.users')
        .browse([n['user'] as number])
        .load(uKeys)
    ).read(uKeys);
    const to = user?.['email'];
    if (delivery['channel'] === 'webpush') {
      await sendPush(
        context,
        su,
        id,
        {
          id: delivery['notification'] as number,
          user: n['user'] as number,
          kind: String(n['kind']),
          params: (n['params'] as Record<string, unknown> | null) ?? {},
          model: String(n['resModel']),
          resId: n['resId'] as number,
        },
        (user?.['lang'] as string | null) ?? null,
      );
      return;
    }
    if (delivery['channel'] === 'sms' || delivery['channel'] === 'whatsapp') {
      const channel = delivery['channel'];
      const messenger = context.messenger;
      const [phoneRow] = (
        await ref(su, 'res.users')
          .browse([n['user'] as number])
          .load(['phone'])
      ).read(['phone']);
      const phone =
        typeof phoneRow?.['phone'] === 'string' ? normalizePhone(phoneRow['phone']) : null;
      if (messenger === undefined || !messenger.channels.includes(channel) || phone === null) {
        await ref(su, 'notify.delivery')
          .browse([id])
          .write({
            state: 'skipped',
            error: messenger === undefined ? 'no messenger' : 'no phone number',
          });
        return;
      }
      const text = renderText(context, (user?.['lang'] as string | null) ?? null, {
        kind: String(n['kind']),
        params: (n['params'] as Record<string, unknown> | null) ?? {},
        model: String(n['resModel']),
        resId: n['resId'] as number,
      });
      try {
        const sent = await messenger.send({ channel, to: phone, text });
        await ref(su, 'notify.delivery')
          .browse([id])
          .write({ state: 'sent', sentAt: new Date(), providerId: sent.id, error: null });
      } catch (error) {
        await context.driver.query({
          text: `UPDATE notify_delivery SET attempts = attempts + 1, error = $2, state = 'failed' WHERE id = $1`,
          params: [id, error instanceof Error ? error.message.slice(0, 500) : String(error)],
        });
        throw error;
      }
      return;
    }
    if (mailer === undefined || typeof to !== 'string' || to === '') {
      await ref(su, 'notify.delivery')
        .browse([id])
        .write({
          state: 'skipped',
          error: mailer === undefined ? 'no mailer' : 'no email address',
        });
      return;
    }
    const mail = renderEmail(
      context,
      { name: String(user?.['name'] ?? ''), lang: (user?.['lang'] as string | null) ?? null },
      {
        kind: String(n['kind']),
        params: (n['params'] as Record<string, unknown> | null) ?? {},
        model: String(n['resModel']),
        resId: n['resId'] as number,
      },
    );
    try {
      const replyTo = context.replyAddress?.({
        model: String(n['resModel']),
        id: n['resId'] as number,
        uid: n['user'] as number,
      });
      const sent = await mailer.send({
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        ...(replyTo === undefined ? {} : { replyTo }),
      });
      await ref(su, 'notify.delivery')
        .browse([id])
        .write({ state: 'sent', sentAt: new Date(), providerId: sent.id, error: null });
    } catch (error) {
      // Outside the job's transaction (which rolls back on the throw): the attempt stays recorded.
      await context.driver.query({
        text: `UPDATE notify_delivery SET attempts = attempts + 1, error = $2, state = 'failed' WHERE id = $1`,
        params: [id, error instanceof Error ? error.message.slice(0, 500) : String(error)],
      });
      throw error;
    }
  });
}

/** The job worker: `start()` it to run in the background; tests `drain()` it. */
export function deliveryWorker(context: DeliveryContext): Worker {
  return context.shutro.work(
    { [DELIVER_JOB]: (payload, env) => deliver(context, env, payload) },
    { pollMs: 5000 },
  );
}
