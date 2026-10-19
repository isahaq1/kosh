/**
 * A purchase installation for permission tests: two companies, an administrator with 2FA, and users whose roles
 * differ per company. Requests go through the real HTTP layer (`app.inject`) with real sessions.
 */
import { createServer, installBase, type KoshServer, totp } from '@isahaq/kosh-server';
import { orm } from '@isahaq/kosh-server/orm';
import { installApprovalPolicies } from '../../src/index.js';
import { purchase } from '../fixtures/purchase.js';
import { startPostgres } from './postgres.js';

export const PASSWORD = 'correct horse battery';

export interface Call {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly as?: string;
  readonly body?: unknown;
  readonly company?: number;
}

export interface TestApp {
  readonly server: KoshServer;
  readonly companies: { readonly dhaka: number; readonly chattogram: number };
  readonly users: Readonly<Record<string, number>>;
  /** Signs in (cached per user) and calls the API. */
  call(c: Call): Promise<{
    status: number;
    // biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
    json: () => any;
    body: string;
    headers: Record<string, unknown>;
  }>;
  /** A fresh session token of `login`. */
  signIn(login: string): Promise<string>;
  stop(): Promise<void>;
}

export async function startApp(): Promise<TestApp> {
  const db = await startPostgres();
  const server = await createServer({
    databaseUrl: db.url,
    modules: [purchase],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const { company: dhaka, admin } = await installBase(server.shutro, auth, {
    company: { name: 'Dhaka Ltd', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  const chattogram = await server.shutro.bootstrap(
    { reason: 'test: second company' },
    async (env) => {
      const companies = env.model('res.company' as never) as unknown as {
        create(r: unknown[]): Promise<{ ids: number[] }>;
      };
      const created = await companies.create([{ name: 'Chattogram Ltd', currency: 1 }]);
      await installApprovalPolicies(env, server.registry.loaded.modules);
      return created.ids[0] as number;
    },
  );
  const both = [dhaka, chattogram];
  const users: Record<string, number> = { admin };
  const people: [string, (string | { group: string; company: number })[]][] = [
    // Requester in Dhaka, department head in Chattogram.
    [
      'rahim',
      [
        { group: 'purchase.user', company: dhaka },
        { group: 'purchase.approver', company: chattogram },
      ],
    ],
    ['dina', [{ group: 'purchase.approver', company: dhaka }]],
    ['farid', [{ group: 'purchase.user', company: dhaka }]], // finance director role added by the admin API
    ['maria', ['purchase.manager']],
    ['bob', ['base.user']],
    ['nobody', []],
  ];
  for (const [login, groups] of people)
    users[login] = await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company: dhaka,
      companies: both,
      groups,
    });
  await server.shutro.bootstrap({ reason: 'test: admin in both companies' }, async (env) => {
    const u = env.model('res.users' as never) as unknown as {
      browse(ids: number[]): { write(v: unknown): Promise<void> };
    };
    await u.browse([admin]).write({ companies: { set: both } });
  });

  const tokens = new Map<string, string>();
  const inject = (c: Call, token?: string) =>
    server.app.inject({
      method: c.method ?? 'GET',
      url: c.url,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(c.company === undefined ? {} : { 'x-company': String(c.company) }),
      },
      ...(c.body === undefined ? {} : { payload: c.body as Record<string, unknown> }),
    });
  const signIn = async (login: string): Promise<string> => {
    const res = await inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { login, password: PASSWORD },
    });
    const token = (res.json() as { token: string }).token;
    if (login === 'admin') {
      // Administrators act as such only after a second factor: enrol 2FA once, verify on later sign-ins.
      const secret = adminSecret ?? (await enrol(token));
      if (adminSecret !== undefined)
        await inject(
          { method: 'POST', url: '/api/v1/auth/2fa/verify', body: { code: totp(secret) } },
          token,
        );
    }
    return token;
  };
  let adminSecret: string | undefined;
  const enrol = async (token: string): Promise<string> => {
    const setup = await inject({ method: 'POST', url: '/api/v1/auth/2fa/setup' }, token);
    const secret = (setup.json() as { secret: string }).secret;
    await inject(
      { method: 'POST', url: '/api/v1/auth/2fa/enable', body: { code: totp(secret) } },
      token,
    );
    adminSecret = secret;
    return secret;
  };
  const call = async (c: Call) => {
    let token: string | undefined;
    if (c.as !== undefined) {
      token = tokens.get(c.as);
      if (token === undefined) {
        token = await signIn(c.as);
        tokens.set(c.as, token);
      }
    }
    const res = await inject(c, token);
    return { status: res.statusCode, json: () => res.json(), body: res.body, headers: res.headers };
  };
  return {
    server,
    companies: { dhaka, chattogram },
    users,
    call,
    signIn,
    async stop() {
      await server.close();
      await db.stop();
    },
  };
}
