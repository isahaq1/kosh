/**
 * The inbox on real PostgreSQL: outbox events become the recipients' notifications exactly once; a recipient who
 * may not read the record gets nothing; a switched-off preference is honoured; the API serves and marks only the
 * caller's own; approvers are resolved from their roles in the company.
 */

import { mailModule } from '@kosh/mail';
import { messaging } from '@kosh/messaging';
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { base, baseShutro, createServer, installBase, type KoshServer } from '@kosh/server';
import { type Env, orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { inboxWorkers, notify } from '../src/index.js';

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
    groups: [
      defineGroup({ code: 'library.user', label: 'Library', implies: ['base.user'] }),
      defineGroup({ code: 'library.manager', label: 'Library manager', implies: ['library.user'] }),
    ],
    models: [Book],
  }),
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'User', groups: ['library.user'] } },
});

let container: StartedPostgreSqlContainer;
let server: KoshServer;
let workers: ReturnType<typeof inboxWorkers>;
const users: Record<string, number> = {};
let company: number;
let book: number;
const tokens = new Map<string, string>();

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
  // biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
  return { status: res.statusCode, json: res.body === '' ? null : (res.json() as any) };
}

/** Emits an event as `login` and runs the subscribers (what the background workers do). */
async function emit(login: string, topic: string, payload: unknown): Promise<number> {
  await server.shutro.run(
    {
      user: users[login] as number,
      company,
      groups: login === 'bob' ? ['base.user'] : ['library.user'],
    },
    (env: Env) => env.emit(topic, payload),
  );
  let handled = 0;
  for (const w of workers) handled += await w.drain();
  return handled;
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off'; // the test drains the workers itself
  container = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [
      library,
      notify,
      messaging,
      mailModule({
        inbound: { secret: 's', domain: 'mail.test', alias: 'reply' },
        webhookSecret: 'hook',
      }),
    ],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const installed = await installBase(server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  company = installed.company;
  for (const [login, name, groups] of [
    ['rahim', 'Rahim Uddin', ['library.user', 'messaging.user']],
    ['dina', 'Dina Rahman', ['library.manager', 'messaging.user']],
    ['bob', 'Bob Smith', ['base.user']],
  ] as const)
    users[login] = await auth.createUser({
      login,
      name,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  book = await server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    const created = await (
      env.model('library.book' as never) as unknown as {
        create(r: unknown[]): Promise<{ ids: number[] }>;
      }
    ).create([{ title: 'Padma Nadir Majhi' }]);
    return created.ids[0] as number;
  });
  workers = inboxWorkers({
    shutro: server.shutro,
    driver: server.driver,
    registry: server.registry,
    auth: server.auth,
    baseUrl: 'http://localhost:5173',
  });
  // A subscription starts at the events emitted after it exists: register the cursors before the tests emit.
  for (const w of workers) await w.drain();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
});

test('a mention notifies the mentioned user, once, and not one who cannot read the record', async () => {
  const handled = await emit('rahim', 'mail.message.posted', {
    model: 'library.book',
    id: book,
    message: 1,
    kind: 'comment',
    author: users['rahim'],
    mentions: [users['dina'], users['bob'], users['rahim']],
    preview: 'Have a look at this one',
  });
  expect(handled).toBe(1);
  const dina = await call('GET', '/api/v1/notifications', 'dina');
  expect(dina.json.unread).toBe(1);
  expect(dina.json.items[0]).toMatchObject({
    kind: 'mention',
    model: 'library.book',
    resId: book,
    params: {
      actor: 'Rahim Uddin',
      record: 'Padma Nadir Majhi',
      preview: 'Have a look at this one',
    },
    readAt: null,
  });
  expect((await call('GET', '/api/v1/notifications/count', 'bob')).json).toEqual({ unread: 0 }); // no access
  expect((await call('GET', '/api/v1/notifications/count', 'rahim')).json).toEqual({ unread: 0 }); // the author
  // Draining again delivers nothing more: the event was consumed.
  let again = 0;
  for (const w of workers) again += await w.drain();
  expect(again).toBe(0);
});

test('approvals: the role holders in the company are told; the requester hears the decision', async () => {
  await emit('rahim', 'approval.requested', {
    model: 'library.book',
    id: book,
    roles: ['library.manager'],
  });
  const dina = await call('GET', '/api/v1/notifications?unread=true', 'dina');
  expect(dina.json.items.map((n: { kind: string }) => n.kind)).toEqual([
    'approval.requested',
    'mention',
  ]);
  expect((await call('GET', '/api/v1/notifications/count', 'rahim')).json).toEqual({ unread: 0 });
});

test('a switched-off preference is honoured', async () => {
  const put = await call('PUT', '/api/v1/notifications/preferences', 'dina', {
    kind: 'activity.assigned',
    channel: 'inapp',
    enabled: false,
  });
  expect(put.status).toBe(200);
  await emit('rahim', 'mail.activity.assigned', {
    model: 'library.book',
    id: book,
    activity: 1,
    assignee: users['dina'],
    deadline: '2026-11-01',
    by: users['rahim'],
  });
  expect((await call('GET', '/api/v1/notifications/count', 'dina')).json).toEqual({ unread: 2 });
  const prefs = await call('GET', '/api/v1/notifications/preferences', 'dina');
  expect(
    prefs.json.kinds.find((k: { kind: string }) => k.kind === 'activity.assigned').channels.inapp,
  ).toBe(false);
  expect(
    (await call('PUT', '/api/v1/notifications/preferences', 'dina', { kind: 'x' })).status,
  ).toBe(400);
});

test('marking read: one, then all; only the owner can', async () => {
  const dina = await call('GET', '/api/v1/notifications?unread=true', 'dina');
  const first = dina.json.items[0].id as number;
  expect((await call('POST', `/api/v1/notifications/${first}/read`, 'rahim')).status).toBe(404);
  expect((await call('POST', `/api/v1/notifications/${first}/read`, 'dina')).json).toEqual({
    unread: 1,
  });
  expect((await call('POST', '/api/v1/notifications/read-all', 'dina')).json).toEqual({ read: 1 });
  expect((await call('GET', '/api/v1/notifications/count', 'dina')).json).toEqual({ unread: 0 });
});

test('chat: the other side of a direct conversation is told, a mentioned member too, a non-member not', async () => {
  // A direct conversation of Rahim and Dina (as the chat routes make it), and Bob outside it.
  const channel = await server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    type Model = { create(r: unknown[]): Promise<{ ids: number[] }> };
    const model = (name: string) => env.model(name as never) as unknown as Model;
    const created = await model('mail.channel').create([
      { name: `${users['rahim']}:${users['dina']}`, kind: 'direct', pairKey: 'rahim:dina' },
    ]);
    const id = created.ids[0] as number;
    await model('mail.channel.member').create([
      { channel: id, user: users['rahim'] },
      { channel: id, user: users['dina'] },
    ]);
    return id;
  });
  const handled = await emit('rahim', 'chat.message.posted', {
    model: 'mail.channel',
    id: channel,
    message: 99,
    author: users['rahim'],
    mentions: [users['bob']],
    direct: [users['dina']],
    preview: 'Lunch?',
  });
  expect(handled).toBe(1);
  const dina = await call('GET', '/api/v1/notifications', 'dina');
  expect(dina.json.items[0]).toMatchObject({
    kind: 'chat.direct',
    model: 'mail.channel',
    resId: channel,
    params: { actor: 'Rahim Uddin', preview: 'Lunch?' },
  });
  expect((await call('GET', '/api/v1/notifications/count', 'bob')).json).toEqual({ unread: 0 }); // not a member
});

test('a reply by email to a notification we sent resolves by In-Reply-To and posts as the recipient', async () => {
  // Dina's email address, and a notification delivered to her with the Message-ID the mailer returned.
  await server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    type Model = {
      create(r: unknown[]): Promise<{ ids: number[] }>;
      browse(ids: number[]): { write(v: unknown): Promise<void> };
    };
    const model = (name: string) => env.model(name as never) as unknown as Model;
    await model('res.users')
      .browse([users['dina'] as number])
      .write({ email: 'dina@padma.test' });
    const n = await model('notify.notification').create([
      {
        user: users['dina'],
        kind: 'mention',
        params: {},
        resModel: 'library.book',
        resId: book,
        company,
      },
    ]);
    await model('notify.delivery').create([
      { notification: n.ids[0], channel: 'email', state: 'sent', providerId: '<sent-77@kosh>' },
    ]);
  });
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/v1/mail/inbound',
    headers: { 'content-type': 'message/rfc822', 'x-kosh-inbound-secret': 'hook' },
    payload: [
      'From: Dina Rahman <dina@padma.test>',
      'To: kosh@padma.test',
      'Subject: Re: mention',
      'Message-ID: <reply-77@padma.test>',
      'In-Reply-To: <sent-77@kosh>',
      '',
      'Noted, thanks.',
      '',
      'On Monday, Kosh wrote:',
      '> Rahim mentioned you',
    ].join('\r\n'),
  });
  expect(res.statusCode, res.body).toBe(202);
  expect(res.json()).toMatchObject({ state: 'posted', model: 'library.book', resId: book });
  const page = await call('GET', `/api/v1/chatter/library.book/${book}`, 'dina');
  expect(page.status).toBe(200);
  const [posted] = page.json.items.filter((i: { type: string }) => i.type === 'message');
  expect(posted).toMatchObject({ author: { name: 'Dina Rahman' }, body: '<p>Noted, thanks.</p>' });
});
