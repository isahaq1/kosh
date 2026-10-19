/**
 * `kosh apps` on an installation (RFC 0008): a project migrated before the App manager existed adopts what was
 * migrated; new catalogue modules are available, installed with `kosh apps install` (plan first, then one
 * transaction), disabled with their dependents (tables and data kept, `kosh migrate` plans nothing) and enabled again.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { orm, pg } from '@kosh/server';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { runApps } from '../src/apps.js';
import { runCli } from '../src/index.js';
import type { Prompter } from '../src/prompt.js';

let container: StartedPostgreSqlContainer;
// Inside the package, so the project's files resolve the workspace packages (@kosh/server, ...).
const dir = join(import.meta.dirname, `.work-apps-${process.pid}`);

const MODULES = `import { defineModule } from '@kosh/modules-sdk';
import { base, baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';

const group = (name: string) => orm.defineGroup({ code: name + '.user', implies: ['base.user'] });
const libraryShutro = orm.defineModule({
  name: 'library',
  version: '1.0.0',
  depends: [baseShutro],
  groups: [group('library')],
  models: [orm.defineModel('library.book', { access: { 'library.user': ['read'] }, fields: { title: orm.f.char({ required: true }) } })],
  data: [orm.record('library.book', 'book_welcome', { title: 'Welcome' })],
});
export const library = defineModule({
  shutro: libraryShutro,
  kosh: '^0.1.0',
  depends: [base],
  app: { code: 'library', label: 'Library' },
  accessLevels: { user: { label: 'User', groups: ['library.user'] } },
});
export const shelf = defineModule({
  shutro: orm.defineModule({
    name: 'shelf',
    version: '1.0.0',
    depends: [libraryShutro],
    groups: [group('shelf')],
    models: [orm.defineModel('library.shelf', { access: { 'shelf.user': ['read'] }, fields: { code: orm.f.char() } })],
  }),
  kosh: '^0.1.0',
  depends: [library],
  accessLevels: { user: { label: 'User', groups: ['shelf.user'] } },
});
`;

const run = async (...args: string[]) => {
  const out: string[] = [];
  const code = await runCli(args, (t) => out.push(t), { cwd: dir });
  return { code, text: out.join('') };
};
const query = async (text: string) => {
  const driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 1,
    parseNumeric: orm.toDecimal,
  });
  try {
    return await driver.query<Record<string, string | null>>({ text, params: [] });
  } finally {
    await driver.end();
  }
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, '.env'), `DATABASE_URL=${container.getConnectionUri()}\n`);
  // Before the App manager: the module list was the installed set. (Its own file: a process imports a file once.)
  await writeFile(
    join(dir, 'src', 'before.ts'),
    "import { base } from '@kosh/server';\nexport const modules = [base];\n",
  );
  const migrated = await run('migrate', '--no-seed', '--modules', 'src/before.ts');
  expect(migrated.code, migrated.text).toBe(0);
  // Now a catalogue with two more apps.
  await writeFile(
    join(dir, 'src', 'modules.ts'),
    `${MODULES}import { base } from '@kosh/server';\nexport const catalogue = [base, library, shelf];\n`,
  );
}, 180_000);

afterAll(async () => {
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('the catalogue: what was migrated is installed, new modules are available', async () => {
  const { code, text } = await run('apps');
  expect(code, text).toBe(0);
  expect(text).toMatch(/● • +base +\S+ +installed/);
  expect(text).toMatch(/○ • +library +1\.0\.0 +available +Library/);
  expect(text).toContain('1 installed · 0 disabled · 2 available');
});

test('install: --plan changes nothing; then one transaction with dependencies and data', async () => {
  const planned = await run('apps', 'install', 'shelf', '--plan');
  expect(planned.code, planned.text).toBe(0);
  expect(planned.text).toMatch(/\+ • {2}library +1\.0\.0 +install \(needed\)/);
  expect(planned.text).toMatch(/\+ • {2}shelf +1\.0\.0 +install\n/);
  expect(await query("SELECT to_regclass('public.library_book')::text AS t")).toEqual([
    { t: null },
  ]);

  const { code, text } = await run('apps', 'install', 'shelf', '--yes');
  expect(code, text).toBe(0);
  expect(text).toContain('✔ Applied in one transaction');
  expect(text).toContain('installed library, installed shelf');
  expect(await query('SELECT title FROM library_book')).toEqual([{ title: 'Welcome' }]);
  expect(await query('SELECT name, state, reason FROM kosh_module ORDER BY name')).toEqual([
    { name: 'base', state: 'installed', reason: 'selected' },
    { name: 'library', state: 'installed', reason: 'dependency' },
    { name: 'shelf', state: 'installed', reason: 'selected' },
  ]);
});

test('disable keeps the data and kosh migrate keeps the tables; enable brings the app back', async () => {
  const disabled = await run('apps', 'disable', 'library', '--yes');
  expect(disabled.code, disabled.text).toBe(0);
  expect(disabled.text).toContain('disable (it depends on a disabled app)');
  expect(disabled.text).toContain('disabled shelf, disabled library');
  expect(await query('SELECT count(*)::text AS n FROM library_book')).toEqual([{ n: '1' }]);

  const migrated = await run('migrate', '--no-seed');
  expect(migrated.code, migrated.text).toBe(0);
  expect(migrated.text).toContain('The database matches the modules: no new migration.');

  const listed = await run('apps');
  expect(listed.text).toMatch(/◌ • +library +1\.0\.0 +disabled/);

  const enabled = await run('apps', 'enable', 'shelf', '--yes');
  expect(enabled.code, enabled.text).toBe(0);
  expect(enabled.text).toContain('enabled library, enabled shelf');
});

test('asking: no applies nothing; unknown apps and uninstall are refused', async () => {
  const no: Prompter = {
    ask: async () => 'n',
    confirm: async () => false,
    close: () => {},
  };
  const out: string[] = [];
  expect(
    await runApps(['disable', 'shelf'], { write: (t) => out.push(t), cwd: dir, prompter: no }),
  ).toBe(1);
  expect(out.join('')).toContain('Nothing changed.');
  expect(await query("SELECT state FROM kosh_module WHERE name = 'shelf'")).toEqual([
    { state: 'installed' },
  ]);

  const unknown = await run('apps', 'install', 'crm', '--yes');
  expect(unknown.code).toBe(1);
  expect(unknown.text).toContain('Not in the catalogue: crm.');
  const base = await run('apps', 'disable', 'base', '--yes');
  expect(base.code).toBe(1);
  expect(base.text).toContain('base cannot be disabled');
  expect((await run('apps', 'uninstall', 'shelf')).code).toBe(2);
});
