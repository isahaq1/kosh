/**
 * Inbound webhooks on real PostgreSQL (RFC 0017 §5.4): a module declares an endpoint with an HMAC check; a manager
 * switches it on (the path and secret come back); a signed call is stored and handled once by the module (a record
 * made in the endpoint's company); the same event id again is answered 200 and not handled twice; a bad signature
 * is refused (401) and logged; an unknown token is 404; a failing handler is recorded and retried, then handled
 * from the log (replay); only integrations managers manage endpoints.
 */
import { createHmac } from 'node:crypto';
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { base, baseShutro, createServer, installBase, type KoshServer } from '@kosh/server';
import { type Env, orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { hmacVerifier, integrationsModule, webhookWorkers } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const { defineGroup, defineModel, defineModule, f } = orm;

let failing = false;
const Order = defineModel('shop.order', {
  recName: 'ref',
  companyScoped: { required: true },
  access: { 'shop.user': ['read'] },
  fields: { ref: f.char({ required: true }), total: f.decimal({ scale: 2, default: '0' }) },
});
const shop = defineKoshModule({
  shutro: defineModule({
    name: 'shop',
    version: '0.1.0',
    depends: [baseShutro],
    groups: [defineGroup({ code: 'shop.user', label: 'Shop', implies: ['base.user'] })],
    models: [Order],
  }),
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'User', groups: ['shop.user'] } },
  inboundWebhooks: [
    {
      key: 'orders',
      label: 'Orders from the web shop',
      verify: hmacVerifier({
        header: 'X-Shop-Signature',
        prefix: 'sha256=',
        eventId: (call) => (call.json as { id?: string } | null)?.id,
      }),
      handle: async (env, call) => {
        if (failing) throw new Error('The shop’s order could not be read.');
        const order = call.json as { ref: string; total?: string };
        const made = await (env as Env)
          .model('shop.order' as never)
          .create([{ ref: order.ref, total: order.total ?? '0' } as never]);
        return `shop.order ${made.ids[0]}`;
      },
    },
  ],
});

let container: StartedPostgreSqlContainer;
let server: KoshServer;
let company: number;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(method: 'GET' | 'POST', url: string, as: string, payload?: unknown) {
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
/** What the shop sends: the JSON body, signed with the endpoint's secret. */
async function deliver(path: string, secret: string, event: Record<string, unknown>, sign = true) {
  const body = JSON.stringify(event);
  const signature = createHmac('sha256', sign ? secret : 'wrong')
    .update(body)
    .digest('hex');
  const res = await server.app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json', 'x-shop-signature': `sha256=${signature}` },
    payload: body,
  });
  return { status: res.statusCode, json: res.json() as Json };
}
async function drain(): Promise<void> {
  const workers = webhookWorkers({
    shutro: server.shutro,
    registry: server.registry,
    auth: server.auth,
  });
  for (let round = 0; round < 2; round++) for (const w of workers) await w.drain();
}
async function calls(): Promise<Json[]> {
  return (
    await call(
      'GET',
      '/api/v1/models/webhook.inbound?fields=id,eventId,state,verified,attempts,result,error&order=id+asc',
      'dina',
    )
  ).json.items;
}
async function orders(): Promise<Json[]> {
  return server.shutro.bootstrap({ reason: 'test: orders', company }, async (env) => {
    const set = await env.model('shop.order' as never).search({ where: {} } as never);
    return (await set.load(['ref', 'company'] as never)).read(['ref', 'company'] as never);
  });
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [shop, integrationsModule({ workers: false })],
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
    ['dina', ['integrations.manager']],
    ['bob', ['shop.user']],
  ] as const)
    await auth.createUser({
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
});

let path = '';
let secret = '';

test('the endpoints offered; only managers switch one on; unknown endpoints refused', async () => {
  const hooks = await call('GET', '/api/v1/webhooks/hooks', 'dina');
  expect(hooks.json.hooks).toEqual([
    { hook: 'shop.orders', module: 'shop', label: 'Orders from the web shop' },
  ]);
  expect((await call('GET', '/api/v1/webhooks/hooks', 'bob')).status).toBe(403);
  expect(
    (await call('POST', '/api/v1/webhooks/endpoints', 'bob', { hook: 'shop.orders' })).status,
  ).toBe(403);
  expect(
    (await call('POST', '/api/v1/webhooks/endpoints', 'dina', { hook: 'shop.refunds' })).status,
  ).toBe(422);
  const made = await call('POST', '/api/v1/webhooks/endpoints', 'dina', { hook: 'shop.orders' });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  expect(made.json).toMatchObject({ name: 'Orders from the web shop', hook: 'shop.orders' });
  expect(made.json.path).toBe(`/api/v1/hooks/${made.json.token}`);
  path = made.json.path;
  secret = made.json.secret;
  expect((await deliver('/api/v1/hooks/nope', secret, { id: 'evt_0' })).status).toBe(404);
});

test('a signed call is handled once; a repeat is ignored; a bad signature is refused and logged', async () => {
  const first = await deliver(path, secret, { id: 'evt_1', ref: 'WEB-1001', total: '1500' });
  expect(first.status).toBe(202);
  expect(first.json).toEqual({ received: true, eventId: 'evt_1' });
  const again = await deliver(path, secret, { id: 'evt_1', ref: 'WEB-1001', total: '1500' });
  expect(again).toEqual({ status: 200, json: { duplicate: true, eventId: 'evt_1' } });
  const forged = await deliver(path, secret, { id: 'evt_2', ref: 'EVIL', total: '1' }, false);
  expect(forged.status).toBe(401);
  await drain();

  expect((await orders()).map((o) => [o['ref'], o['company']])).toEqual([['WEB-1001', company]]);
  const log = await calls();
  expect(log).toHaveLength(2);
  expect(log[0]).toMatchObject({ eventId: 'evt_1', state: 'done', verified: true, attempts: 1 });
  expect(log[0].result).toMatch(/^shop\.order \d+$/);
  expect(log[1]).toMatchObject({ eventId: null, state: 'refused', verified: false });
  // A refused call is not handled from the log.
  expect((await call('POST', `/api/v1/webhooks/inbound/${log[1].id}/replay`, 'dina')).status).toBe(
    409,
  );
});

test('a failing handler is recorded and retried; handled from the log once fixed', async () => {
  failing = true;
  expect((await deliver(path, secret, { id: 'evt_3', ref: 'WEB-1002', total: '900' })).status).toBe(
    202,
  );
  await drain();
  const failed = (await calls()).find((c) => c.eventId === 'evt_3');
  expect(failed).toMatchObject({ state: 'received', attempts: 1 });
  expect(failed.error).toContain('could not be read');

  failing = false;
  expect((await call('POST', `/api/v1/webhooks/inbound/${failed.id}/replay`, 'bob')).status).toBe(
    403,
  );
  const replay = await call('POST', `/api/v1/webhooks/inbound/${failed.id}/replay`, 'dina');
  expect(replay.status).toBe(202);
  await drain();
  expect((await calls()).find((c) => c.id === failed.id)).toMatchObject({
    state: 'done',
    error: null,
    attempts: 2,
  });
  expect((await orders()).map((o) => o['ref'])).toEqual(['WEB-1001', 'WEB-1002']);

  // A new secret: calls signed with the old one are refused.
  const endpoints = (await call('GET', '/api/v1/models/webhook.endpoint?fields=id', 'dina')).json
    .items as Json[];
  const rotated = await call(
    'POST',
    `/api/v1/webhooks/endpoints/${endpoints[0].id}/rotate-secret`,
    'dina',
  );
  expect(rotated.status).toBe(200);
  expect((await deliver(path, secret, { id: 'evt_4', ref: 'WEB-1003' })).status).toBe(401);
  expect(
    (await deliver(path, rotated.json.secret, { id: 'evt_4', ref: 'WEB-1003', total: '1' })).status,
  ).toBe(202);
});
