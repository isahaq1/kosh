/**
 * Single sign-on certified against a real **Keycloak** (RFC 0034 §2.4, §2.2): a realm is set up through Keycloak's
 * admin API — a confidential client with this installation's redirect address, a person with a verified address in
 * a group, the groups in the ID token — and the sign-on is driven as a browser would: our start, Keycloak's own
 * sign-in form, our callback, the hand-off. Keycloak's discovery, its token endpoint, its keys and its real RS256
 * signature are what is verified.
 *
 * Live only (`pnpm certify keycloak`, with a Keycloak at `KOSH_KEYCLOAK_URL`, default http://localhost:18080, and
 * its admin in `KOSH_KEYCLOAK_ADMIN` / `KOSH_KEYCLOAK_ADMIN_PASSWORD`, default admin / admin): a sign-on carries a
 * nonce and a signature made for it, so it cannot be replayed from a recording. A live pass writes the
 * certification (`recordings/keycloak.json`: when, and against which Keycloak); `pnpm test` skips the contract.
 *
 *   docker run -d --name kosh-keycloak -p 18080:8080 -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
 *     -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin quay.io/keycloak/keycloak:26.0 start-dev
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import {
  base,
  createServer,
  installBase,
  type KoshServer,
  ssoSecretName,
} from '../../src/index.js';
import { orm } from '../../src/orm.js';
import { type TestDatabase, testDatabase } from '../../src/testing.js';

const live = process.env['KOSH_CERTIFY'] === 'live';
const KEYCLOAK = (process.env['KOSH_KEYCLOAK_URL'] || 'http://localhost:18080').replace(/\/$/, '');
const ADMIN = process.env['KOSH_KEYCLOAK_ADMIN'] || 'admin';
const ADMIN_PASSWORD = process.env['KOSH_KEYCLOAK_ADMIN_PASSWORD'] || 'admin';
const REALM = 'kosh-certify';
const BASE = 'https://erp.example.test';
const CLIENT_SECRET = 'kosh-certify-client-secret';
const PERSON = { login: 'rumi@padma.test', password: 'a password at keycloak' };

let container: TestDatabase;
let server: KoshServer;
let rumi = 0;
let version = '';
let total = 0;
let passed = 0;
afterEach((ctx) => {
  if (ctx.task.result?.state === 'pass') passed += 1;
});
const contract = (name: string, fn: () => Promise<void>) => {
  total += 1;
  return test.skipIf(!live)(name, { retry: 0, timeout: 120_000 }, fn);
};

/** Keycloak's admin API, as its administrator. */
async function admin(): Promise<
  (method: string, path: string, body?: unknown) => Promise<Response>
> {
  const token = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: ADMIN,
      password: ADMIN_PASSWORD,
    }),
  });
  if (!token.ok) throw new Error(`Keycloak's administrator could not sign in (${token.status}).`);
  const bearer = ((await token.json()) as { access_token: string }).access_token;
  return (method, path, body) =>
    fetch(`${KEYCLOAK}/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
const created = async (response: Response, what: string): Promise<string> => {
  if (!response.ok)
    throw new Error(`${what}: Keycloak answered ${response.status} ${await response.text()}`);
  return (
    String(response.headers.get('location') ?? '')
      .split('/')
      .at(-1) ?? ''
  );
};

const get = (url: string) => server.app.inject({ method: 'GET', url });
const local = (location: string) => location.replace(BASE, '');
/** A browser's cookies across Keycloak's pages. */
const cookiesOf = (response: Response, jar: Map<string, string>): string => {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    const [name, ...value] = String(pair).split('=');
    jar.set(String(name), value.join('='));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
};
/** Our start, Keycloak's sign-in form filled as the person, our callback: where the browser lands. */
async function journey(): Promise<URL> {
  const start = await get('/api/v1/auth/sso/keycloak/start');
  expect(start.statusCode, start.body).toBe(302);
  const jar = new Map<string, string>();
  const form = await fetch(String(start.headers.location), { redirect: 'manual' });
  expect(form.status, 'Keycloak shows its sign-in form').toBe(200);
  const cookie = cookiesOf(form, jar);
  const action = /<form[^>]*action="([^"]+)"/
    .exec(await form.text())?.[1]
    ?.replaceAll('&amp;', '&');
  if (action === undefined) throw new Error('Keycloak’s sign-in form has no action.');
  const signedIn = await fetch(action, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ username: PERSON.login, password: PERSON.password }),
  });
  expect(signedIn.status, 'Keycloak sends the browser back to us').toBe(302);
  const back = await get(local(String(signedIn.headers.get('location'))));
  expect(back.statusCode, back.body).toBe(302);
  return new URL(String(back.headers.location));
}

beforeAll(async () => {
  if (!live) return;
  // ---- Keycloak: the realm, the client, the person in a group, the groups in the token
  const api = await admin();
  version =
    ((await (await api('GET', '/serverinfo')).json()) as { systemInfo?: { version?: string } })
      .systemInfo?.version ?? '';
  await api('DELETE', `/realms/${REALM}`);
  await created(await api('POST', '/realms', { realm: REALM, enabled: true }), 'the realm');
  const client = await created(
    await api('POST', `/realms/${REALM}/clients`, {
      clientId: 'kosh',
      secret: CLIENT_SECRET,
      publicClient: false,
      standardFlowEnabled: true,
      redirectUris: [`${BASE}/api/v1/auth/sso/keycloak/callback`],
      attributes: { 'pkce.code.challenge.method': 'S256' },
    }),
    'the client',
  );
  await created(
    await api('POST', `/realms/${REALM}/clients/${client}/protocol-mappers/models`, {
      name: 'groups',
      protocol: 'openid-connect',
      protocolMapper: 'oidc-group-membership-mapper',
      config: {
        'claim.name': 'groups',
        'full.path': 'false',
        'id.token.claim': 'true',
        'access.token.claim': 'true',
      },
    }),
    'the groups mapper',
  );
  const group = await created(
    await api('POST', `/realms/${REALM}/groups`, { name: 'erp-developers' }),
    'the group',
  );
  const person = await created(
    await api('POST', `/realms/${REALM}/users`, {
      username: PERSON.login,
      email: PERSON.login,
      emailVerified: true,
      firstName: 'Rumi',
      lastName: 'Akter',
      enabled: true,
      credentials: [{ type: 'password', value: PERSON.password, temporary: false }],
    }),
    'the person',
  );
  const joined = await api('PUT', `/realms/${REALM}/users/${person}/groups/${group}`);
  if (!joined.ok) throw new Error(`the group membership: ${joined.status}`);

  // ---- our side: the person exists; the provider points at the realm
  process.env[ssoSecretName('keycloak')] = CLIENT_SECRET;
  container = await testDatabase();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [base],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    oauth: { baseUrl: BASE },
    rateLimit: { max: 0, timeWindow: '1 minute' },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const { company } = await installBase(server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: 'correct horse battery' },
  });
  rumi = await auth.createUser({
    login: PERSON.login,
    name: 'Rumi',
    password: 'another password here',
    company,
    companies: [company],
    groups: ['base.user'],
  });
  await server.shutro.bootstrap({ reason: 'test' }, async (env) => {
    await (
      env.model('auth.sso_provider' as never) as unknown as {
        create(r: unknown[]): Promise<unknown>;
      }
    ).create([
      {
        key: 'keycloak',
        name: 'Keycloak',
        issuer: `${KEYCLOAK}/realms/${REALM}`,
        clientId: 'kosh',
        groupMap: { 'erp-developers': ['base.developer'] },
      },
    ]);
  });
}, 180_000);

afterAll(async () => {
  if (!live) return;
  await server?.close();
  await container?.stop();
  // The certification: kept only when every step of the contract ran and passed.
  if (passed === total)
    writeFileSync(
      join(import.meta.dirname, 'recordings', 'keycloak.json'),
      `${JSON.stringify(
        {
          adapter: 'sso-keycloak',
          certifiedAt: new Date().toISOString(),
          against: `Keycloak ${version}`,
          contract:
            'authorization code flow with PKCE, RS256 ID token, verified address, groups to roles',
          steps: total,
        },
        null,
        2,
      )}\n`,
    );
});

contract(
  'Keycloak’s person signs in: its form, its code, its signed token, our session',
  async () => {
    const landed = await journey();
    expect(landed.searchParams.get('sso_error'), landed.toString()).toBeNull();
    const complete = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sso/complete',
      payload: { code: landed.searchParams.get('sso') },
    });
    expect(complete.statusCode, complete.body).toBe(200);
    const me = await server.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${(complete.json() as { token: string }).token}` },
    });
    expect((me.json() as { login: string }).login).toBe(PERSON.login);
  },
);

contract(
  'Keycloak’s group gives its role here, and the person is linked to Keycloak’s account',
  async () => {
    const roles = (
      await server.driver.query<{ group: string }>({
        text: 'SELECT "group" FROM auth_user_group WHERE user_id = $1 ORDER BY "group"',
        params: [rumi],
      })
    ).map((r) => r.group);
    expect(roles).toEqual(['base.developer', 'base.user']);
    const links = await server.driver.query<{ subject: string; email: string }>({
      text: 'SELECT subject, email FROM auth_sso_identity WHERE user_id = $1',
      params: [rumi],
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.email).toBe(PERSON.login);
    expect(String(links[0]?.subject).length).toBeGreaterThan(10); // Keycloak's id of the person
  },
);

contract('someone Keycloak knows and we do not is refused, and nobody is created', async () => {
  const api = await admin();
  await created(
    await api('POST', `/realms/${REALM}/users`, {
      username: 'stranger@padma.test',
      email: 'stranger@padma.test',
      emailVerified: true,
      firstName: 'A',
      lastName: 'Stranger',
      enabled: true,
      credentials: [{ type: 'password', value: PERSON.password, temporary: false }],
    }),
    'the stranger',
  );
  const before = PERSON.login;
  PERSON.login = 'stranger@padma.test';
  try {
    const landed = await journey();
    expect(landed.searchParams.get('sso_error'), landed.toString()).toBe('unknown');
  } finally {
    PERSON.login = before;
  }
  const [count] = await server.driver.query<{ n: number }>({
    text: 'SELECT count(*)::int AS n FROM res_users',
    params: [],
  });
  expect(count?.n).toBe(2);
});
