/**
 * One PostgreSQL server for a whole test run (RFC 0034 step 1). Vitest runs this once, before any test file: it
 * starts a single container — or uses `KOSH_TEST_DATABASE_URL`, an existing server — and hands its address to the
 * workers (`KOSH_TEST_POSTGRES`), where each test file creates a database of its own on it (`testDatabase()`
 * of `@kosh/server/testing`). A hundred containers
 * starting at once used to time out on connect under load; one server with many databases does not.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer | undefined;

/** Sets `KOSH_TEST_POSTGRES` (read by `@kosh/server/testing` in the workers, which start after this). */
export async function setup(): Promise<void> {
  const given = process.env['KOSH_TEST_DATABASE_URL'];
  if (given !== undefined && given !== '') {
    process.env['KOSH_TEST_POSTGRES'] = given;
    return;
  }
  container = await new PostgreSqlContainer('postgres:18')
    // Tests never need durability: no fsync, no full-page writes. Enough connections for every worker's pools.
    .withCommand([
      'postgres',
      '-c',
      'max_connections=400',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ])
    .start();
  const url = new URL(container.getConnectionUri());
  url.pathname = '/postgres';
  process.env['KOSH_TEST_POSTGRES'] = url.toString();
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
