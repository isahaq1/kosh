/**
 * Outbound webhooks on real PostgreSQL with a real HTTP receiver (RFC 0017 §5.3): the events offered (models' changes
 * and modules' declared events), URL and events checked; a record created → a signed delivery whose record is what
 * the subscription's user may read; an update and a deletion; a failing endpoint recorded (and retried), then
 * replayed; a test ping; a subscription acting as a user who cannot read the model sends nothing; only integrations
 * managers manage webhooks.
 */
import { createHmac } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { base, baseShutro, createServer, installBase, type KoshServer } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { integrationsModule, webhookWorkers } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const { defineGroup, defineModel, defineModule, f } = orm;

const Lead = defineModel('crm.lead', {
  recName: 'name',
  companyScoped: { required: true },
  access: { 'crm.user': ['read', 'write', 'create', 'unlink'] },
  fields: { name: f.char({ required: true }), amount: f.decimal({ scale: 2, default: '0' }) },
});
const crm = defineKoshModule({
  shutro: defineModule({
    name: 'crm',
    version: '0.1.0',
    depends: [baseShutro],
    groups: [defineGroup({ code: 'crm.user', label: 'CRM', implies: ['base.user'] })],
    models: [Lead],
  }),
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'User', groups: ['crm.user'] } },
  events: [{ topic: 'crm.lead.won', model: 'crm.lead', label: 'Lead won' }],
});

let container: StartedPostgreSqlContainer;
let server: KoshServer;
let receiver: Server;
let hookUrl: string;
let company: number;
const users: Record<string, number> = {};
const tokens = new Map<string, string>();
const received: { headers: IncomingMessage['headers']; body: string }[] = [];
let answer = 200;

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  as: string,
  payload?: unknown,
) {
  let token = tokens.get(as);
  if (token === undefined) {
    const login = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    token = (login.json() as { token: string }).token;
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
const context = () => ({ shutro: server.shutro, registry: server.registry, auth: server.auth });
/** Runs the workers until nothing is left: events into deliveries, deliveries sent. */
async function drain(): Promise<void> {
  const workers = webhookWorkers(context());
  for (let round = 0; round < 3; round++) for (const w of workers) await w.drain();
}
async function deliveries(): Promise<Json[]> {
  return (
    await call(
      'GET',
      '/api/v1/models/webhook.delivery?fields=id,event,state,attempts,responseStatus,error,replayOf,payload&order=id+asc',
      'dina',
    )
  ).json.items;
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  receiver = createHttpServer((request, response) => {
    let body = '';
    request.on('data', (c: Buffer) => {
      body += c.toString();
    });
    request.on('end', () => {
      received.push({ headers: request.headers, body });
      response.statusCode = answer;
      response.end(answer === 200 ? 'thanks' : 'broken');
    });
  });
  await new Promise<void>((done) => receiver.listen(0, '127.0.0.1', done));
  hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  process.env['KOSH_WEBHOOK_HOSTS'] = '127.0.0.1';

  container = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [crm, integrationsModule({ workers: false })],
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
  for (const [login, groups] of [
    ['dina', ['integrations.manager', 'crm.user']],
    ['rahim', ['crm.user']],
    ['bob', ['base.user']],
  ] as const)
    users[login] = await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
}, 180_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
  await new Promise((done) => receiver?.close(done));
});

test('events offered; URL and events checked; only integrations managers', async () => {
  const events = (await call('GET', '/api/v1/webhooks/events', 'dina')).json.events as Json[];
  const names = events.map((e) => e.event);
  expect(names).toEqual(
    expect.arrayContaining([
      'crm.lead.created',
      'crm.lead.updated',
      'crm.lead.deleted',
      'crm.lead.won',
    ]),
  );
  const bad = await call('POST', '/api/v1/webhooks/subscriptions', 'dina', {
    url: 'https://evil.example/hook',
    events: ['crm.lead.created'],
  });
  expect(bad.status).toBe(422);
  expect(bad.json.detail).toContain('allow-list');
  expect(
    (
      await call('POST', '/api/v1/webhooks/subscriptions', 'dina', {
        url: hookUrl,
        events: ['crm.lead.eaten'],
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call('POST', '/api/v1/webhooks/subscriptions', 'rahim', {
        url: hookUrl,
        events: ['crm.lead.created'],
      })
    ).status,
  ).toBe(403);
  expect((await call('GET', '/api/v1/webhooks/events', 'bob')).status).toBe(403);
});

test('a record created, updated and deleted: signed deliveries with what the user may read', async () => {
  const sub = await call('POST', '/api/v1/webhooks/subscriptions', 'dina', {
    name: 'CRM sync',
    url: hookUrl,
    events: ['crm.lead.created', 'crm.lead.updated', 'crm.lead.deleted'],
  });
  expect(sub.status, JSON.stringify(sub.json)).toBe(201);
  const secret = sub.json.secret as string;
  expect(secret).toMatch(/^whsec_/);

  const lead = await call('POST', '/api/v1/models/crm.lead', 'rahim', {
    name: 'Bengal Steel',
    amount: '5000',
  });
  expect(lead.status).toBe(201);
  received.length = 0;
  await drain();
  expect(received).toHaveLength(1);
  const [first] = received;
  const body = JSON.parse(first?.body ?? '{}');
  expect(body).toMatchObject({
    event: 'crm.lead.created',
    data: {
      model: 'crm.lead',
      id: lead.json.id,
      record: { id: lead.json.id, name: 'Bengal Steel' },
    },
  });
  expect(first?.headers['x-shutro-event']).toBe('crm.lead.created');
  expect(first?.headers['x-shutro-delivery']).toBe(body.id);
  // The receiver's check: HMAC-SHA256 of "<t>.<body>" with the secret.
  const header = String(first?.headers['x-shutro-signature']);
  const t = /t=(\d+)/.exec(header)?.[1];
  const expected = createHmac('sha256', secret).update(`${t}.${first?.body}`).digest('hex');
  expect(header).toBe(`t=${t},v1=${expected}`);

  received.length = 0;
  await call('PATCH', `/api/v1/models/crm.lead/${lead.json.id}`, 'rahim', { amount: '7500' });
  await drain();
  await call('DELETE', `/api/v1/models/crm.lead/${lead.json.id}`, 'rahim');
  await drain();
  const events = received
    .map((r) => JSON.parse(r.body))
    .map((b) => [b.event, b.data.record?.amount ?? null]);
  expect(events).toEqual([
    ['crm.lead.updated', '7500'],
    ['crm.lead.deleted', null],
  ]);
  const log = await deliveries();
  expect(log.every((d) => d.state === 'done' && d.attempts === 1 && d.responseStatus === 200)).toBe(
    true,
  );
});

test('a failing endpoint is recorded and retried; a replay sends the same payload again; a ping', async () => {
  answer = 500;
  await call('POST', '/api/v1/models/crm.lead', 'rahim', { name: 'Jamuna Jute' });
  await drain();
  const failing = (await deliveries()).at(-1);
  expect(failing).toMatchObject({
    event: 'crm.lead.created',
    state: 'pending',
    attempts: 1,
    responseStatus: 500,
  });
  expect(failing.error).toContain('answered 500');

  answer = 200;
  received.length = 0;
  const replay = await call('POST', `/api/v1/webhooks/deliveries/${failing.id}/replay`, 'dina');
  expect(replay.status).toBe(202);
  await drain();
  const replayed = (await deliveries()).find((d) => d.id === replay.json.delivery);
  expect(replayed).toMatchObject({ state: 'done', replayOf: failing.id });
  expect(JSON.parse(received.at(-1)?.body ?? '{}').id).toBe(failing.payload.id); // the same event, for idempotency

  const subs = (await call('GET', '/api/v1/models/webhook.subscription?fields=id', 'dina')).json
    .items as Json[];
  const ping = await call('POST', `/api/v1/webhooks/subscriptions/${subs[0].id}/ping`, 'dina');
  expect(ping.status).toBe(202);
  received.length = 0;
  await drain();
  expect(JSON.parse(received[0]?.body ?? '{}').event).toBe('webhook.ping');
  const rotated = await call(
    'POST',
    `/api/v1/webhooks/subscriptions/${subs[0].id}/rotate-secret`,
    'dina',
  );
  expect(rotated.json.secret).toMatch(/^whsec_/);
});

test('acting as a user who cannot read the model, nothing is sent; declared module events too', async () => {
  // Bob may not read leads: his webhook gets nothing.
  const sub = await call('POST', '/api/v1/webhooks/subscriptions', 'dina', {
    name: 'As Bob',
    url: hookUrl,
    events: ['crm.lead.created', 'crm.lead.won'],
    runAs: users['bob'],
  });
  expect(sub.status).toBe(201);
  const before = (await deliveries()).length;
  await call('POST', '/api/v1/models/crm.lead', 'rahim', { name: 'Hidden from Bob' });
  await drain();
  const made = (await deliveries()).slice(before);
  expect(
    made.every((d) => d.event !== 'crm.lead.created' || d.payload?.data?.record !== undefined),
  ).toBe(true);
  const bobs = made.filter(
    (d) => d.payload?.data?.record === null && d.event === 'crm.lead.created',
  );
  expect(bobs).toHaveLength(0);

  // A module's declared event: emitted through the outbox, delivered to Dina's webhook acting as her.
  const dina = await call('POST', '/api/v1/webhooks/subscriptions', 'dina', {
    name: 'Won leads',
    url: hookUrl,
    events: ['crm.lead.won'],
  });
  expect(dina.status).toBe(201);
  const lead = await call('POST', '/api/v1/models/crm.lead', 'rahim', { name: 'Padma Cement' });
  await server.shutro.bootstrap({ reason: 'test: won', company }, (env) =>
    env.emit('crm.lead.won', { id: lead.json.id, by: 'test' }),
  );
  received.length = 0;
  await drain();
  const won = received.map((r) => JSON.parse(r.body)).filter((b) => b.event === 'crm.lead.won');
  expect(won).toHaveLength(1); // Dina's; Bob's sees nothing
  expect(won[0].data).toMatchObject({
    model: 'crm.lead',
    id: lead.json.id,
    by: 'test',
    record: { name: 'Padma Cement' },
  });
});
