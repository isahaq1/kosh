/**
 * `@kosh/server/testing` — a database of its own for an integration test file (RFC 0034 step 1), on one PostgreSQL
 * server shared by the whole test run instead of a container per file. The run's server is given by
 * `KOSH_TEST_POSTGRES` (its maintenance database, set by the Vitest global setup of this repository, or by a module
 * author pointing their own tests at a server). A database answers like the container it replaces —
 * `getConnectionUri()` and `stop()` — and `stop()` drops it, whoever is still connected.
 */
import { randomBytes } from 'node:crypto';
import { type Driver, pg } from './orm.js';

export interface TestDatabase {
  getConnectionUri(): string;
  stop(): Promise<void>;
}

const serverUrl = (): string => {
  const url = process.env['KOSH_TEST_POSTGRES'];
  if (url === undefined || url === '')
    throw new Error(
      'KOSH_TEST_POSTGRES is not set: run the tests through Vitest (its global setup starts the server), or point it at a PostgreSQL maintenance database.',
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
