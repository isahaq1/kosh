/**
 * The realtime gateway on real PostgreSQL and real sockets: a subscribed browser learns of a change committed
 * through the API; changes carry no data; a model the user cannot read is refused; presence tells the subscribers
 * of a record who has it open and forgets a closed connection; anonymous connections are closed.
 */
import { once } from 'node:events';
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { base, baseShutro, createServer, installBase, type KoshServer } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { realtime } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const { defineGroup, defineModel, defineModule, f } = orm;

const Book = defineModel('library.book', {
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
let url: string;
const tokens = new Map<string, string>();

async function tokenOf(login: string): Promise<string> {
  const cached = tokens.get(login);
  if (cached !== undefined) return cached;
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login, password: PASSWORD },
  });
  const token = (res.json() as { token: string }).token;
  tokens.set(login, token);
  return token;
}

/** A connected socket that queues what it receives. */
async function connect(login: string | null) {
  const headers = login === null ? {} : { authorization: `Bearer ${await tokenOf(login)}` };
  const socket = new WebSocket(`${url.replace('http', 'ws')}/api/v1/realtime`, { headers });
  const inbox: Record<string, unknown>[] = [];
  socket.on('message', (raw) => inbox.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  await once(socket, 'open');
  const next = async (type: string, timeoutMs = 5000) => {
    const started = Date.now();
    for (;;) {
      const i = inbox.findIndex((m) => m['type'] === type);
      if (i >= 0) return inbox.splice(i, 1)[0] as Record<string, unknown>;
      if (Date.now() - started > timeoutMs)
        throw new Error(`no ${type} message within ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  return { socket, inbox, next, send };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [library, realtime],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const { company } = await installBase(server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  for (const [login, name, groups] of [
    ['dina', 'Dina Rahman', ['library.user']],
    ['rahim', 'Rahim Uddin', ['library.user']],
    ['bob', 'Bob Smith', ['base.user']],
  ] as const)
    await auth.createUser({
      login,
      name,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  url = await server.app.listen({ port: 0, host: '127.0.0.1' });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
});

test('a change committed through the API reaches a subscribed browser, without the data', async () => {
  const dina = await connect('dina');
  dina.send({ type: 'subscribe', channels: ['model:library.book'] });
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/v1/models/library.book',
    headers: { authorization: `Bearer ${await tokenOf('rahim')}` },
    payload: { title: 'Padma Nadir Majhi' },
  });
  expect(created.statusCode).toBe(201);
  const id = (created.json() as { id: number }).id;
  const change = await dina.next('change');
  expect(change).toMatchObject({ model: 'library.book', ids: [id], op: 'create' });
  expect(JSON.stringify(change)).not.toContain('Padma Nadir'); // ids only, never the record
  dina.socket.close();
});

test('a model the user cannot read is refused; a bad message is answered, not fatal', async () => {
  const bob = await connect('bob');
  bob.send({ type: 'subscribe', channels: ['model:library.book'] });
  expect(await bob.next('error')).toMatchObject({
    channel: 'model:library.book',
    reason: 'not allowed',
  });
  bob.send('not json');
  expect(await bob.next('error')).toMatchObject({ reason: 'invalid message' });
  bob.send({ type: 'ping' });
  expect(await bob.next('pong')).toBeDefined();
  bob.socket.close();
});

test('presence: subscribers of a record see who has it open, and when they leave', async () => {
  const [book] = await server.driver.query<{ id: number }>({
    text: 'SELECT id FROM library_book ORDER BY id LIMIT 1',
    params: [],
  });
  const id = book?.id as number;
  const dina = await connect('dina');
  dina.send({ type: 'subscribe', channels: [`record:library.book:${id}`] });
  expect(await dina.next('presence')).toMatchObject({ users: [] });
  const rahim = await connect('rahim');
  rahim.send({ type: 'presence', model: 'library.book', id });
  expect(await dina.next('presence')).toMatchObject({
    model: 'library.book',
    id,
    users: [{ name: 'Rahim Uddin' }],
  });
  rahim.socket.close();
  expect(await dina.next('presence')).toMatchObject({ users: [] });
  dina.socket.close();
});

test('typing: relayed to the other subscribers of a record the sender is subscribed to, never stored', async () => {
  const [book] = await server.driver.query<{ id: number }>({
    text: 'SELECT id FROM library_book ORDER BY id LIMIT 1',
    params: [],
  });
  const id = book?.id as number;
  const dina = await connect('dina');
  const rahim = await connect('rahim');
  dina.send({ type: 'subscribe', channels: [`record:library.book:${id}`] });
  await dina.next('presence');
  rahim.send({ type: 'typing', model: 'library.book', id }); // not subscribed: dropped
  rahim.send({ type: 'subscribe', channels: [`record:library.book:${id}`] });
  await rahim.next('presence');
  rahim.send({ type: 'typing', model: 'library.book', id });
  expect(await dina.next('typing')).toMatchObject({
    model: 'library.book',
    id,
    name: 'Rahim Uddin',
  });
  await expect(rahim.next('typing', 300)).rejects.toThrow(); // not echoed to the sender
  dina.socket.close();
  rahim.socket.close();
});

test('anonymous connections are closed', async () => {
  const socket = new WebSocket(`${url.replace('http', 'ws')}/api/v1/realtime`);
  const [code] = (await once(socket, 'close')) as [number];
  expect([4401, 1006]).toContain(code); // refused by the gateway, or by the authentication hook before it
});
