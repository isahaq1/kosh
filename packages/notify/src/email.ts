/**
 * The email channel (RFC 0006 §5.4): one `notify.delivery` per notification and channel, sent by a job
 * (`notify.deliver`, Shutro's transactional jobs) through the configured {@link Mailer}. The job renders the message
 * in the recipient's language with a link that opens the record (`/open/<model>/<id>`), marks the delivery sent in
 * its own transaction, and leaves a failed attempt recorded for the retries (exponential backoff, then `failed`).
 */
import { layout, type Mailer } from '@kosh/mail';
import type { Driver, Env, Shutro, Worker } from '@kosh/server/orm';
import { sentence, textsFor } from './messages.js';
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
  /** Where the back-office is reached (`KOSH_BASE_URL`), for the links in messages. */
  readonly baseUrl: string;
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
      const sent = await mailer.send({
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
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
