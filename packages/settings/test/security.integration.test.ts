/**
 * Settings › Security on real PostgreSQL (RFC 0019 §3.5): the policy — two-factor sign-in for administrators only by
 * default; for everyone, people without it may only set it up (the sign-in routes) until they do; the session
 * lifetime of new sign-ins —, who has no two-factor sign-in; every active session with sign-out of any but one's own.
 * Administrators only; everything audited.
 */
import { base, createServer, installBase, type KoshServer, totp } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { settings } from '../src/index.js';

const PASSWORD = 'correct horse battery';
let container: StartedPostgreSqlContainer;
let server: KoshServer;
let bob = 0;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const inject = async (method: string, url: string, token: string, payload?: unknown) => {
  const res = await server.app.inject({
    method: method as 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
};
/** Turns two-factor sign-in on in this session. */
const enrol = async (token: string) => {
  const setup = await inject('POST', '/api/v1/auth/2fa/setup', token);
  expect(setup.status, JSON.stringify(setup.json)).toBe(200);
  const enabled = await inject('POST', '/api/v1/auth/2fa/enable', token, {
    code: totp(setup.json.secret),
  });
  expect(enabled.status, JSON.stringify(enabled.json)).toBe(200);
};
async function signIn(as: string): Promise<string> {
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: as, password: PASSWORD },
  });
  const token = (res.json() as { token: string }).token;
  // Administrators act as such only after a second factor.
  if (as === 'admin') await enrol(token);
  return token;
}
async function call(method: string, url: string, as: string, payload?: unknown) {
  let token = tokens.get(as);
  if (token === undefined) {
    token = await signIn(as);
    tokens.set(as, token);
  }
  return inject(method, url, token, payload);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [base, settings],
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
  bob = await auth.createUser({
    login: 'bob',
    name: 'Bob',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['base.user'],
  });
  await auth.createUser({
    login: 'dana',
    name: 'Dana',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['settings.company'],
  });
}, 180_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
});

test('the policy: administrators by default; everyone — set it up first, then work', async () => {
  const policy = await call('GET', '/api/v1/settings/security', 'admin');
  expect(policy.status, JSON.stringify(policy.json)).toBe(200);
  expect(policy.json).toMatchObject({ twoFactor: 'administrators', sessionDays: null });
  expect(policy.json.withoutTwoFactor.map((p: Json) => p.login)).toEqual(['bob', 'dana']);

  expect((await call('GET', '/api/v1/menus', 'bob')).status).toBe(200);
  const changed = await call('PATCH', '/api/v1/settings/security', 'admin', {
    twoFactor: 'everyone',
    sessionDays: 3,
  });
  expect(changed.status, JSON.stringify(changed.json)).toBe(200);
  expect(changed.json).toMatchObject({ twoFactor: 'everyone', sessionDays: 3 });

  // Bob may only set it up.
  const blocked = await call('GET', '/api/v1/menus', 'bob');
  expect(blocked.status).toBe(403);
  expect(blocked.json.type).toContain('two-factor-setup-required');
  expect((await call('GET', '/api/v1/auth/me', 'bob')).json.twoFactorSetupRequired).toBe(true);
  await enrol(tokens.get('bob') as string);
  expect((await call('GET', '/api/v1/menus', 'bob')).status).toBe(200);
  expect((await call('GET', '/api/v1/auth/me', 'bob')).json.twoFactorSetupRequired).toBe(false);
  // …and cannot turn it off while the policy stands.
  expect(
    (
      await call('POST', '/api/v1/auth/2fa/disable', 'bob', {
        password: PASSWORD,
        code: '000000',
      })
    ).status,
  ).toBe(409);
  expect(
    (await call('GET', '/api/v1/settings/security', 'admin')).json.withoutTwoFactor.map(
      (p: Json) => p.login,
    ),
  ).toEqual(['dana']);

  // New sign-ins last the policy's days.
  await signIn('bob');
  const [session] = await server.driver.query<{ days: number }>({
    text: `SELECT round(extract(epoch FROM (expires_at - created_at)) / 86400)::int AS days
             FROM auth_session WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    params: [bob],
  });
  expect(session?.days).toBe(3);

  for (const body of [{ twoFactor: 'nobody' }, { sessionDays: 0 }, { sessionDays: 91 }])
    expect((await call('PATCH', '/api/v1/settings/security', 'admin', body)).status).toBe(422);
  expect((await call('GET', '/api/v1/settings/security', 'dana')).status).toBe(403);
  expect(
    (await call('PATCH', '/api/v1/settings/security', 'dana', { twoFactor: 'administrators' }))
      .status,
  ).toBe(403);

  // Back to the default for the next test.
  expect(
    (
      await call('PATCH', '/api/v1/settings/security', 'admin', {
        twoFactor: 'administrators',
        sessionDays: null,
      })
    ).json,
  ).toMatchObject({ twoFactor: 'administrators', sessionDays: null });
  expect((await call('GET', '/api/v1/menus', 'dana')).status).toBe(200);
});

test('sessions: every active one, signed out by an administrator but not one’s own', async () => {
  const dana = await signIn('dana');
  const list = await call('GET', '/api/v1/settings/sessions', 'admin');
  expect(list.status, JSON.stringify(list.json)).toBe(200);
  const danas = list.json.sessions.filter((s: Json) => s.login === 'dana');
  expect(danas.length).toBeGreaterThan(0);
  expect(list.json.sessions.filter((s: Json) => s.current)).toHaveLength(1);
  expect(list.json.sessions.find((s: Json) => s.current).login).toBe('admin');

  expect((await inject('GET', '/api/v1/menus', dana)).status).toBe(200);
  for (const s of danas)
    expect((await call('DELETE', `/api/v1/settings/sessions/${s.id}`, 'admin')).status).toBe(200);
  expect((await inject('GET', '/api/v1/menus', dana)).status).toBe(401);

  const own = list.json.sessions.find((s: Json) => s.current).id;
  expect((await call('DELETE', `/api/v1/settings/sessions/${own}`, 'admin')).status).toBe(409);
  expect((await call('DELETE', '/api/v1/settings/sessions/999999', 'admin')).status).toBe(404);
  expect((await call('GET', '/api/v1/settings/sessions', 'bob')).status).toBe(403);

  const [event] = await server.driver.query<{ summary: string }>({
    text: `SELECT summary FROM audit_event WHERE kind = 'security.session_revoked' ORDER BY id DESC LIMIT 1`,
    params: [],
  });
  expect(event?.summary).toContain('dana');
  const [policy] = await server.driver.query<{ n: number }>({
    text: `SELECT count(*)::int AS n FROM audit_event WHERE kind = 'security.policy'`,
    params: [],
  });
  expect(policy?.n).toBe(2);
});
