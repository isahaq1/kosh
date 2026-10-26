/**
 * The SMS and WhatsApp channels on real PostgreSQL with a memory provider: both are opt-in, so a recipient gets
 * nothing until they switch a channel on; then a notification becomes one delivery per channel the provider
 * serves, sent with the sentence and the record's link to the user's phone; no phone number means no delivery; a
 * provider failure is recorded and retried.
 */
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { base, baseShutro, createServer, installBase, type KoshServer } from '@kosh/server';
import { type Env, orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  createMemoryMessenger,
  deliveryWorker,
  inboxWorkers,
  type Messenger,
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

let container: StartedPostgreSqlContainer;
let server: KoshServer;
const users: Record<string, number> = {};
let company: number;
let book: number;
const tokens = new Map<string, string>();

async function call(method: 'GET' | 'PUT', url: string, as: string, payload?: unknown) {
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

async function emitAndRun(messenger: Messenger, payload: unknown) {
  const context = {
    shutro: server.shutro,
    driver: server.driver,
    registry: server.registry,
    auth: server.auth,
    messenger,
    baseUrl: 'https://erp.example.com/',
  };
  const inbox = inboxWorkers(context);
  const delivery = deliveryWorker(context);
  for (const w of inbox) await w.drain(); // cursors
  await server.shutro.run({ user: users['rahim'] as number, company }, (env: Env) =>
    env.emit('mail.message.posted', payload),
  );
  for (const w of inbox) await w.drain();
  const sent = await delivery.drain();
  return { sent, delivery };
}

const mention = (who: number, preview: string) => ({
  model: 'library.book',
  id: book,
  message: 1,
  kind: 'comment',
  author: users['rahim'],
  mentions: [who],
  preview,
});
const deliveries = () =>
  server.driver.query<{
    channel: string;
    state: string;
    provider_id: string | null;
    error: string | null;
  }>({
    text: 'SELECT channel, state, provider_id, error FROM notify_delivery ORDER BY id',
    params: [],
  });

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [library, notifyModule({ workers: false })],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  for (const statement of orm.eventTableStatements()) await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  ({ company } = await installBase(server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  for (const [login, name] of [
    ['rahim', 'Rahim Uddin'],
    ['dina', 'Dina Rahman'],
    ['bob', 'Bob Smith'],
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
    type Model = {
      create(r: unknown[]): Promise<{ ids: number[] }>;
      browse(ids: number[]): { write(v: unknown): Promise<void> };
    };
    const model = (name: string) => env.model(name as never) as unknown as Model;
    await model('res.users')
      .browse([users['dina'] as number])
      .write({ phone: '+880 1711-000001' });
    const created = await model('library.book').create([{ title: 'Padma Nadir Majhi' }]);
    return created.ids[0] as number;
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
});

test('opt-in: nothing on SMS or WhatsApp until the user switches a channel on', async () => {
  const messenger = createMemoryMessenger();
  await emitAndRun(messenger, mention(users['dina'] as number, 'Look at this one'));
  expect(messenger.sent).toEqual([]);
  expect(await deliveries()).toEqual([]);
  const prefs = await call('GET', '/api/v1/notifications/preferences', 'dina');
  const mentionPrefs = prefs.json.kinds.find((k: { kind: string }) => k.kind === 'mention');
  expect(mentionPrefs.channels).toMatchObject({
    inapp: true,
    email: true,
    sms: false,
    whatsapp: false,
  });
});

test('switched on: one delivery per channel the provider serves, with the sentence and the link', async () => {
  for (const channel of ['sms', 'whatsapp'])
    expect(
      (
        await call('PUT', '/api/v1/notifications/preferences', 'dina', {
          kind: 'mention',
          channel,
          enabled: true,
        })
      ).status,
    ).toBe(200);
  const messenger = createMemoryMessenger(['sms']); // WhatsApp not set up on this provider
  const { sent } = await emitAndRun(messenger, mention(users['dina'] as number, 'Please review'));
  expect(sent).toBe(1);
  expect(messenger.sent).toEqual([
    {
      channel: 'sms',
      to: '+8801711000001',
      text: `Rahim Uddin mentioned you on Padma Nadir Majhi\nhttps://erp.example.com/open/library.book/${book}`,
    },
  ]);
  expect(await deliveries()).toEqual([
    { channel: 'sms', state: 'sent', provider_id: 'memory-1', error: null },
  ]);
  // Both channels served: two deliveries.
  const both = createMemoryMessenger();
  await emitAndRun(both, mention(users['dina'] as number, 'Again'));
  expect(both.sent.map((m) => m.channel)).toEqual(['sms', 'whatsapp']);
});

test('no phone number: no delivery, even with the channel on', async () => {
  expect(
    (
      await call('PUT', '/api/v1/notifications/preferences', 'bob', {
        kind: 'mention',
        channel: 'sms',
        enabled: true,
      })
    ).status,
  ).toBe(200);
  const messenger = createMemoryMessenger();
  await emitAndRun(messenger, mention(users['bob'] as number, 'Hello Bob'));
  expect(messenger.sent).toEqual([]);
});

test('a provider failure is recorded and left for a retry', async () => {
  const messenger = createMemoryMessenger(['sms'], () => 'Twilio answered 503: try later');
  await emitAndRun(messenger, mention(users['dina'] as number, 'Flaky'));
  const [last] = (await deliveries()).slice(-1);
  expect(last).toMatchObject({ channel: 'sms', state: 'failed' });
  expect(last?.error).toContain('503');
});
