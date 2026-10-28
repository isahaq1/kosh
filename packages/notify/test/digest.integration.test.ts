/**
 * Digests and fallback channels (RFC 0006 §8.3–8.4) on real PostgreSQL: daily emails wait for the user's digest,
 * which goes out once at their hour with every unread notification grouped by record (read ones left out, an empty
 * digest sends nothing); a push with nowhere to go falls back to email, a bounced email to push (through the mail
 * package's event), the last failed attempt falls back, and a fallback never falls back again.
 */
import { createMemoryMailer, type Mailer } from '@kosh/mail';
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { base, baseShutro, createServer, installBase, type KoshServer } from '@kosh/server';
import { type Env, orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  BOUNCED_TOPIC,
  createMemoryPusher,
  deliver,
  deliveryWorker,
  fallbackWorker,
  inboxWorkers,
  MAX_ATTEMPTS,
  notifyModule,
  queueFallback,
  sendDigest,
} from '../src/index.js';

const PASSWORD = 'correct horse battery';
const { defineGroup, defineModel, defineModule, f } = orm;

const Book = defineModel('library.book', {
  recName: 'title',
  access: { 'library.user': ['read', 'write', 'create'] },
  fields: { title: f.char({ required: true }) },
});
const library = defineKoshModule({
  shutro: defineModule({
    name: 'library',
    version: '1.0.0',
    depends: [baseShutro],
    groups: [defineGroup({ code: 'library.user', label: 'Library', implies: ['base.user'] })],
    models: [Book],
  }),
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'User', groups: ['library.user'] } },
});

let postgres: StartedPostgreSqlContainer;
let server: KoshServer;
const users: Record<string, number> = {};
let company: number;
const books: number[] = [];
const tokens = new Map<string, string>();
const pusher = createMemoryPusher((endpoint) => (endpoint.endsWith('/gone') ? 410 : 201));
const mailer = createMemoryMailer();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(method: 'GET' | 'POST' | 'PUT', url: string, as: string, payload?: unknown) {
  let token = tokens.get(as);
  if (token === undefined) {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    token = (res.json() as { token: string }).token;
    tokens.set(as, token);
  }
  const res = await server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  server.driver.query<T>({ text, params });
const context = (used: Mailer = mailer) => ({
  shutro: server.shutro,
  driver: server.driver,
  registry: server.registry,
  auth: server.auth,
  pusher,
  mailer: used,
  baseUrl: 'https://erp.example.com',
});
async function mentions(who: string, ...previews: [number, string][]): Promise<void> {
  const inbox = inboxWorkers(context());
  for (const w of inbox) await w.drain();
  for (const [book, preview] of previews)
    await server.shutro.run({ user: users['rahim'] as number, company }, (env: Env) =>
      env.emit('mail.message.posted', {
        model: 'library.book',
        id: book,
        message: 1,
        kind: 'comment',
        author: users['rahim'],
        mentions: [users[who]],
        preview,
      }),
    );
  for (const w of inbox) await w.drain();
}
const settings = (as: string, values: Record<string, unknown>) =>
  call('PUT', '/api/v1/notifications/settings', as, {
    quietFrom: null,
    quietTo: null,
    quietDays: [],
    digestHour: '08:00',
    fallback: 'email',
    ...values,
  });

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  postgres = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: postgres.getConnectionUri(),
    modules: [library, notifyModule({ pusher, workers: false })],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  for (const statement of orm.eventTableStatements()) await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  company = (
    await installBase(server.shutro, auth, {
      company: { name: 'Padma Traders', currency: 'BDT' },
      admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
    })
  ).company;
  for (const [login, name] of [
    ['rahim', 'Rahim Uddin'],
    ['dina', 'Dina Rahman'],
    ['karim', 'Karim Ali'],
  ] as const)
    users[login] = await auth.createUser({
      login,
      name,
      password: PASSWORD,
      company,
      companies: [company],
      groups: ['library.user'],
    });
  await sql("UPDATE res_users SET email = login || '@example.com', tz = 'Asia/Dhaka'");
  await server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    const created = await (
      env.model('library.book' as never) as unknown as {
        create(r: unknown[]): Promise<{ ids: number[] }>;
      }
    ).create([{ title: 'Padma Nadir Majhi' }, { title: 'Lalsalu' }]);
    books.push(...created.ids);
  });
}, 180_000);

afterAll(async () => {
  await server?.close();
  await postgres?.stop();
});

test('daily emails wait for one digest at the user’s hour, by record; read ones left out; empty sends nothing', async () => {
  await settings('dina', { digestHour: '08:00', fallback: 'none' });
  await call('PUT', '/api/v1/notifications/preferences', 'dina', {
    kind: 'mention',
    channel: 'email',
    mode: 'daily',
  });
  const [a, b] = books as [number, number];
  await mentions('dina', [a, 'First look'], [b, 'Chapter two'], [a, 'And again']);
  const waiting = await sql<{ id: number; notification_id: number; state: string }>(
    "SELECT id, notification_id, state FROM notify_delivery WHERE channel = 'email' ORDER BY id",
  );
  expect(waiting.map((d) => d.state)).toEqual(['digest', 'digest', 'digest']);
  // One digest job for the day, at 08:00 in Dhaka (02:00 UTC).
  const jobs = await sql<{ key: string; run_at: Date }>(
    "SELECT key, run_at FROM shutro_job WHERE name = 'notify.digest' AND state = 'pending'",
  );
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.key).toMatch(
    new RegExp(`^notify\\.digest:${users['dina']}:\\d{4}-\\d{2}-\\d{2}$`),
  );
  expect(jobs[0]?.run_at.toISOString()).toMatch(/T02:00:00\.000Z$/);
  expect(jobs[0]?.run_at.getTime()).toBeGreaterThan(Date.now());

  // The second one was read in the inbox before the digest.
  await sql('UPDATE notify_notification SET read_at = now() WHERE id = $1', [
    waiting[1]?.notification_id,
  ]);
  const before = mailer.sent.length;
  const run = () =>
    server.shutro.bootstrap({ reason: 'test', company }, (env) =>
      sendDigest(context(), env, { user: users['dina'] }),
    );
  await run();
  const sent = mailer.sent.slice(before);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe('dina@example.com');
  expect(sent[0]?.subject).toBe('Your Shutro ERP summary: 2 notifications');
  expect(sent[0]?.text).toContain(
    `Padma Nadir Majhi (https://erp.example.com/open/library.book/${a})\n- Rahim Uddin mentioned you on Padma Nadir Majhi\n- Rahim Uddin mentioned you on Padma Nadir Majhi`,
  );
  expect(sent[0]?.text).not.toContain('Lalsalu');
  const after = await sql<{ state: string; error: string | null; provider_id: string | null }>(
    "SELECT state, error, provider_id FROM notify_delivery WHERE channel = 'email' ORDER BY id",
  );
  expect(after.map((d) => [d.state, d.error])).toEqual([
    ['sent', null],
    ['skipped', 'read'],
    ['sent', null],
  ]);
  expect(after[0]?.provider_id).toBe(after[2]?.provider_id);
  // Nothing waits any more: the next run sends nothing.
  await run();
  expect(mailer.sent.length).toBe(before + 1);
});

test('a push with nowhere to go falls back to email once; the email is sent', async () => {
  // Karim's only device is gone: the push is skipped, his fallback (email, the default) takes over.
  await server.shutro.run({ user: users['karim'] as number, company }, (env: Env) =>
    (
      env.model('notify.push_subscription' as never) as unknown as {
        create(r: unknown[]): Promise<unknown>;
      }
    ).create([
      {
        user: users['karim'],
        endpoint: 'https://push.example.com/karim/gone',
        p256dh: 'BKey',
        auth: 'secret',
      },
    ]),
  );
  // Email off for mentions: only push goes out at first.
  await call('PUT', '/api/v1/notifications/preferences', 'karim', {
    kind: 'mention',
    channel: 'email',
    mode: 'instant',
  });
  await sql("UPDATE res_users SET email = NULL WHERE login = 'karim'");
  await mentions('karim', [books[0] as number, 'Read this']);
  await sql("UPDATE res_users SET email = 'karim@example.com' WHERE login = 'karim'");
  const before = mailer.sent.length;
  const worker = deliveryWorker(context());
  await worker.drain();
  const rows = await sql<{
    id: number;
    channel: string;
    state: string;
    error: string | null;
    fallback_of_id: number | null;
  }>(
    `SELECT d.id, d.channel, d.state, d.error, d.fallback_of_id FROM notify_delivery d
     JOIN notify_notification n ON n.id = d.notification_id WHERE n.user_id = $1 ORDER BY d.id`,
    [users['karim']],
  );
  expect(rows.map((r) => [r.channel, r.state, r.error])).toEqual([
    ['webpush', 'skipped', 'no subscription left'],
    ['email', 'sent', null],
  ]);
  expect(rows[1]?.fallback_of_id).toBe(rows[0]?.id);
  expect(mailer.sent.slice(before).map((m) => m.to)).toEqual(['karim@example.com']);
});

test('a bounced email falls back to push through the mail event; a fallback never falls back again', async () => {
  await settings('dina', { fallback: 'webpush' });
  await call('PUT', '/api/v1/notifications/preferences', 'dina', {
    kind: 'mention',
    channel: 'email',
    mode: 'instant',
  });
  await server.shutro.run({ user: users['dina'] as number, company }, (env: Env) =>
    (
      env.model('notify.push_subscription' as never) as unknown as {
        create(r: unknown[]): Promise<unknown>;
      }
    ).create([
      {
        user: users['dina'],
        endpoint: 'https://push.example.com/dina',
        p256dh: 'BKey',
        auth: 'secret',
      },
    ]),
  );
  // Push off for mentions at first, so the email is the only delivery.
  await call('PUT', '/api/v1/notifications/preferences', 'dina', {
    kind: 'mention',
    channel: 'webpush',
    enabled: false,
  });
  await mentions('dina', [books[1] as number, 'Bounce me']);
  await call('PUT', '/api/v1/notifications/preferences', 'dina', {
    kind: 'mention',
    channel: 'webpush',
    enabled: true,
  });
  await deliveryWorker(context()).drain();
  const [email] = await sql<{ id: number; state: string }>(
    "SELECT id, state FROM notify_delivery WHERE channel = 'email' ORDER BY id DESC LIMIT 1",
  );
  expect(email?.state).toBe('sent');
  // The mail package records the bounce and emits the event; the fallback subscriber pushes instead.
  const fallback = fallbackWorker(context());
  await fallback.drain();
  await server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    await sql("UPDATE notify_delivery SET state = 'bounced' WHERE id = $1", [email?.id]);
    await env.emit(BOUNCED_TOPIC, { delivery: email?.id });
  });
  await fallback.drain();
  const pushes = pusher.sent.length;
  await deliveryWorker(context()).drain();
  expect(pusher.sent.slice(pushes).map((p) => p.payload.body)).toEqual(['Bounce me']);
  const [push] = await sql<{ id: number; state: string; fallback_of_id: number }>(
    "SELECT id, state, fallback_of_id FROM notify_delivery WHERE channel = 'webpush' ORDER BY id DESC LIMIT 1",
  );
  expect(push).toMatchObject({ state: 'sent', fallback_of_id: email?.id });
  // Had the push failed too, nothing would follow: one level only.
  await sql("UPDATE notify_delivery SET state = 'failed' WHERE id = $1", [push?.id]);
  const again = await server.shutro.bootstrap({ reason: 'test', company }, (env) =>
    env.asSuperuser({ reason: 'test' }, (su) =>
      queueFallback(context(), env, su, push?.id as number),
    ),
  );
  expect(again).toBeNull();
});

test('the last failed attempt falls back instead of retrying; earlier ones retry', async () => {
  await settings('rahim', { fallback: 'webpush' });
  await server.shutro.run({ user: users['rahim'] as number, company }, (env: Env) =>
    (
      env.model('notify.push_subscription' as never) as unknown as {
        create(r: unknown[]): Promise<unknown>;
      }
    ).create([
      {
        user: users['rahim'],
        endpoint: 'https://push.example.com/rahim',
        p256dh: 'BKey',
        auth: 'secret',
      },
    ]),
  );
  await call('PUT', '/api/v1/notifications/preferences', 'rahim', {
    kind: 'mention',
    channel: 'webpush',
    enabled: false,
  });
  // Dina mentions Rahim; his email provider is down.
  const inbox = inboxWorkers(context());
  for (const w of inbox) await w.drain();
  await server.shutro.run({ user: users['dina'] as number, company }, (env: Env) =>
    env.emit('mail.message.posted', {
      model: 'library.book',
      id: books[0],
      message: 9,
      kind: 'comment',
      author: users['dina'],
      mentions: [users['rahim']],
      preview: 'Provider down',
    }),
  );
  for (const w of inbox) await w.drain();
  await call('PUT', '/api/v1/notifications/preferences', 'rahim', {
    kind: 'mention',
    channel: 'webpush',
    enabled: true,
  });
  const [email] = await sql<{ id: number }>(
    `SELECT d.id FROM notify_delivery d JOIN notify_notification n ON n.id = d.notification_id
     WHERE n.user_id = $1 AND d.channel = 'email'`,
    [users['rahim']],
  );
  const down: Mailer = {
    name: 'down',
    from: 'x',
    send: async () => Promise.reject(new Error('SMTP down')),
  };
  const attempt = () =>
    server.shutro.bootstrap({ reason: 'test', company }, (env) =>
      deliver(context(down), env, { delivery: email?.id }),
    );
  for (let i = 1; i < MAX_ATTEMPTS; i++) await expect(attempt()).rejects.toThrow('SMTP down');
  await attempt(); // the last: no throw, the fallback is queued
  const rows = await sql<{
    channel: string;
    state: string;
    attempts: number;
    fallback_of_id: number | null;
  }>(
    `SELECT d.channel, d.state, d.attempts, d.fallback_of_id FROM notify_delivery d
     JOIN notify_notification n ON n.id = d.notification_id WHERE n.user_id = $1 ORDER BY d.id`,
    [users['rahim']],
  );
  expect(rows).toEqual([
    { channel: 'email', state: 'failed', attempts: MAX_ATTEMPTS, fallback_of_id: null },
    { channel: 'webpush', state: 'pending', attempts: 0, fallback_of_id: email?.id },
  ]);
});
