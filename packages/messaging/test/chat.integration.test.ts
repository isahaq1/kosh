/**
 * Internal chat (RFC 0006 part 6) on PostgreSQL: groups and public channels, membership as the fence (a channel
 * the caller is not in is a 404; posting needs membership; a public channel is read and joined by anyone of the
 * company), direct conversations made once per pair, read receipts and unread counts, threads and reactions,
 * deletion by authors and managers, the outbox event the notification pipeline reads.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Authenticator, createServer, type KoshServer } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { ChannelItem, ChatMessageItem } from '../src/index.js';
import { crm } from './fixtures/crm.js';

const USERS: Record<string, { user: number; groups: string[] }> = {
  // The identity's groups are the closure the real loader gives (RFC 0006 part 3 notes).
  manager: { user: 1, groups: ['crm.manager', 'messaging.manager', 'messaging.user'] },
  alice: { user: 2, groups: ['crm.user', 'messaging.user'] },
  bob: { user: 3, groups: ['crm.user', 'messaging.user'] },
  carol: { user: 4, groups: ['crm.user'] }, // no Messaging access level
};
const authenticate: Authenticator = async (request) => {
  const u = USERS[String(request.headers['x-test-user'])];
  return u === undefined
    ? null
    : { user: u.user, company: 1, companies: [1], groups: u.groups, lang: 'en_US', tz: 'UTC' };
};

let pg: StartedPostgreSqlContainer;
let server: KoshServer;
let files: string;
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const call = (method: Method, url: string, as: string, body?: unknown) =>
  server.app.inject({
    method,
    url,
    headers: { 'x-test-user': as },
    ...(body === undefined ? {} : { payload: body as object }),
  });
// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const ok = async (method: Method, url: string, as: string, body?: unknown): Promise<Json> => {
  const res = await call(method, url, as, body);
  expect([200, 201, 204], `${method} ${url}: ${res.statusCode} ${res.body}`).toContain(
    res.statusCode,
  );
  return res.body === '' ? null : res.json();
};
const channels = async (as: string): Promise<ChannelItem[]> =>
  (await ok('GET', '/api/v1/chat/channels', as)).channels;
const post = (as: string, channel: number, text: string, parent?: number) =>
  ok('POST', `/api/v1/chat/channels/${channel}/messages`, as, {
    text,
    parent,
  }) as Promise<ChatMessageItem>;
const events = (topic: string) =>
  server.driver.query<{ payload: Record<string, unknown>; uid: string }>({
    text: 'SELECT payload, uid FROM shutro_outbox WHERE topic = $1 ORDER BY id',
    params: [topic],
  });

let group: number;
let general: number;
let direct: number;

beforeAll(async () => {
  files = await mkdtemp(join(tmpdir(), 'kosh-chat-'));
  process.env['KOSH_STORAGE_DIR'] = files;
  pg = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: pg.getConnectionUri(),
    modules: [crm],
    authenticate,
    logger: { level: 'error' },
    rateLimit: { max: 0, timeWindow: '1 minute' },
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  // The outbox tables up front: created on first use otherwise, inside the first emitting transaction
  // (docs/shutro-requests.md #25).
  for (const statement of orm.eventTableStatements()) await server.driver.query(statement);
  for (const text of [
    "INSERT INTO res_users (login, name, company_id) VALUES ('manager', 'Mina Manager', NULL), ('alice', 'Alice Akter', NULL), ('bob', 'Bob Barua', NULL), ('carol', 'Carol Chowdhury', NULL)",
    "INSERT INTO res_currency (name, decimal_places) VALUES ('BDT', 2)",
    "INSERT INTO res_company (name, currency_id) VALUES ('Dhaka Ltd', 1)",
    'UPDATE res_users SET company_id = 1',
  ])
    await server.driver.query({ text, params: [] });
}, 240_000);

afterAll(async () => {
  await server?.close();
  await pg?.stop();
  delete process.env['KOSH_STORAGE_DIR'];
  await rm(files, { recursive: true, force: true });
});

test('a private group: its members see it, others do not; posting needs membership', async () => {
  const created: ChannelItem = await ok('POST', '/api/v1/chat/channels', 'alice', {
    name: 'Bridge works',
    members: [USERS['bob']?.user],
  });
  group = created.id;
  expect(created).toMatchObject({ kind: 'group', member: true, memberCount: 2, canManage: true });
  expect((await call('GET', `/api/v1/chat/channels/${group}`, 'manager')).statusCode).toBe(404);
  expect((await call('GET', '/api/v1/chat/channels', 'carol')).statusCode).toBe(403);
  expect((await channels('bob')).map((c) => c.name)).toEqual(['Bridge works']);
  expect((await channels('bob'))[0]).toMatchObject({ member: true, canManage: false, unread: 0 });

  const message = await post('bob', group, 'Survey booked for **Monday** @[Alice](user:2)');
  expect(message).toMatchObject({ channel: group, parent: null, replyCount: 0, deleted: false });
  expect(message.body).toContain('<strong>Monday</strong>');
  expect(message.mentions.map((m) => m.name)).toEqual(['Alice Akter']);
  // Unread for Alice (the author has read their own); the receipt clears it.
  expect((await channels('alice'))[0]?.unread).toBe(1);
  expect((await channels('bob'))[0]?.unread).toBe(0);
  expect(await ok('POST', `/api/v1/chat/channels/${group}/read`, 'alice')).toEqual({ unread: 0 });
  // The event the notification pipeline reads: the mention of a member, no direct recipients.
  const [event] = await events('chat.message.posted');
  expect(event?.payload).toMatchObject({
    model: 'mail.channel',
    id: group,
    message: message.id,
    author: USERS['bob']?.user,
    mentions: [USERS['alice']?.user],
    direct: [],
    preview: 'Survey booked for Monday @Alice Akter',
  });
  // Changing the group: its creator may, another member may not.
  expect(
    (await call('PATCH', `/api/v1/chat/channels/${group}`, 'bob', { name: 'x' })).statusCode,
  ).toBe(403);
  const renamed: ChannelItem = await ok('PATCH', `/api/v1/chat/channels/${group}`, 'alice', {
    name: 'Bridge works (site)',
    add: [USERS['manager']?.user],
  });
  expect(renamed).toMatchObject({ name: 'Bridge works (site)', memberCount: 3 });
  expect((await call('GET', `/api/v1/chat/channels/${group}`, 'manager')).statusCode).toBe(200);
  await ok('POST', `/api/v1/chat/channels/${group}/leave`, 'manager');
  expect((await call('GET', `/api/v1/chat/channels/${group}`, 'manager')).statusCode).toBe(404);
});

test('a public channel: made by a messaging manager, readable by all, posting after joining', async () => {
  expect(
    (await call('POST', '/api/v1/chat/channels', 'alice', { kind: 'channel', name: 'general' }))
      .statusCode,
  ).toBe(403);
  const created: ChannelItem = await ok('POST', '/api/v1/chat/channels', 'manager', {
    kind: 'channel',
    name: 'general',
    public: true,
    description: 'Everyone',
  });
  general = created.id;
  await post('manager', general, 'Welcome!');
  const seen = (await channels('alice')).find((c) => c.id === general);
  expect(seen).toMatchObject({ public: true, member: false, unread: 0, canManage: false });
  // Readable without joining, not postable.
  expect(
    (await ok('GET', `/api/v1/chat/channels/${general}/messages`, 'alice')).items,
  ).toHaveLength(1);
  expect(
    (await call('POST', `/api/v1/chat/channels/${general}/messages`, 'alice', { text: 'hi' }))
      .statusCode,
  ).toBe(403);
  const joined: ChannelItem = await ok('POST', `/api/v1/chat/channels/${general}/join`, 'alice');
  expect(joined).toMatchObject({ member: true, memberCount: 2, unread: 1 });
  // A mention of someone who is not a member is kept out of the event (they will not see the channel).
  const message = await post('alice', general, 'Hello @[Bob](user:3) and @[Mina](user:1)');
  const [, event] = (await events('chat.message.posted')).slice(-2);
  expect(event?.payload).toMatchObject({ message: message.id, mentions: [USERS['manager']?.user] });
  // Groups are not joined, they are added to.
  expect((await call('POST', `/api/v1/chat/channels/${group}/join`, 'carol')).statusCode).toBe(403);
});

test('a direct conversation exists once per pair and is named after the other side', async () => {
  const first: ChannelItem = await ok(
    'POST',
    `/api/v1/chat/channels/direct/${USERS['bob']?.user}`,
    'alice',
  );
  const again: ChannelItem = await ok(
    'POST',
    `/api/v1/chat/channels/direct/${USERS['alice']?.user}`,
    'bob',
  );
  expect(again.id).toBe(first.id);
  direct = first.id;
  expect(first).toMatchObject({ kind: 'direct', name: 'Bob Barua', direct: { name: 'Bob Barua' } });
  expect(again).toMatchObject({ name: 'Alice Akter' });
  expect(
    (await call('POST', `/api/v1/chat/channels/direct/${USERS['alice']?.user}`, 'alice'))
      .statusCode,
  ).toBe(400);
  expect((await call('POST', `/api/v1/chat/channels/direct/999`, 'alice')).statusCode).toBe(404);
  expect((await call('POST', `/api/v1/chat/channels/${direct}/leave`, 'alice')).statusCode).toBe(
    400,
  );
  const message = await post('alice', direct, 'Lunch?');
  const [event] = (await events('chat.message.posted')).slice(-1);
  expect(event?.payload).toMatchObject({ message: message.id, direct: [USERS['bob']?.user] });
  // Muted: no longer a direct recipient.
  await ok('PATCH', `/api/v1/chat/channels/${direct}`, 'bob', { muted: true, pinned: true });
  await post('alice', direct, 'Still there?');
  const [muted] = (await events('chat.message.posted')).slice(-1);
  expect(muted?.payload).toMatchObject({ direct: [] });
  expect((await channels('bob')).find((c) => c.id === direct)).toMatchObject({
    muted: true,
    pinned: true,
    unread: 2,
  });
});

test('threads and reactions', async () => {
  const top = await post('bob', group, 'Who brings the drone?');
  const reply = await post('alice', group, 'I do', top.id);
  expect(reply.parent).toBe(top.id);
  const page = await ok('GET', `/api/v1/chat/channels/${group}/messages`, 'alice');
  expect(page.items.map((m: Json) => m.id)).not.toContain(reply.id); // top level only
  expect(page.items.find((m: Json) => m.id === top.id)).toMatchObject({ replyCount: 1 });
  const thread = await ok('GET', `/api/v1/chat/channels/${group}/messages?thread=${top.id}`, 'bob');
  expect(thread.items.map((m: Json) => m.id)).toEqual([reply.id]);
  expect(
    (
      await call('POST', `/api/v1/chat/channels/${group}/messages`, 'bob', {
        text: 'x',
        parent: reply.id,
      })
    ).statusCode,
  ).toBe(400);

  const reacted = await ok('POST', `/api/v1/chat/messages/${top.id}/reactions`, 'alice', {
    emoji: '👍',
  });
  expect(reacted.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
  await ok('POST', `/api/v1/chat/messages/${top.id}/reactions`, 'bob', { emoji: '👍' });
  const seen = await ok('GET', `/api/v1/chat/channels/${group}/messages`, 'bob');
  expect(seen.items.find((m: Json) => m.id === top.id).reactions).toEqual([
    { emoji: '👍', count: 2, mine: true },
  ]);
  const removed = await ok(
    'DELETE',
    `/api/v1/chat/messages/${top.id}/reactions/${encodeURIComponent('👍')}`,
    'bob',
  );
  expect(removed.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
  expect(
    (await call('POST', `/api/v1/chat/messages/${top.id}/reactions`, 'alice', { emoji: '<b>' }))
      .statusCode,
  ).toBe(400);
  expect(
    (await call('POST', `/api/v1/chat/messages/${top.id}/reactions`, 'manager', { emoji: '👍' }))
      .statusCode,
  ).toBe(404); // not a member any more: the group is invisible
});

test('pagination, editing and removal: authors delete their own, managers remove any', async () => {
  await ok('POST', `/api/v1/chat/channels/${general}/join`, 'bob');
  for (let i = 0; i < 3; i++) await post('bob', general, `line ${i}`);
  const first = await ok('GET', `/api/v1/chat/channels/${general}/messages?limit=2`, 'alice');
  expect(first.items).toHaveLength(2);
  expect(first.next).toBe(first.items[1].id);
  const second = await ok(
    'GET',
    `/api/v1/chat/channels/${general}/messages?limit=2&before=${first.next}`,
    'alice',
  );
  expect(second.items[0].id).toBeLessThan(first.next);

  const own = await post('alice', general, 'typo');
  expect(
    (await call('PATCH', `/api/v1/chat/messages/${own.id}`, 'bob', { text: 'x' })).statusCode,
  ).toBe(403);
  const edited = await ok('PATCH', `/api/v1/chat/messages/${own.id}`, 'alice', { text: 'fixed' });
  expect(edited).toMatchObject({ body: '<p>fixed</p>' });
  expect(edited.editedAt).not.toBeNull();
  expect((await call('DELETE', `/api/v1/chat/messages/${own.id}`, 'bob')).statusCode).toBe(403);
  await ok('DELETE', `/api/v1/chat/messages/${own.id}`, 'alice');
  const bobs = await post('bob', general, 'rude');
  await ok('DELETE', `/api/v1/chat/messages/${bobs.id}`, 'manager'); // the channel's creator and a manager
  const page = await ok('GET', `/api/v1/chat/channels/${general}/messages`, 'alice');
  expect(page.items.find((m: Json) => m.id === own.id)).toBeUndefined();
  expect(page.items.find((m: Json) => m.id === bobs.id)).toMatchObject({
    deleted: true,
    body: '',
    text: null,
  });
});
