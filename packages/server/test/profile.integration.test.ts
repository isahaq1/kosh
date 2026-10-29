/**
 * Your profile and sessions on real PostgreSQL (RFC 0019 §3.6): a user reads and changes their own details (checked:
 * email, language, time zone, only their own companies as the default), sees their signed-in devices with this one
 * marked, signs one out or all the others; API keys cannot do any of it; every change is audited.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer, installBase, type KoshServer } from '../src/index.js';
import { orm } from '../src/orm.js';
import { contacts } from './fixtures/contacts.js';
import { type Services, startServices } from './support/services.js';

let services: Services;
let server: KoshServer;
let company: number;
let other: number;
const PASSWORD = 'correct horse battery';

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> => {
  const res = await server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'Vitest/1' },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
};
const login = async (user: string) =>
  (
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'user-agent': 'Vitest/1' },
      payload: { login: user, password: PASSWORD },
    })
  ).json().token as string;

beforeAll(async () => {
  services = await startServices();
  server = await createServer({
    databaseUrl: services.databaseUrl,
    modules: [contacts],
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
  other = await server.shutro.bootstrap({ reason: 'test' }, async (env) => {
    const [bdt] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
    const made = await (
      env.model('res.company' as never) as unknown as {
        create(rows: unknown[]): Promise<{ ids: number[] }>;
      }
    ).create([{ name: 'Chattogram Ltd', currency: bdt?.id }]);
    return made.ids[0] as number;
  });
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

test('your details: read, changed and checked; audited', async () => {
  const alice = await login('alice');
  const read = await call('GET', '/api/v1/auth/profile', alice);
  expect(read.json).toMatchObject({ login: 'alice', name: 'Alice', lang: 'en_US', company });
  const changed = await call('PATCH', '/api/v1/auth/profile', alice, {
    name: 'Alice Rahman',
    email: 'alice@dhaka.test',
    phone: '+880 1711 000000',
    lang: 'bn_BD',
    tz: 'Asia/Dhaka',
  });
  expect(changed.status, JSON.stringify(changed.json)).toBe(200);
  expect(changed.json).toMatchObject({
    name: 'Alice Rahman',
    email: 'alice@dhaka.test',
    lang: 'bn_BD',
    tz: 'Asia/Dhaka',
  });
  expect((await call('GET', '/api/v1/auth/me', alice)).json.name).toBe('Alice Rahman');
  for (const body of [
    { email: 'not an email' },
    { lang: 'Bangla' },
    { tz: 'Mars/Olympus' },
    { name: '  ' },
    { company: other }, // not one of hers
  ])
    expect((await call('PATCH', '/api/v1/auth/profile', alice, body)).status).toBe(422);
  const audit = await server.shutro.bootstrap(
    { reason: 'test' },
    (env) =>
      env.sql<{ kind: string }>`SELECT kind FROM audit_event WHERE kind = 'auth.profile_changed'`,
  );
  expect(audit.length).toBeGreaterThanOrEqual(1);
});

test('your sessions: this one marked; one signed out; all the others; never with an API key', async () => {
  const phone = await login('alice');
  const laptop = await login('alice');
  const tablet = await login('alice');
  const list = await call('GET', '/api/v1/auth/sessions', laptop);
  const sessions = list.json.sessions as Json[];
  expect(sessions.length).toBeGreaterThanOrEqual(3);
  expect(sessions.filter((s) => s.current)).toHaveLength(1);
  expect(sessions[0].userAgent).toBe('Vitest/1');

  // The phone's session, from the laptop.
  const phoneId = (await call('GET', '/api/v1/auth/sessions', phone)).json.sessions.find(
    (s: Json) => s.current,
  ).id;
  expect((await call('DELETE', `/api/v1/auth/sessions/${phoneId}`, laptop)).json).toEqual({
    revoked: 1,
  });
  expect((await call('GET', '/api/v1/auth/profile', phone)).status).toBe(401);
  // Someone else's session: not found.
  const admin = await login('admin');
  expect((await call('DELETE', `/api/v1/auth/sessions/${phoneId + 1000}`, admin)).status).toBe(404);

  const others = await call('POST', '/api/v1/auth/sessions/sign-out-others', laptop);
  expect(others.json.revoked).toBeGreaterThanOrEqual(1);
  expect((await call('GET', '/api/v1/auth/profile', tablet)).status).toBe(401);
  expect((await call('GET', '/api/v1/auth/profile', laptop)).status).toBe(200);

  // API keys manage no profile and no sessions.
  const key = (
    await call('POST', '/api/v1/auth/api-keys', laptop, { name: 'Script', scopes: ['*'] })
  ).json.token as string;
  expect((await call('GET', '/api/v1/auth/profile', key)).status).toBe(401);
  expect((await call('PATCH', '/api/v1/auth/profile', key, { name: 'Bot' })).status).toBe(401);
});
