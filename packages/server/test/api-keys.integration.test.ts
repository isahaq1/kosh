/**
 * API keys and service accounts on real PostgreSQL (RFC 0017 §5.1): a key acts as its user within its scopes — read
 * or write per app, `*` for everything the user may do —, on generated model routes and on a module's own routes;
 * it cannot manage credentials; it is listed without its secret, revoked at once, refused once expired; an unknown
 * `X-Api-Key` is refused. Administrators (with their second factor) create service accounts, which cannot sign in,
 * and keys for them; others cannot. Every key change is audited.
 */
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  base,
  baseShutro,
  createServer,
  installBase,
  type KoshServer,
  type ModuleContext,
  totp,
} from '../src/index.js';
import { orm } from '../src/orm.js';
import { contacts } from './fixtures/contacts.js';
import { type Services, startServices } from './support/services.js';

// A small app with a route of its own: keys need its scope.
const tools = defineKoshModule({
  shutro: orm.defineModule({ name: 'tools', version: '0.1.0', depends: [baseShutro], models: [] }),
  depends: [base],
  kosh: '^0.1.0',
  accessLevels: { user: { label: 'Tools', groups: ['base.user'] } },
  routes: (context: ModuleContext) => {
    context.app.get('/api/v1/tools/ping', async (request) =>
      request.env(async () => ({ pong: true })),
    );
  },
});

let services: Services;
let server: KoshServer;
let company: number;
const PASSWORD = 'correct horse battery';
const P = '/api/v1/models/res.partner';

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: Json }> => {
  const res = await server.app.inject({
    method,
    url,
    headers,
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
};
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const login = async (user: string) =>
  (await call('POST', '/api/v1/auth/login', {}, { login: user, password: PASSWORD })).json
    .token as string;
const newKey = async (session: string, body: Record<string, unknown>) =>
  call('POST', '/api/v1/auth/api-keys', bearer(session), body);

beforeAll(async () => {
  services = await startServices();
  server = await createServer({
    databaseUrl: services.databaseUrl,
    modules: [contacts, tools],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  ({ company } = await installBase(server.shutro, auth, {
    company: { name: 'Dhaka Ltd', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  await auth.createUser({
    login: 'alice',
    name: 'Alice',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['contacts.user'],
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await services?.stop();
});

test('a key acts within its scopes: read or write per app, on model routes and an app’s own routes', async () => {
  const alice = await login('alice');
  const read = await newKey(alice, { name: 'Read contacts', scopes: ['read:contacts'] });
  expect(read.status, JSON.stringify(read.json)).toBe(201);
  expect(read.json.token).toMatch(/^sk_[A-Za-z0-9]{20,}$/);
  expect(read.json).toMatchObject({
    name: 'Read contacts',
    scopes: ['read:contacts'],
    revoked: false,
  });
  expect(read.json.prefix).toBe(String(read.json.token).slice(0, 11));
  const key = read.json.token as string;

  expect((await call('GET', P, bearer(key))).status).toBe(200);
  const refused = await call('POST', P, bearer(key), { name: 'Padma Traders' });
  expect(refused.status).toBe(403);
  expect(refused.json.detail).toContain('write:contacts');
  expect((await call('GET', '/api/v1/tools/ping', bearer(key))).status).toBe(403); // another app
  expect((await call('GET', '/api/v1/tools/ping', { 'x-api-key': key })).status).toBe(403);

  const write = (await newKey(alice, { name: 'Sync', scopes: 'write:contacts read:tools' })).json;
  expect((await call('POST', P, bearer(write.token), { name: 'Padma Traders' })).status).toBe(201);
  expect((await call('GET', '/api/v1/tools/ping', bearer(write.token))).json).toEqual({
    pong: true,
  });
  const all = (await newKey(alice, { name: 'All', scopes: ['*'] })).json;
  expect((await call('GET', '/api/v1/tools/ping', bearer(all.token))).status).toBe(200);

  // Listed without secrets, with their last use.
  const listed = await call('GET', '/api/v1/auth/api-keys', bearer(alice));
  expect(listed.json.keys.map((k: Json) => k.name)).toEqual(['All', 'Sync', 'Read contacts']);
  expect(JSON.stringify(listed.json)).not.toContain(key);
  expect(listed.json.keys[2].lastUsedAt).not.toBeNull();
});

test('scopes are checked; a key cannot manage keys; unknown, revoked and expired keys are refused', async () => {
  const alice = await login('alice');
  expect((await newKey(alice, { name: 'x', scopes: ['write:nope'] })).status).toBe(400);
  expect((await newKey(alice, { name: 'x', scopes: ['delete:contacts'] })).status).toBe(400);
  expect((await newKey(alice, { name: 'x', scopes: ['*'], expiresInDays: 1000 })).status).toBe(400);
  const key = (await newKey(alice, { name: 'Short-lived', scopes: ['*'] })).json;
  expect((await newKey(key.token, { name: 'From a key', scopes: ['*'] })).status).toBe(401);

  const unknown = await call('GET', P, { 'x-api-key': 'sk_doesnotexist' });
  expect(unknown.status).toBe(401);
  expect(unknown.json.type).toContain('invalid-api-key');

  expect((await call('POST', `/api/v1/auth/api-keys/${key.id}/revoke`, bearer(alice))).status).toBe(
    204,
  );
  expect((await call('GET', P, bearer(key.token))).status).toBe(401);

  const old = (await newKey(alice, { name: 'Old', scopes: ['*'] })).json;
  await server.driver.query({
    text: `UPDATE auth_api_key SET expires_at = now() - interval '1 day' WHERE id = $1`,
    params: [old.id],
  });
  expect((await call('GET', P, { 'x-api-key': old.token })).status).toBe(401);

  const kinds = await server.driver.query<{ kind: string }>({
    text: `SELECT DISTINCT kind FROM audit_event WHERE kind LIKE 'auth.api_key%' ORDER BY 1`,
    params: [],
  });
  expect(kinds.map((k) => k.kind)).toEqual(['auth.api_key_created', 'auth.api_key_revoked']);
});

test('service accounts: made by administrators with their second factor, no sign-in, keys made for them', async () => {
  // The administrator enrols the second factor (administrator rights need it).
  const admin = await login('admin');
  const setup = await call('POST', '/api/v1/auth/2fa/setup', bearer(admin));
  const secret = setup.json.secret as string;
  expect(
    (await call('POST', '/api/v1/auth/2fa/enable', bearer(admin), { code: totp(secret) })).status,
  ).toBe(200);

  const alice = await login('alice');
  const body = { login: 'erp-bot', name: 'ERP bot', groups: ['contacts.user'] };
  expect((await call('POST', '/api/v1/auth/service-accounts', bearer(alice), body)).status).toBe(
    403,
  );
  expect(
    (
      await call('POST', '/api/v1/auth/service-accounts', bearer(admin), {
        ...body,
        groups: ['base.admin'],
      })
    ).status,
  ).toBe(422);
  const bot = await call('POST', '/api/v1/auth/service-accounts', bearer(admin), body);
  expect(bot.status, JSON.stringify(bot.json)).toBe(201);
  const botId = bot.json.id as number;

  // No password: it cannot sign in.
  expect(
    (await call('POST', '/api/v1/auth/login', {}, { login: 'erp-bot', password: PASSWORD })).status,
  ).toBe(401);
  // Keys for it: the administrator yes, Alice no.
  expect((await newKey(alice, { name: 'Bot', scopes: ['*'], user: botId })).status).toBe(403);
  const botKey = await newKey(admin, { name: 'Bot sync', scopes: ['write:contacts'], user: botId });
  expect(botKey.status, JSON.stringify(botKey.json)).toBe(201);
  expect(botKey.json.user).toBe(botId);
  const created = await call('POST', P, bearer(botKey.json.token), { name: 'Made by the bot' });
  expect(created.status).toBe(201);
  // The administrator sees the service account's key; Alice does not.
  const adminKeys = (await call('GET', '/api/v1/auth/api-keys', bearer(admin))).json.keys as Json[];
  expect(adminKeys.map((k) => k.name)).toContain('Bot sync');
  const aliceKeys = (await call('GET', '/api/v1/auth/api-keys', bearer(alice))).json.keys as Json[];
  expect(aliceKeys.map((k) => k.name)).not.toContain('Bot sync');
});
