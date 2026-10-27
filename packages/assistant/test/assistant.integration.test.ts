/**
 * The assistant's API on real PostgreSQL (RFC 0013 step 1), with a fake client: users without the access are
 * refused; it is off until an administrator switches it on; a sentence becomes checked filters that run as the user;
 * a field the user may not read is never described to the model; an invalid answer and a refusal are answers, not
 * errors; every call is logged without its content; the monthly budget stops it.
 */

import { messaging } from '@kosh/messaging';
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { base, baseShutro, createServer, installBase, type KoshServer, totp } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createAssistant, fakeClient } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const { defineGroup, defineModel, defineModule, f } = orm;

const Invoice = defineModel('shop.invoice', {
  label: 'Invoice',
  companyScoped: { required: true },
  access: { 'shop.user': ['read', 'write', 'create'] },
  fields: {
    name: f.char({ required: true }),
    amount: f.decimal({ scale: 2, default: '0' }),
    city: f.char(),
    state: f.selection({ draft: 'Draft', posted: 'Posted' }, { default: 'draft' }),
    /** Field security: managers only. */
    margin: f.decimal({ scale: 2, groups: ['shop.manager'] }),
  },
});
const shop = defineKoshModule({
  shutro: defineModule({
    name: 'shop',
    version: '1.0.0',
    depends: [baseShutro],
    groups: [
      defineGroup({ code: 'shop.user', label: 'Shop', implies: ['base.user'] }),
      defineGroup({ code: 'shop.manager', label: 'Shop manager', implies: ['shop.user'] }),
    ],
    models: [Invoice],
  }),
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'User', groups: ['shop.user'] } },
});

/** Answers by the sentence: "big ones in dhaka", "refuse", or anything else as an invalid answer. */
const client = fakeClient((request) => {
  if (!('schema' in request)) {
    // Summaries and drafts: text.
    if (request.user.includes('refuse please')) return 'refuse';
    return request.system.includes('summarize')
      ? 'The invoice waits for delivery. Open points: the date.'
      : 'Thank you, we will deliver on [date].';
  }
  if (request.user === 'refuse') return 'refuse';
  if (request.user === 'big ones in dhaka')
    return {
      clauses: [
        { field: 'amount', operator: 'gt', value: '1000', values: [] },
        { field: 'city', operator: 'ilike', value: 'Dhaka', values: [] },
      ],
      combine: 'and',
      unsupported: '',
    };
  return {
    clauses: [{ field: 'margin', operator: 'gt', value: '5', values: [] }],
    combine: 'and',
    unsupported: '',
  };
}, 'claude-test');

let container: StartedPostgreSqlContainer;
let server: KoshServer;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(method: 'GET' | 'POST' | 'PUT', url: string, as?: string, payload?: unknown) {
  const token = as === undefined ? undefined : await tokenOf(as);
  const res = await server.app.inject({
    method,
    url,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
async function tokenOf(login: string): Promise<string> {
  const cached = tokens.get(login);
  if (cached !== undefined) return cached;
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login, password: PASSWORD },
  });
  const token = (res.json() as { token: string }).token;
  if (login === 'admin') {
    // Administrator rights need a second factor: enrol it on this session.
    const headers = { authorization: `Bearer ${token}` };
    const setup = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/2fa/setup',
      headers,
      payload: {},
    });
    const { secret } = setup.json() as { secret: string };
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/2fa/enable',
      headers,
      payload: { code: totp(secret) },
    });
  }
  tokens.set(login, token);
  return token;
}
const search = (as: string, text: string) =>
  call('POST', '/api/v1/assistant/search', as, { model: 'shop.invoice', text });

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [shop, settings, messaging, createAssistant({ client, monthlyTokens: 1000 })],
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
  for (const [login, groups] of [
    ['ana', ['assistant.user', 'shop.user', 'messaging.user']],
    ['mgr', ['assistant.user', 'shop.manager', 'messaging.user']],
    ['bob', ['shop.user']],
    ['nomsg', ['assistant.user', 'shop.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  await server.shutro.bootstrap({ reason: 'test', company }, (env) =>
    (
      env.model('shop.invoice' as never) as unknown as { create(r: unknown[]): Promise<unknown> }
    ).create([
      { name: 'INV/1', amount: '5000', city: 'Dhaka', company },
      { name: 'INV/2', amount: '500', city: 'Dhaka', company },
      { name: 'INV/3', amount: '9000', city: 'Sylhet', company },
    ]),
  );
}, 180_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
});

test('only assistant users reach it; it is off until an administrator switches it on', async () => {
  expect((await call('GET', '/api/v1/assistant')).status).toBe(401);
  expect((await call('GET', '/api/v1/assistant', 'bob')).status).toBe(403);
  expect((await search('bob', 'big ones in dhaka')).status).toBe(403);
  const status = await call('GET', '/api/v1/assistant', 'ana');
  expect(status.json).toEqual({
    available: true,
    enabled: false,
    model: 'claude-test',
    usage: { tokens: 0, budget: 1000 },
  });
  const off = await search('ana', 'big ones in dhaka');
  expect(off.status).toBe(409);
  expect(off.json.title).toBe('The assistant is off');
  expect(client.requests).toHaveLength(0); // nothing left the server
  expect((await call('PUT', '/api/v1/assistant/config', 'ana', { enabled: true })).status).toBe(
    403,
  );
  expect((await call('PUT', '/api/v1/assistant/config', 'admin', { enabled: true })).json).toEqual({
    enabled: true,
  });
  expect((await call('GET', '/api/v1/assistant', 'ana')).json.enabled).toBe(true);
});

test('a sentence becomes checked filters; the user sees only what they may read', async () => {
  const found = await search('ana', 'big ones in dhaka');
  expect(found.status).toBe(200);
  expect(found.json).toEqual({
    where: { and: [{ amount: { gt: '1000' } }, { city: { ilike: '%Dhaka%' } }] },
    unsupported: '',
  });
  const rows = await call(
    'GET',
    `/api/v1/models/shop.invoice?fields=name&filter=${encodeURIComponent(JSON.stringify(found.json.where))}`,
    'ana',
  );
  expect(rows.json.items.map((r: Json) => r.name)).toEqual(['INV/1']);
  // Ana may not read the margin: it is not described; the manager's request describes it.
  const anas = client.requests.at(-1);
  expect(anas?.system).not.toContain('margin');
  expect(anas?.user).toBe('big ones in dhaka');
  await search('mgr', 'big ones in dhaka');
  expect(client.requests.at(-1)?.system).toContain('- margin:');
});

test('an answer naming a field not offered is refused (422); a refusal is an answer; calls are logged', async () => {
  const invalid = await search('ana', 'show margins');
  expect(invalid.status).toBe(422);
  expect(invalid.json.detail).toBe("clause 1: 'margin' is not a field offered");
  expect((await search('ana', 'refuse')).json).toEqual({ refused: true });
  expect((await call('GET', '/api/v1/assistant/calls', 'ana')).status).toBe(403);
  const calls = (await call('GET', '/api/v1/assistant/calls', 'admin')).json.calls as Json[];
  expect(calls.map((c) => [c.feature, c.llm, c.resModel, c.refused, c.error !== null])).toEqual([
    ['search', 'claude-test', 'shop.invoice', true, false],
    ['search', 'claude-test', 'shop.invoice', false, true],
    ['search', 'claude-test', 'shop.invoice', false, false],
    ['search', 'claude-test', 'shop.invoice', false, false],
  ]);
  expect(Object.keys(calls[0])).not.toContain('text'); // never the content
});

test('a summary streams from the record and its chatter as the user sees them; a draft reply too', async () => {
  const [invoice] = (
    await server.driver.query<{ id: string }>({
      text: "SELECT id::text FROM shop_invoice WHERE name = 'INV/1'",
      params: [],
    })
  ).map((r) => Number(r.id));
  const posted = await call('POST', `/api/v1/chatter/shop.invoice/${invoice}/messages`, 'mgr', {
    kind: 'comment',
    text: 'Please deliver by Friday.',
  });
  expect(posted.status).toBe(201);
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/v1/assistant/summary',
    headers: { authorization: `Bearer ${await tokenOf('ana')}` },
    payload: { model: 'shop.invoice', id: invoice },
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('text/event-stream');
  const pieces = [...res.body.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1] as string));
  expect(
    pieces
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text)
      .join(''),
  ).toBe('The invoice waits for delivery. Open points: the date.');
  expect(res.body).toContain('event: done\ndata: {"model":"claude-test","refused":false}');
  // What the model was told: the readable fields and the chatter, as Ana sees them; never the margin.
  const told = client.requests.at(-1);
  expect(told?.user).toContain('Invoice: INV/1');
  expect(told?.user).toContain('- Amount: 5000');
  expect(told?.user).toContain('(message): Please deliver by Friday.');
  expect(told?.user).not.toContain('Margin');
  expect(told?.system).toContain('Write in English');

  // A draft reply, with what the author wants; the assistant posts nothing.
  const reply = await server.app.inject({
    method: 'POST',
    url: '/api/v1/assistant/reply',
    headers: { authorization: `Bearer ${await tokenOf('ana')}` },
    payload: { model: 'shop.invoice', id: invoice, instruction: 'confirm Friday' },
  });
  expect(reply.statusCode).toBe(200);
  expect(reply.body).toContain('data: {"text":"Thank "}');
  expect(client.requests.at(-1)?.user).toContain('The author asks: confirm Friday');
  expect(client.requests.at(-1)?.system).toContain('for ana to edit and send');
  const messages = await server.driver.query<{ n: string }>({
    text: 'SELECT count(*)::text AS n FROM mail_message WHERE res_model = $1 AND res_id = $2',
    params: ['shop.invoice', invoice],
  });
  expect(messages[0]?.n).toBe('1');

  // A refusal is the end of the stream; no Messaging access: refused before anything is sent.
  const refused = await server.app.inject({
    method: 'POST',
    url: '/api/v1/assistant/reply',
    headers: { authorization: `Bearer ${await tokenOf('ana')}` },
    payload: { model: 'shop.invoice', id: invoice, instruction: 'refuse please' },
  });
  expect(refused.body).toContain('"refused":true');
  const before = client.requests.length;
  const noChatter = await call('POST', '/api/v1/assistant/summary', 'nomsg', {
    model: 'shop.invoice',
    id: invoice,
  });
  expect(noChatter.status).toBe(403);
  expect(client.requests.length).toBe(before);
  expect(
    (await call('POST', '/api/v1/assistant/summary', 'ana', { model: 'shop.invoice', id: 0 }))
      .status,
  ).toBe(400);
  const calls = (await call('GET', '/api/v1/assistant/calls', 'admin')).json.calls as Json[];
  expect(calls.slice(0, 3).map((c) => [c.feature, c.refused])).toEqual([
    ['reply', true],
    ['reply', false],
    ['summary', false],
  ]);
});

test('the monthly budget stops the assistant', async () => {
  let status = 200;
  for (let i = 0; i < 10 && status === 200; i++)
    status = (await search('ana', 'big ones in dhaka')).status;
  expect(status).toBe(429);
  expect((await call('GET', '/api/v1/assistant', 'ana')).json.usage.tokens).toBeGreaterThanOrEqual(
    1000,
  );
});
