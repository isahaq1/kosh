/**
 * `@kosh/server/testing` — a database of its own for an integration test file (RFC 0034 step 1), on one PostgreSQL
 * server shared by the whole test run instead of a container per file. The run's server is given by
 * `KOSH_TEST_POSTGRES` (its maintenance database, set by the Vitest global setup of this repository, or by a module
 * author pointing their own tests at a server; an installation's `DATABASE_URL` otherwise). A database answers like the container it replaces —
 * `getConnectionUri()` and `stop()` — and `stop()` drops it, whoever is still connected.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoshModule } from '@kosh/modules-sdk';
import { applyApps, installDefaults, prepareApps, recordInstalledApps } from './apps.js';
import { totp } from './auth/crypto.js';
import { installBase } from './auth/install.js';
import { type AppHost, createAppHost } from './host.js';
import { type Driver, orm, pg } from './orm.js';

export interface TestDatabase {
  getConnectionUri(): string;
  stop(): Promise<void>;
}

const serverUrl = (): string => {
  // An installation's own tests use its server (DATABASE_URL): each test file gets a scratch database on it.
  const url = process.env['KOSH_TEST_POSTGRES'] || process.env['DATABASE_URL'];
  if (url === undefined || url === '')
    throw new Error(
      'KOSH_TEST_POSTGRES is not set: run the tests through Vitest (its global setup starts the server), or point it (or DATABASE_URL) at a PostgreSQL server the tests may create databases on.',
    );
  return url;
};

let admin: Driver | undefined;
const maintenance = (): Driver => {
  admin ??= pg.createDriver({ url: serverUrl(), max: 1, applicationName: 'kosh-tests' });
  return admin;
};

/** Creates an empty database for the calling test file and returns its address. */
export async function testDatabase(): Promise<TestDatabase> {
  // Lower-case letters and digits only: a safe identifier, unique across workers and runs.
  const name = `kosh_t_${randomBytes(6).toString('hex')}`;
  await maintenance().query({ text: `CREATE DATABASE ${name}`, params: [] });
  const url = new URL(serverUrl());
  url.pathname = `/${name}`;
  const address = url.toString();
  return {
    getConnectionUri: () => address,
    async stop() {
      await maintenance().query({
        text: `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`,
        params: [],
      });
    },
  };
}

export { type Cassette, cassette, type Exchange, type Recording, redact } from './cassette.js';
export { type FakeOidc, type FakePerson, fakeOidc } from './testing-oidc.js';
export { type FakePasskey, type FakePasskeyOptions, fakePasskey } from './testing-passkey.js';

// ---- an installation for a test file

/** The password of every user of a {@link testInstallation}. */
export const TEST_PASSWORD = 'correct horse battery';

export interface TestInstallation {
  readonly host: AppHost;
  readonly company: number;
  /**
   * Calls the API as a user (`admin`, or a login of `users`): signed in on the first call, the Administrator with
   * the second factor their rights need.
   */
  call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    as: string,
    payload?: unknown,
  ): Promise<{ readonly status: number; readonly json: unknown }>;
  /** Stops the server and drops the database. */
  close(): Promise<void>;
}

/**
 * A served installation on a database of its own, for an integration test file: the modules installed with their
 * seed data and defaults, a company, an Administrator (`admin`) and the users asked for, each with their groups.
 * Requests go through the real server (`call`), so what a test proves — a record made, a step refused, a 403 for
 * someone without the role — is what the server does.
 */
export async function testInstallation(options: {
  /** The modules to serve (`base` among them, or it is added by what depends on it). */
  readonly modules: readonly KoshModule[];
  /** Logins with their groups: `{ lina: ['library.user'], bob: ['base.user'] }`. */
  readonly users?: Readonly<Record<string, readonly string[]>>;
  readonly company?: { readonly name: string; readonly currency: string };
}): Promise<TestInstallation> {
  process.env['KOSH_SCHEDULES'] = 'off';
  const database = await testDatabase();
  const driver = pg.createDriver({
    url: database.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  const dir = await mkdtemp(join(tmpdir(), 'kosh-test-'));
  const catalogue = [...options.modules];
  let host: AppHost | undefined;
  const close = async () => {
    await host?.close();
    await driver.end();
    await rm(dir, { recursive: true, force: true });
    await database.stop();
  };
  try {
    await recordInstalledApps(driver, [], [], 'test');
    await applyApps(
      await prepareApps({
        driver,
        catalogue,
        change: { install: catalogue.map((m) => m.name).filter((n) => n !== 'base') },
        dir,
      }),
      { driver, dir, actor: 'test' },
    );
    host = await createAppHost({
      databaseUrl: database.getConnectionUri(),
      catalogue,
      migrationsDir: dir,
      logger: false,
      listen: false,
      auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
      rateLimit: { max: 0, timeWindow: '1 minute' },
    });
    const served = host;
    const auth = served.server.auth;
    if (auth === undefined)
      throw new Error('The modules do not include base: there is nobody to sign in.');
    const { company } = await installBase(served.server.shutro, auth, {
      company: options.company ?? { name: 'Test company', currency: 'BDT' },
      admin: { login: 'admin', name: 'Administrator', password: TEST_PASSWORD },
    });
    await installDefaults(served.server.shutro, served.server.registry.loaded.modules, { company });
    for (const [login, groups] of Object.entries(options.users ?? {}))
      await auth.createUser({
        login,
        name: login,
        password: TEST_PASSWORD,
        company,
        companies: [company],
        groups: [...groups],
      });
    const tokens = new Map<string, string>();
    const signIn = async (as: string): Promise<string> => {
      const login = await served.server.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { login: as, password: TEST_PASSWORD },
      });
      const token = (login.json() as { token?: string }).token;
      if (token === undefined) throw new Error(`Nobody signs in as ${as}: name them in users.`);
      if (as === 'admin') {
        // An Administrator's rights need their second factor.
        const headers = { authorization: `Bearer ${token}` };
        const setup = await served.server.app.inject({
          method: 'POST',
          url: '/api/v1/auth/2fa/setup',
          headers,
        });
        await served.server.app.inject({
          method: 'POST',
          url: '/api/v1/auth/2fa/enable',
          headers,
          payload: { code: totp((setup.json() as { secret: string }).secret) },
        });
      }
      return token;
    };
    return {
      host: served,
      company,
      async call(method, url, as, payload) {
        let token = tokens.get(as);
        if (token === undefined) {
          token = await signIn(as);
          tokens.set(as, token);
        }
        const res = await served.server.app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${token}` },
          ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
        });
        const json: unknown = res.headers['content-type']?.toString().includes('json')
          ? res.json()
          : null;
        return { status: res.statusCode, json };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
