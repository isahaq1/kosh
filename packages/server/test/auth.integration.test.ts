/**
 * Kosh-native authentication on real PostgreSQL: password sign-in, Bearer and cookie sessions with CSRF, TOTP
 * two-factor authentication with recovery codes, logout, password change, archived users, per-company groups via
 * Shutro's identity loader, the sign-in rate limit, and private models kept out of the generated API.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, installBase, type KoshServer, totp } from '../src/index.js';
import { orm } from '../src/orm.js';
import { contacts } from './fixtures/contacts.js';
import { type Services, startServices } from './support/services.js';

let services: Services;
let server: KoshServer;
let company: number;
let branch: number;
const PASSWORD = 'correct horse battery';
const P = '/api/v1/models/res.partner';

type Call = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  token?: string;
  cookie?: string;
  csrf?: string;
  body?: unknown;
  headers?: Record<string, string>;
};
const call = (c: Call) =>
  server.app.inject({
    method: c.method ?? 'GET',
    url: c.url,
    headers: {
      ...(c.token === undefined ? {} : { authorization: `Bearer ${c.token}` }),
      ...(c.cookie === undefined ? {} : { cookie: `kosh_session=${c.cookie}` }),
      ...(c.csrf === undefined ? {} : { 'x-csrf-token': c.csrf }),
      ...c.headers,
    },
    ...(c.body === undefined ? {} : { payload: c.body as Record<string, unknown> }),
  });

const login = async (user: string, password = PASSWORD) => {
  const res = await call({
    method: 'POST',
    url: '/api/v1/auth/login',
    body: { login: user, password },
  });
  return {
    res,
    body: res.json() as { token: string; csrfToken: string; twoFactorRequired: boolean },
  };
};

const auth = () => {
  if (server.auth === undefined) throw new Error('base is installed');
  return server.auth;
};

beforeAll(async () => {
  services = await startServices();
  server = await createServer({
    databaseUrl: services.databaseUrl,
    modules: [contacts],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 5 },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  ({ company } = await installBase(server.shutro, auth(), {
    company: { name: 'Dhaka Ltd', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  branch = await server.shutro.bootstrap({ reason: 'test: second company' }, async (env) => {
    const companies = env.model('res.company' as never) as unknown as {
      create(rows: unknown[]): Promise<{ ids: number[] }>;
    };
    return (await companies.create([{ name: 'Chittagong Branch', currency: 1 }])).ids[0] as number;
  });
  for (const [login, groups] of [
    ['alice', ['contacts.user']],
    ['erin', ['contacts.user']],
    ['frank', ['contacts.user']],
    ['gina', ['contacts.user']],
    ['hank', ['contacts.user']],
  ] as const)
    await auth().createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  // Contacts manager only in the branch; a plain internal user in the head office.
  await auth().createUser({
    login: 'carlos',
    name: 'Carlos',
    password: PASSWORD,
    company,
    companies: [company, branch],
    groups: ['base.user', { group: 'contacts.manager', company: branch }],
  });
}, 240_000);

afterAll(async () => {
  await server?.close();
  await services?.stop();
});

describe('sign-in', () => {
  test('a wrong password and an unknown login get the same answer', async () => {
    const wrong = await login('alice', 'not the password');
    const unknown = await login('nobody');
    for (const res of [wrong.res, unknown.res]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ type: 'https://kosh.dev/problems/invalid-credentials' });
    }
  });

  test('passwords are stored as scrypt hashes, sessions as digests', async () => {
    const { body } = await login('alice');
    const rows = await server.driver.query({
      text: 'SELECT c.password_hash, s.token_hash FROM auth_credential c JOIN auth_session s ON s.user_id = c.user_id JOIN res_users u ON u.id = c.user_id WHERE u.login = $1',
      params: ['alice'],
    });
    const row = rows[0] as unknown as { password_hash: string; token_hash: string };
    expect(row.password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(JSON.stringify(rows)).not.toContain(body.token);
  });

  test('Bearer: me, then the generated API as that user', async () => {
    const { res, body } = await login('alice');
    expect(res.statusCode).toBe(200);
    expect(body.twoFactorRequired).toBe(false);
    expect(String(res.headers['set-cookie'])).toMatch(
      /^kosh_session=[\w-]+; Path=\/; HttpOnly; SameSite=Lax/,
    );
    const me = await call({ url: '/api/v1/auth/me', token: body.token });
    expect(me.json()).toMatchObject({
      login: 'alice',
      company,
      companies: [company],
      twoFactorEnabled: false,
    });
    const created = await call({
      method: 'POST',
      url: P,
      token: body.token,
      body: { name: 'Acme' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Acme' });
    const rows = await server.driver.query({
      text: 'SELECT u.login FROM res_partner p JOIN res_users u ON u.id = p.created_by_id WHERE p.id = $1',
      params: [created.json().id],
    });
    expect(rows).toEqual([{ login: 'alice' }]);
  });

  test('no session: 401 on the API, auth routes and OpenAPI', async () => {
    for (const url of [P, '/api/v1/auth/me', '/api/v1/openapi.json'])
      expect((await call({ url })).statusCode).toBe(401);
    expect((await call({ url: P, token: 'forged' })).statusCode).toBe(401);
  });

  test('cookie sessions need the CSRF token on unsafe methods', async () => {
    const { body } = await login('alice');
    expect((await call({ url: P, cookie: body.token })).statusCode).toBe(200);
    const without = await call({
      method: 'POST',
      url: P,
      cookie: body.token,
      body: { name: 'Beta' },
    });
    expect(without.statusCode).toBe(403);
    expect(without.json()).toMatchObject({ type: 'https://kosh.dev/problems/csrf' });
    const wrong = await call({
      method: 'POST',
      url: P,
      cookie: body.token,
      csrf: 'guess',
      body: { name: 'Beta' },
    });
    expect(wrong.statusCode).toBe(403);
    const ok = await call({
      method: 'POST',
      url: P,
      cookie: body.token,
      csrf: body.csrfToken,
      body: { name: 'Beta' },
    });
    expect(ok.statusCode).toBe(201);
  });

  test('logout revokes the session', async () => {
    const { body } = await login('alice');
    expect(
      (await call({ method: 'POST', url: '/api/v1/auth/logout', token: body.token })).statusCode,
    ).toBe(200);
    expect((await call({ url: P, token: body.token })).statusCode).toBe(401);
  });

  test('sign-in attempts are limited per IP and login', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await login('hank', 'wrong password')).res.statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await login('hank')).res.statusCode).toBe(429); // even with the right password
    expect((await login('admin')).res.statusCode).toBe(200); // other logins are not affected
  });
});

describe('two-factor authentication', () => {
  test('enrol, then sign-in needs a code; recovery codes work once', async () => {
    const first = await login('erin');
    const setup = await call({
      method: 'POST',
      url: '/api/v1/auth/2fa/setup',
      token: first.body.token,
    });
    const { secret, otpauthUri } = setup.json() as { secret: string; otpauthUri: string };
    expect(otpauthUri).toContain(`secret=${secret}`);
    const bad = await call({
      method: 'POST',
      url: '/api/v1/auth/2fa/enable',
      token: first.body.token,
      body: { code: '000000' },
    });
    expect(bad.statusCode).toBe(422);
    const enabled = await call({
      method: 'POST',
      url: '/api/v1/auth/2fa/enable',
      token: first.body.token,
      body: { code: totp(secret) },
    });
    const { recoveryCodes } = enabled.json() as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);

    // A new sign-in is pending until the second factor.
    const pending = await login('erin');
    expect(pending.body.twoFactorRequired).toBe(true);
    const blocked = await call({ url: P, token: pending.body.token });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json()).toMatchObject({ type: 'https://kosh.dev/problems/two-factor-required' });
    expect((await call({ url: '/api/v1/auth/me', token: pending.body.token })).statusCode).toBe(
      401,
    );
    const wrong = await call({
      method: 'POST',
      url: '/api/v1/auth/2fa/verify',
      token: pending.body.token,
      body: { code: '123456' },
    });
    expect(wrong.statusCode).toBe(422);
    const verified = await call({
      method: 'POST',
      url: '/api/v1/auth/2fa/verify',
      token: pending.body.token,
      body: { code: totp(secret) },
    });
    expect(verified.statusCode).toBe(200);
    expect((await call({ url: P, token: pending.body.token })).statusCode).toBe(200);

    // A recovery code instead of the app, once.
    const code = recoveryCodes[0] as string;
    const second = await login('erin');
    expect(
      (
        await call({
          method: 'POST',
          url: '/api/v1/auth/2fa/verify',
          token: second.body.token,
          body: { code },
        })
      ).statusCode,
    ).toBe(200);
    const third = await login('erin');
    expect(
      (
        await call({
          method: 'POST',
          url: '/api/v1/auth/2fa/verify',
          token: third.body.token,
          body: { code },
        })
      ).statusCode,
    ).toBe(422);

    // Turning it off needs the password and a current code.
    const off = await call({
      method: 'POST',
      url: '/api/v1/auth/2fa/disable',
      token: pending.body.token,
      body: { password: PASSWORD, code: totp(secret) },
    });
    expect(off.statusCode).toBe(200);
    expect((await login('erin')).body.twoFactorRequired).toBe(false);
  });
});

describe('accounts', () => {
  test('changing the password revokes the other sessions', async () => {
    const a = await login('frank');
    const b = await login('frank');
    const weak = await call({
      method: 'POST',
      url: '/api/v1/auth/password',
      token: a.body.token,
      body: { current: PASSWORD, next: 'short' },
    });
    expect(weak.statusCode).toBe(422);
    const changed = await call({
      method: 'POST',
      url: '/api/v1/auth/password',
      token: a.body.token,
      body: { current: PASSWORD, next: 'an even longer passphrase' },
    });
    expect(changed.statusCode).toBe(200);
    expect((await call({ url: P, token: a.body.token })).statusCode).toBe(200);
    expect((await call({ url: P, token: b.body.token })).statusCode).toBe(401);
    expect((await login('frank')).res.statusCode).toBe(401);
    expect((await login('frank', 'an even longer passphrase')).res.statusCode).toBe(200);
  });

  test('archived users lose their sessions and cannot sign in', async () => {
    const { body } = await login('gina');
    expect((await call({ url: P, token: body.token })).statusCode).toBe(200);
    await server.shutro.bootstrap({ reason: 'test: archive gina' }, async (env) => {
      const users = env.model('res.users' as never) as unknown as {
        search(q: unknown): Promise<{ write(v: unknown): Promise<void> }>;
      };
      await (await users.search({ where: { login: 'gina' } })).write({ active: false });
    });
    expect((await call({ url: P, token: body.token })).statusCode).toBe(401);
    expect((await login('gina')).res.statusCode).toBe(401);
  });

  test('groups are per company (Shutro identity loader)', async () => {
    const { body } = await login('carlos');
    // Head office: a plain internal user, no contacts access.
    expect((await call({ url: P, token: body.token })).statusCode).toBe(403);
    // Branch: contacts manager.
    const inBranch = await call({
      url: P,
      token: body.token,
      headers: { 'x-company': String(branch) },
    });
    expect(inBranch.statusCode).toBe(200);
    // A company outside the user's set is refused by Shutro, not silently replaced.
    const outside = await call({ url: P, token: body.token, headers: { 'x-company': '999' } });
    expect(outside.statusCode).toBe(403);
  });

  test('the first administrator has administrator rights only after a second factor', async () => {
    const { body } = await login('admin');
    const me = await call({ url: '/api/v1/auth/me', token: body.token });
    expect(me.json()).toMatchObject({ administrator: true, administratorNeedsSecondFactor: true });
    expect((await call({ url: '/api/v1/meta/res.partner', token: body.token })).statusCode).toBe(
      403,
    );

    // Enrolling 2FA in this session is its second factor: administrator rights now apply.
    const setup = await call({ method: 'POST', url: '/api/v1/auth/2fa/setup', token: body.token });
    const { secret } = setup.json() as { secret: string };
    await call({
      method: 'POST',
      url: '/api/v1/auth/2fa/enable',
      token: body.token,
      body: { code: totp(secret) },
    });
    expect((await call({ url: '/api/v1/auth/me', token: body.token })).json()).toMatchObject({
      administratorNeedsSecondFactor: false,
    });
    const meta = await call({ url: '/api/v1/meta/res.partner', token: body.token });
    expect(meta.json()).toMatchObject({ operations: { read: true, unlink: true, export: true } });

    // The last administrator cannot turn 2FA off, nor be archived.
    const off = await call({
      method: 'POST',
      url: '/api/v1/auth/2fa/disable',
      token: body.token,
      body: { password: PASSWORD, code: totp(secret) },
    });
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ type: 'https://kosh.dev/problems/last-administrator' });
    const me2 = (await call({ url: '/api/v1/auth/me', token: body.token })).json() as {
      id: number;
    };
    const archive = await call({
      method: 'PATCH',
      url: `/api/v1/models/res.users/${me2.id}`,
      token: body.token,
      body: { active: false },
    });
    expect(archive.statusCode).toBe(422);
    expect(archive.json().detail).toContain('no active administrator');
    // Deleting a user who holds roles is refused (users are archived).
    const removed = await call({
      method: 'DELETE',
      url: `/api/v1/models/res.users/${me2.id}`,
      token: body.token,
    });
    expect(removed.statusCode).toBeGreaterThanOrEqual(400);

    // Sign-in and administrator sessions are in the audit log.
    const kinds = await server.driver.query<{ kind: string }>({
      text: 'SELECT kind FROM audit_event WHERE actor_id = $1 ORDER BY id',
      params: [me2.id],
    });
    expect(kinds.map((k) => k.kind)).toEqual(
      expect.arrayContaining(['auth.login', 'auth.2fa_enabled', 'admin.session']),
    );
  });
});

describe('private models', () => {
  test('credentials, sessions, assignments, grants and audit events are not served', async () => {
    const { body } = await login('carlos'); // alice is at the sign-in rate limit by now
    for (const model of [
      'auth.credential',
      'auth.session',
      'auth.user_group',
      'auth.user_grant',
      'audit.event',
    ]) {
      const res = await call({ url: `/api/v1/models/${model}`, token: body.token });
      expect(res.statusCode).toBe(404);
      expect((await call({ url: `/api/v1/meta/${model}`, token: body.token })).statusCode).toBe(
        404,
      );
    }
    const openapi = JSON.stringify(
      (await call({ url: '/api/v1/openapi.json', token: body.token })).json(),
    );
    expect(openapi).toContain('res.users');
    expect(openapi).not.toContain('auth.session');
    expect(openapi).not.toContain('passwordHash');
  });
});
