/**
 * Portal identity on real PostgreSQL (RFC 0015 step 1): only portal access managers grant access; a contact needs an
 * email; the invitation is emailed and single use; the chosen password signs the contact in; a portal user reaches
 * the portal API and signing in, and nothing of the back-office; internal users don't use the portal API; revoking
 * ends the access and the sessions; every step is audited. An external group that implies `base.user` is refused
 * when the server starts.
 */
import { contacts } from '@kosh/contacts';
import { createMemoryMailer } from '@kosh/mail';
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import {
  base,
  baseShutro,
  createServer,
  installBase,
  type KoshServer,
  ServerConfigError,
} from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createPortal } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const mailer = createMemoryMailer();
let container: StartedPostgreSqlContainer;
let server: KoshServer;
let acme: number;
let rina: number;
let nomail: number;

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function login(login: string, password = PASSWORD): Promise<string | null> {
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login, password },
  });
  return res.statusCode === 200 ? (res.json() as { token: string }).token : null;
}
async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  token: string | null,
  payload?: unknown,
) {
  const res = await server.app.inject({
    method,
    url,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
const tokenOf = (url: string) => new URL(url).searchParams.get('token') ?? '';

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [contacts, createPortal({ portalUrl: 'https://portal.test', mailer })],
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
    ['mgr', ['portal.manager']],
    ['clerk', ['contacts.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  await server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    const partners = env.model('res.partner' as never) as unknown as {
      create(r: unknown[]): Promise<{ ids: readonly number[] }>;
    };
    acme = (await partners.create([{ name: 'Acme Trading', isCompany: true }])).ids[0] ?? 0;
    const people = await partners.create([
      { name: 'Rina Akter', email: 'Rina@Acme.test', parent: acme },
      { name: 'No Mail', parent: acme },
    ]);
    rina = people.ids[0] ?? 0;
    nomail = people.ids[1] ?? 0;
  });
}, 180_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
});

let invitation = '';
let portalUser = 0;

test('only portal access managers grant access; the contact needs an email; the invitation is emailed', async () => {
  const clerk = await login('clerk');
  const mgr = await login('mgr');
  expect((await call('POST', '/api/v1/portal/access', clerk, { partner: rina })).status).toBe(403);
  const noEmail = await call('POST', '/api/v1/portal/access', mgr, { partner: nomail });
  expect([noEmail.status, noEmail.json.type]).toEqual([422, 'https://kosh.dev/problems/no-email']);
  const granted = await call('POST', '/api/v1/portal/access', mgr, { partner: rina });
  expect(granted.status).toBe(201);
  expect(granted.json).toMatchObject({ login: 'rina@acme.test', emailed: true });
  expect(granted.json.activationUrl).toMatch(/^https:\/\/portal\.test\/activate\?token=[\w-]{43}$/);
  portalUser = granted.json.user;
  invitation = tokenOf(granted.json.activationUrl);
  expect(mailer.sent).toHaveLength(1);
  expect(mailer.sent[0]).toMatchObject({
    to: 'rina@acme.test',
    subject: 'Your access to Padma Traders',
  });
  expect(mailer.sent[0]?.html).toContain(granted.json.activationUrl.replaceAll('&', '&amp;'));
  // The same login twice: refused.
  const again = await call('POST', '/api/v1/portal/access', mgr, { partner: rina });
  expect(again.status).toBe(409);
  const listed = await call('GET', `/api/v1/portal/access?partner=${rina}`, mgr);
  expect(listed.json.users).toEqual([
    {
      id: portalUser,
      login: 'rina@acme.test',
      active: true,
      activated: false,
      invitationExpiresAt: expect.any(String),
    },
  ]);
  // The token is kept as a digest only.
  const [row] = await server.driver.query<{ token_hash: string }>({
    text: 'SELECT token_hash FROM portal_invitation WHERE user_id = $1',
    params: [portalUser],
  });
  expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(row?.token_hash).not.toContain(invitation);
});

test('activation: a wrong token or a weak password changes nothing; the link works once', async () => {
  expect(
    (await call('POST', '/api/portal/v1/activate', null, { token: 'nope', password: PASSWORD }))
      .status,
  ).toBe(410);
  const weak = await call('POST', '/api/portal/v1/activate', null, {
    token: invitation,
    password: 'short',
  });
  expect(weak.status).toBe(422);
  expect(await login('rina@acme.test')).toBeNull();
  const ok = await call('POST', '/api/portal/v1/activate', null, {
    token: invitation,
    password: PASSWORD,
  });
  expect([ok.status, ok.json]).toEqual([200, { login: 'rina@acme.test' }]);
  expect(
    (await call('POST', '/api/portal/v1/activate', null, { token: invitation, password: PASSWORD }))
      .status,
  ).toBe(410);
  expect(await login('rina@acme.test')).not.toBeNull();
});

test('a portal user reaches the portal and signing in, nothing of the back-office; staff stay out of the portal API', async () => {
  const token = await login('rina@acme.test');
  const me = await call('GET', '/api/portal/v1/me', token);
  expect(me.status).toBe(200);
  expect(me.json).toMatchObject({
    login: 'rina@acme.test',
    name: 'Rina Akter',
    partner: { id: rina, name: 'Rina Akter' },
    company: { name: 'Padma Traders' },
  });
  for (const url of [
    '/api/v1/models/res.partner',
    `/api/v1/models/res.partner/${rina}`,
    '/api/v1/menus',
    '/api/v1/apps',
    '/api/v1/openapi.json',
    `/api/v1/portal/access?partner=${rina}`,
  ]) {
    const refused = await call('GET', url, token);
    expect([url, refused.status, refused.json?.type]).toEqual([
      url,
      403,
      'https://kosh.dev/problems/internal-only',
    ]);
  }
  expect((await call('GET', '/api/v1/auth/me', token)).status).toBe(200);
  // Staff use the back-office, not the portal API.
  expect((await call('GET', '/api/portal/v1/me', await login('mgr'))).status).toBe(403);
});

test('a new invitation replaces the old one; revoking ends access and sessions; all audited', async () => {
  const mgr = await login('mgr');
  const first = await call('POST', `/api/v1/portal/access/${portalUser}/invitation`, mgr);
  const second = await call('POST', `/api/v1/portal/access/${portalUser}/invitation`, mgr);
  expect(second.status).toBe(201);
  expect(
    (
      await call('POST', '/api/portal/v1/activate', null, {
        token: tokenOf(first.json.activationUrl),
        password: PASSWORD,
      })
    ).status,
  ).toBe(410);
  const token = await login('rina@acme.test');
  expect(
    (await call('DELETE', `/api/v1/portal/access/${portalUser}`, await login('clerk'))).status,
  ).toBe(403);
  expect((await call('DELETE', `/api/v1/portal/access/${portalUser}`, mgr)).status).toBe(204);
  expect((await call('GET', '/api/portal/v1/me', token)).status).toBe(401);
  const listed = await call('GET', `/api/v1/portal/access?partner=${rina}`, mgr);
  expect(listed.json.users).toMatchObject([{ id: portalUser, active: false, activated: true }]);
  // Granting again brings the same user back, with a new invitation (the old password no longer works).
  const again = await call('POST', '/api/v1/portal/access', mgr, { partner: rina });
  expect([again.status, again.json.user]).toEqual([201, portalUser]);
  expect(await login('rina@acme.test')).toBeNull();
  // The login belongs to that contact's user: another contact with the same email cannot take it.
  expect((await call('POST', '/api/v1/portal/access', mgr, { partner: nomail })).status).toBe(422);
  expect(await login('rina@acme.test')).toBeNull();
  expect(
    (
      await call('POST', '/api/portal/v1/activate', null, {
        token: tokenOf(second.json.activationUrl),
        password: PASSWORD,
      })
    ).status,
  ).toBe(410);
  const events = await server.driver.query<{ kind: string }>({
    text: `SELECT kind FROM audit_event WHERE kind LIKE 'portal.%' ORDER BY id`,
    params: [],
  });
  expect(events.map((e) => e.kind)).toEqual([
    'portal.invited',
    'portal.activated',
    'portal.invited',
    'portal.invited',
    'portal.revoked',
    'portal.invited',
  ]);
});

test('an external group that implies base.user is refused at start', async () => {
  const leaky = defineKoshModule({
    shutro: orm.defineModule({
      name: 'leaky',
      version: '1.0.0',
      depends: [baseShutro],
      groups: [orm.defineGroup({ code: 'leaky.guest', label: 'Guest', implies: ['base.user'] })],
      models: [],
    }),
    kosh: '^0.1.0',
    depends: [base],
    accessLevels: { guest: { label: 'Guest', groups: ['leaky.guest'] } },
    externalGroups: ['leaky.guest'],
  });
  await expect(
    createServer({ databaseUrl: container.getConnectionUri(), modules: [leaky], logger: false }),
  ).rejects.toThrow(ServerConfigError);
});

test('a portal document whose model has no portal record rule is refused at start', async () => {
  const careless = defineKoshModule({
    shutro: orm.defineModule({
      name: 'careless',
      version: '1.0.0',
      depends: [baseShutro],
      groups: [orm.defineGroup({ code: 'careless.user', label: 'User', implies: ['base.user'] })],
      models: [],
    }),
    kosh: '^0.1.0',
    depends: [base, contacts, createPortal()],
    accessLevels: { user: { label: 'User', groups: ['careless.user'] } },
    portal: {
      documents: [
        {
          key: 'everyone',
          model: 'res.partner',
          label: 'Every contact',
          partner: 'parent',
          list: ['name'],
          fields: ['name', 'email'],
        },
      ],
    },
  });
  await expect(
    createServer({
      databaseUrl: container.getConnectionUri(),
      modules: [careless],
      logger: false,
    }),
  ).rejects.toThrow(/no read access with a record rule/);
});
