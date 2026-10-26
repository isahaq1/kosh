/**
 * The web push channel on real PostgreSQL: a device subscribes through the API (its own user only), a notification
 * wanted on push becomes one delivery sent to every subscription of the recipient with the sentence and the
 * record's link, a subscription the push service reports gone is deleted, and VAPID keys are generated once.
 */
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { base, baseShutro, createServer, installBase, type KoshServer } from '@kosh/server';
import { type Env, orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  createMemoryPusher,
  deliver,
  deliveryWorker,
  generateVapidKeys,
  inboxWorkers,
  notifyModule,
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
let book: number;
const tokens = new Map<string, string>();
const pusher = createMemoryPusher((endpoint) => (endpoint.endsWith('/gone') ? 410 : 201));

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  as: string,
  payload?: unknown,
) {
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
  // biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
  return { status: res.statusCode, json: res.body === '' ? null : (res.json() as any) };
}

const subscription = (tail: string) => ({
  endpoint: `https://push.example.com/${tail}`,
  keys: { p256dh: 'BPublicKey', auth: 'authSecret' },
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
  ] as const)
    users[login] = await auth.createUser({
      login,
      name,
      password: PASSWORD,
      company,
      companies: [company],
      groups: ['library.user'],
    });
  book = await server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    const created = await (
      env.model('library.book' as never) as unknown as {
        create(r: unknown[]): Promise<{ ids: number[] }>;
      }
    ).create([{ title: 'Padma Nadir Majhi' }]);
    return created.ids[0] as number;
  });
}, 180_000);

afterAll(async () => {
  await server?.close();
  await postgres?.stop();
});

test('VAPID keys are generated, and the public one is served', async () => {
  const keys = generateVapidKeys();
  expect(keys.publicKey.length).toBeGreaterThan(40);
  expect(keys.privateKey).not.toBe(keys.publicKey);
  const key = await call('GET', '/api/v1/notifications/push/key', 'dina');
  expect(key.json).toEqual({ publicKey: 'memory' });
});

test('a device subscribes and unsubscribes its own user only', async () => {
  expect(
    (await call('POST', '/api/v1/notifications/push', 'dina', subscription('phone'))).status,
  ).toBe(200);
  expect(
    (await call('POST', '/api/v1/notifications/push', 'dina', subscription('gone'))).status,
  ).toBe(200);
  expect((await call('POST', '/api/v1/notifications/push', 'dina', { endpoint: 'x' })).status).toBe(
    400,
  );
  // Rahim cannot remove Dina's subscription.
  expect(
    (
      await call('DELETE', '/api/v1/notifications/push', 'rahim', {
        endpoint: subscription('phone').endpoint,
      })
    ).json,
  ).toEqual({ removed: false });
  const rows = await server.driver.query<{ user_id: number }>({
    text: 'SELECT user_id FROM notify_push_subscription ORDER BY id',
    params: [],
  });
  expect(rows.map((r) => r.user_id)).toEqual([users['dina'], users['dina']]);
});

test('a mention is pushed to every subscription; a gone one is deleted', async () => {
  const context = {
    shutro: server.shutro,
    driver: server.driver,
    registry: server.registry,
    auth: server.auth,
    pusher,
    baseUrl: 'https://erp.example.com',
  };
  const inbox = inboxWorkers(context);
  const delivery = deliveryWorker(context);
  for (const w of inbox) await w.drain();
  await server.shutro.run({ user: users['rahim'] as number, company }, (env: Env) =>
    env.emit('mail.message.posted', {
      model: 'library.book',
      id: book,
      message: 1,
      kind: 'comment',
      author: users['rahim'],
      mentions: [users['dina']],
      preview: 'Have a look',
    }),
  );
  for (const w of inbox) await w.drain();
  expect(await delivery.drain()).toBe(1);
  expect(pusher.sent.map((s) => s.subscription.endpoint).sort()).toEqual([
    'https://push.example.com/gone',
    'https://push.example.com/phone',
  ]);
  expect(pusher.sent[0]?.payload).toMatchObject({
    title: 'Rahim Uddin mentioned you on Padma Nadir Majhi',
    body: 'Have a look',
    url: `/open/library.book/${book}`,
  });
  const deliveries = await server.driver.query<{ channel: string; state: string }>({
    text: 'SELECT channel, state FROM notify_delivery ORDER BY id',
    params: [],
  });
  expect(deliveries).toEqual([{ channel: 'webpush', state: 'sent' }]); // no email: no SMTP here
  const left = await server.driver.query<{ endpoint: string }>({
    text: 'SELECT endpoint FROM notify_push_subscription',
    params: [],
  });
  expect(left.map((r) => r.endpoint)).toEqual(['https://push.example.com/phone']); // 410 → deleted
});

test('settings: the defaults, validation, and every user reads and writes only their own', async () => {
  expect((await call('GET', '/api/v1/notifications/settings', 'dina')).json).toEqual({
    quietFrom: null,
    quietTo: null,
    quietDays: [],
    digestHour: '08:00',
    fallback: 'email',
    timezone: 'UTC',
  });
  const bad = await call('PUT', '/api/v1/notifications/settings', 'dina', {
    quietFrom: '25:00',
    quietTo: null,
    quietDays: ['someday'],
    digestHour: '8',
    fallback: 'inapp',
  });
  expect(bad.status).toBe(400);
  expect(bad.json.detail).toBe(
    'quietFrom and quietTo: HH:MM or null; quietFrom and quietTo: both or neither; quietDays: a list of sun, mon, tue, wed, thu, fri, sat; digestHour: HH:MM; fallback: one of email, webpush, sms, whatsapp, none',
  );
  const settings = {
    quietFrom: '22:00',
    quietTo: '07:00',
    quietDays: ['fri', 'sat', 'fri'],
    digestHour: '09:30',
    fallback: 'webpush',
  };
  expect((await call('PUT', '/api/v1/notifications/settings', 'rahim', settings)).status).toBe(200);
  expect((await call('GET', '/api/v1/notifications/settings', 'rahim')).json).toMatchObject({
    ...settings,
    quietDays: ['fri', 'sat'],
  });
  expect((await call('GET', '/api/v1/notifications/settings', 'dina')).json.quietFrom).toBeNull();
  // Email per kind: instant, daily or off; other channels stay on / off.
  expect(
    (
      await call('PUT', '/api/v1/notifications/preferences', 'dina', {
        kind: 'mention',
        channel: 'email',
        mode: 'daily',
      })
    ).json,
  ).toEqual({ kind: 'mention', channel: 'email', enabled: true, mode: 'daily' });
  expect(
    (
      await call('PUT', '/api/v1/notifications/preferences', 'dina', {
        kind: 'mention',
        channel: 'webpush',
        mode: 'daily',
      })
    ).status,
  ).toBe(400);
  const prefs = (await call('GET', '/api/v1/notifications/preferences', 'dina')).json.kinds;
  expect(prefs.find((k: { kind: string }) => k.kind === 'mention').emailMode).toBe('daily');
  expect(prefs.find((k: { kind: string }) => k.kind === 'automation').emailMode).toBe('instant');
  // Switching email off, then on, resets the mode.
  await call('PUT', '/api/v1/notifications/preferences', 'dina', {
    kind: 'mention',
    channel: 'email',
    enabled: true,
  });
  const after = (await call('GET', '/api/v1/notifications/preferences', 'dina')).json.kinds;
  expect(after.find((k: { kind: string }) => k.kind === 'mention').emailMode).toBe('instant');
});

test('quiet hours hold push until they end; read meanwhile, or access lost: skipped; else sent', async () => {
  const context = {
    shutro: server.shutro,
    driver: server.driver,
    registry: server.registry,
    auth: server.auth,
    pusher,
    baseUrl: 'https://erp.example.com',
  };
  const inbox = inboxWorkers(context);
  const delivery = deliveryWorker(context);
  for (const w of inbox) await w.drain();
  await delivery.drain();
  // Dina's quiet hours: from an hour ago to an hour from now, in her time zone (Dhaka).
  await server.driver.query({
    text: "UPDATE res_users SET tz = 'Asia/Dhaka' WHERE id = $1",
    params: [users['dina']],
  });
  const local = (offset: number) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(Date.now() + offset * 3_600_000));
  await call('PUT', '/api/v1/notifications/settings', 'dina', {
    quietFrom: local(-1),
    quietTo: local(1),
    quietDays: [],
    digestHour: '08:00',
    fallback: 'email',
  });
  const mention = (preview: string) =>
    server.shutro.run({ user: users['rahim'] as number, company }, (env: Env) =>
      env.emit('mail.message.posted', {
        model: 'library.book',
        id: book,
        message: 2,
        kind: 'comment',
        author: users['rahim'],
        mentions: [users['dina']],
        preview,
      }),
    );
  const before = pusher.sent.length;
  await mention('First');
  await mention('Second');
  await mention('Third');
  for (const w of inbox) await w.drain();
  // Held, not sent: the jobs run at the end of the quiet hours.
  expect(await delivery.drain()).toBe(0);
  expect(pusher.sent.length).toBe(before);
  const held = await server.driver.query<{
    id: number;
    state: string;
    not_before: Date;
    notification: number;
  }>({
    text: "SELECT id, state, not_before, notification_id AS notification FROM notify_delivery WHERE state = 'held' ORDER BY id",
    params: [],
  });
  expect(held).toHaveLength(3);
  const ends = held[0]?.not_before.getTime() ?? 0;
  expect(Math.abs(ends - Date.now() - 3_600_000)).toBeLessThan(2 * 60_000);

  // The quiet hours end (the jobs run): the first was read in the inbox meanwhile, the second is sent.
  await server.driver.query({
    text: 'UPDATE notify_notification SET read_at = now() WHERE id = $1',
    params: [held[0]?.notification],
  });
  const release = (id: number | undefined, mayRead?: () => Promise<boolean>) =>
    server.shutro.bootstrap({ reason: 'test', company }, (env) =>
      deliver({ ...context, ...(mayRead === undefined ? {} : { mayRead }) }, env, { delivery: id }),
    );
  await release(held[0]?.id);
  await release(held[1]?.id);
  // The third: Dina lost access to the book meanwhile.
  await release(held[2]?.id, async () => false);
  const states = await server.driver.query<{ state: string; error: string | null }>({
    text: `SELECT state, error FROM notify_delivery WHERE id IN (${held.map((h) => h.id).join(',')}) ORDER BY id`,
    params: [],
  });
  expect(states).toEqual([
    { state: 'skipped', error: 'read' },
    { state: 'sent', error: null },
    { state: 'skipped', error: 'no access' },
  ]);
  expect(pusher.sent.slice(before).map((p) => p.payload.body)).toEqual(['Second']);
});
