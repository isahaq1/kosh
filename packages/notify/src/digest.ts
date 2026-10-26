/**
 * The daily digest (RFC 0006 §8.3): an email whose mode is `daily` waits as a `digest` delivery; one job per user
 * and day (`notify.digest`, keyed by the user and the local date, run at their digest hour) sends **one** email
 * with every waiting notification, grouped by record, in the user's language. Notifications read in the inbox
 * meanwhile, and records the user may no longer read, are left out; an empty digest sends nothing. A failed send
 * is retried; after the last attempt, every delivery in it falls back (§8.4).
 */
import { layout } from '@kosh/mail';
import type { Env } from '@kosh/server/orm';
import type { DeliveryContext } from './email.js';
import { queueFallback } from './fallback.js';
import { DIGEST_JOB, MAX_ATTEMPTS } from './jobs.js';
import { interpolate, sentence, textsFor } from './messages.js';
import { deliverySettingsOf } from './prefs.js';
import { localDate, nextLocal } from './quiet.js';

type Row = Record<string, unknown>;
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
  write(values: unknown): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Rows>;
  browse(ids: readonly number[]): Rows;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;

/** Enqueues the user's next digest (once per local day: the key deduplicates), at their digest hour. */
export async function scheduleDigest(
  env: Env,
  su: Env,
  uid: number,
  now: Date = new Date(),
): Promise<void> {
  const { digestMinutes, tz } = await deliverySettingsOf(su, uid);
  const at = nextLocal(now, digestMinutes, tz);
  await env.enqueue(
    DIGEST_JOB,
    { user: uid },
    { key: `${DIGEST_JOB}:${uid}:${localDate(at, tz)}`, runAt: at },
  );
}

/** The digest email of a user's notifications (`sections`: one per record, in order of arrival). */
export function renderDigest(
  context: Pick<DeliveryContext, 'baseUrl'>,
  lang: string | null,
  notifications: readonly {
    readonly kind: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly model: string;
    readonly resId: number;
  }[],
): { readonly subject: string; readonly html: string; readonly text: string } {
  const texts = textsFor(lang);
  const base = context.baseUrl.replace(/\/$/, '');
  const sections = new Map<string, { heading: string; url: string; lines: string[] }>();
  for (const n of notifications) {
    const key = `${n.model}:${n.resId}`;
    const record = n.params['record'];
    const section = sections.get(key) ?? {
      heading: typeof record === 'string' && record !== '' ? record : `#${n.resId}`,
      url: `${base}/open/${encodeURIComponent(n.model)}/${n.resId}`,
      lines: [],
    };
    section.lines.push(sentence(lang, n.kind, n.params));
    sections.set(key, section);
  }
  const subject = interpolate(texts.email.digestSubject, { count: notifications.length });
  const rendered = layout({
    title: subject,
    paragraphs: [texts.email.digestIntro],
    sections: [...sections.values()],
    footer: texts.email.why,
    lang: (lang ?? 'en').split(/[_-]/)[0] ?? 'en',
    dir: /^(ar|fa|he|ur)/.test(lang ?? '') ? 'rtl' : 'ltr',
  });
  return { subject, ...rendered };
}

/** The digest job's handler: `{ user }`. @throws to make Shutro retry (the attempt is recorded first). */
export async function sendDigest(
  context: DeliveryContext,
  env: Env,
  payload: unknown,
): Promise<void> {
  const uid = Number((payload as { user?: unknown } | null)?.user);
  if (!Number.isSafeInteger(uid)) return;
  await env.asSuperuser({ reason: `digest ${uid}` }, async (su) => {
    const waiting = await ref(su, 'notify.delivery').search({
      where: { state: 'digest', channel: 'email' },
      order: ['id asc'],
    });
    if (waiting.length === 0) return;
    const deliveries = (await waiting.load(['id', 'notification'])).read(['id', 'notification']);
    const nKeys = ['id', 'user', 'kind', 'params', 'resModel', 'resId', 'readAt', 'company'];
    const notifications = new Map(
      (
        await ref(su, 'notify.notification')
          .browse([...new Set(deliveries.map((d) => d['notification'] as number))])
          .load(nKeys)
      )
        .read(nKeys)
        .filter((n) => n['user'] === uid)
        .map((n) => [n['id'] as number, n]),
    );
    const mine = deliveries.filter((d) => notifications.has(d['notification'] as number));
    const skip = async (id: number, reason: string) =>
      ref(su, 'notify.delivery').browse([id]).write({ state: 'skipped', error: reason });
    const included: { id: number; n: Row }[] = [];
    for (const d of mine) {
      const id = d['id'] as number;
      const n = notifications.get(d['notification'] as number) as Row;
      if (n['readAt'] !== null && n['readAt'] !== undefined) await skip(id, 'read');
      else if (
        context.mayRead !== undefined &&
        !(await context.mayRead(
          uid,
          (n['company'] as number | null) ?? 0,
          String(n['resModel']),
          n['resId'] as number,
        ))
      )
        await skip(id, 'no access');
      else included.push({ id, n });
    }
    if (included.length === 0) return;
    const ids = included.map((i) => i.id);
    const [user] = (await ref(su, 'res.users').browse([uid]).load(['email', 'lang'])).read([
      'email',
      'lang',
    ]);
    const to = user?.['email'];
    if (context.mailer === undefined || typeof to !== 'string' || to === '') {
      await ref(su, 'notify.delivery')
        .browse(ids)
        .write({
          state: 'skipped',
          error: context.mailer === undefined ? 'no mailer' : 'no email address',
        });
      for (const id of ids) await queueFallback(context, env, su, id);
      return;
    }
    const mail = renderDigest(
      context,
      (user?.['lang'] as string | null) ?? null,
      included.map(({ n }) => ({
        kind: String(n['kind']),
        params: (n['params'] as Record<string, unknown> | null) ?? {},
        model: String(n['resModel']),
        resId: n['resId'] as number,
      })),
    );
    try {
      const sent = await context.mailer.send({
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      await ref(su, 'notify.delivery')
        .browse(ids)
        .write({ state: 'sent', sentAt: new Date(), providerId: sent.id, error: null });
    } catch (error) {
      // Outside the job's transaction (which rolls back on the throw): the attempt stays recorded.
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
      const [row] = await context.driver.query<{ attempts: number }>({
        text: 'UPDATE notify_delivery SET attempts = attempts + 1, error = $2 WHERE id = ANY($1) RETURNING attempts',
        params: [ids, message],
      });
      if ((row?.attempts ?? 0) < MAX_ATTEMPTS) throw error;
      // The last attempt: every delivery of the digest fails and falls back, and the job ends. The rows are written
      // outside this transaction, which must not write them again (repeatable read).
      await context.driver.query({
        text: "UPDATE notify_delivery SET state = 'failed' WHERE id = ANY($1)",
        params: [ids],
      });
      for (const id of ids) await queueFallback(context, env, su, id, { failed: true });
    }
  });
}
