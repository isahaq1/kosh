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

async function call(method: 'GET' | 'POST' | 'DELETE', url: string, as: string, payload?: unknown) {
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
