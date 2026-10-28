/**
 * A throwaway Kosh with every app and the demo data (RFC 0008 §5.8): `pnpm demo`. PostgreSQL comes from
 * `DATABASE_URL`, or from a Testcontainers container that goes with the process. The API listens on
 * `KOSH_DEMO_PORT` (3000); the back-office is `pnpm --filter @kosh/web dev` with `KOSH_API` pointing at it.
 *
 * Sign in as a demo user (password `shutro demo 2026`): `dina` (manager of every app), `rahim` (sales, invoicing),
 * `karim` (purchasing), `sumi` (projects). `admin` has the same password and enrols its authenticator at first use.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyApps,
  createAppHost,
  DEMO_PASSWORD,
  installBase,
  installDefaults,
  installDemo,
  prepareApps,
  recordInstalledApps,
  startAppHost,
} from '@kosh/server';
import { orm, pg } from '@kosh/server/orm';
import { DEMO_APPS, demoCatalogue } from './catalogue.js';

const PORT = Number(process.env['KOSH_DEMO_PORT'] ?? 3000);
process.env['KOSH_STORAGE_DIR'] ??= mkdtempSync(join(tmpdir(), 'kosh-demo-files-'));

let databaseUrl = process.env['DATABASE_URL'];
let stop: () => Promise<void> = async () => undefined;
if (databaseUrl === undefined) {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer('postgres:18').start();
  databaseUrl = container.getConnectionUri();
  stop = () => container.stop().then(() => undefined);
}

const catalogue = demoCatalogue();
const migrations = mkdtempSync(join(tmpdir(), 'kosh-demo-migrations-'));
const setup = pg.createDriver({ url: databaseUrl, max: 2, parseNumeric: orm.toDecimal });
await recordInstalledApps(setup, [], [], 'demo');
await applyApps(
  await prepareApps({
    driver: setup,
    catalogue,
    change: { install: [...DEMO_APPS] },
    dir: migrations,
  }),
  { driver: setup, dir: migrations, actor: 'demo' },
);
await setup.end();
const host = await createAppHost({
  databaseUrl,
  catalogue,
  migrationsDir: migrations,
  auth: { secureCookies: false },
  logger: { level: 'warn' },
});
const { server } = host;
if (server.auth === undefined) throw new Error('base is installed');
const { company } = await installBase(server.shutro, server.auth, {
  company: { name: 'Padma Traders', currency: 'BDT' },
  admin: { login: 'admin', name: 'Administrator', password: DEMO_PASSWORD },
});
await installDefaults(server.shutro, server.registry.loaded.modules, { company });
await installDemo({
  shutro: server.shutro,
  auth: server.auth,
  driver: server.driver,
  modules: server.registry.loaded.modules,
  company,
  write: (line) => process.stdout.write(`  ${line}\n`),
});
await startAppHost(host, { port: PORT, host: '127.0.0.1', onShutdown: stop });
process.stdout.write(
  `\nKosh demo API on http://127.0.0.1:${PORT}\n` +
    `  back-office: SHUTRO_ERP_API=http://127.0.0.1:${PORT} pnpm --filter @kosh/web dev\n` +
    `  sign in as dina, rahim, karim or sumi with the password "${DEMO_PASSWORD}"\n`,
);
