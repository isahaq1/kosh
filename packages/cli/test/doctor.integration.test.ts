/**
 * `shutro-erp doctor` (RFC 0034 step 2) on a real installation: what is healthy is said so, what is broken fails
 * with what to do — no administrator, an administrator without a second factor, an installed app missing from
 * src/modules.ts —, and --json gives the same results for monitoring.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installBase, recordInstalledApps } from '@kosh/server';
import { type TestDatabase, testDatabase } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { runCli } from '../src/index.js';
import { modulesOf, openProject } from '../src/project.js';

let pg: TestDatabase;
// Inside the package, so the project's files resolve the workspace packages.
const dir = join(import.meta.dirname, `.work-doctor-${process.pid}`);
const library = `import { defineModule } from '@kosh/modules-sdk';
import { base, baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';
const Book = orm.defineModel('library.book', {
  access: { 'library.user': ['read'] },
  fields: { title: orm.f.char({ required: true }) },
});
export const library = defineModule({
  shutro: orm.defineModule({
    name: 'library',
    version: '0.1.0',
    depends: [baseShutro],
    groups: [orm.defineGroup({ code: 'library.user', implies: ['base.user'] })],
    models: [Book],
  }),
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'Library', groups: ['library.user'] } },
});
`;
const withLibrary =
  "import { base } from '@kosh/server';\nimport { library } from './library.ts';\nexport const modules = [base, library];\n";
const withoutLibrary = "import { base } from '@kosh/server';\nexport const modules = [base];\n";

const run = async (...args: string[]) => {
  const out: string[] = [];
  const code = await runCli(args, (t) => out.push(t), { cwd: dir });
  return { code, text: out.join('') };
};
/** The report's line for a check: the word after its mark. */
const line = (text: string, check: string): string =>
  text.split('\n').find((l) => l.slice(2).trimStart().split(' ')[0] === check) ?? '';

beforeAll(async () => {
  pg = await testDatabase();
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, '.env'), `DATABASE_URL=${pg.getConnectionUri()}\n`);
  await writeFile(join(dir, 'src', 'library.ts'), library);
  await writeFile(join(dir, 'src', 'modules.ts'), withLibrary);
  const migrated = await run('migrate');
  expect(migrated.code, migrated.text).toBe(0);
}, 240_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await pg?.stop();
});

test('a fresh installation: the database and migrations are fine, no administrator fails', async () => {
  const { code, text } = await run('doctor');
  expect(line(text, 'database'), text).toMatch(/database\s+PostgreSQL 1[6-9]/);
  expect(line(text, 'database').startsWith('✔')).toBe(true);
  expect(line(text, 'migrations')).toMatch(/migrations\s+\d+ applied, none pending/);
  expect(line(text, 'clock').startsWith('✔')).toBe(true);
  expect(line(text, 'administrators')).toMatch(/^✖ administrators\s+no active administrator/);
  expect(text).toContain('→ Create one: shutro-erp user create');
  expect(line(text, 'mail')).toMatch(/^▲ mail\s+SMTP_URL is not set/);
  expect(code).toBe(1);
});

test('an administrator without two-factor sign-in still fails; --json says the same', async () => {
  // The company and its first administrator, as shutro-erp init makes them (no second factor until they sign in).
  const server = await openProject(dir, 'src/modules.ts');
  try {
    const auth = server.auth;
    if (auth === undefined) throw new Error('base is installed');
    await installBase(server.shutro, auth, {
      company: { name: 'Padma Traders', currency: 'BDT' },
      admin: { login: 'root', name: 'Root', password: 'correct horse battery staple' },
    });
    await recordInstalledApps(
      server.driver,
      await modulesOf('src/modules.ts', dir),
      ['library'],
      'test',
    );
  } finally {
    await server.close();
  }
  const { code, text } = await run('doctor', '--json');
  const report = JSON.parse(text) as {
    ok: boolean;
    results: { check: string; status: string; detail: string }[];
  };
  expect(report.ok).toBe(false);
  expect(report.results.find((r) => r.check === 'administrators')).toMatchObject({
    status: 'fail',
    detail: '1 administrator(s), none with two-factor sign-in',
  });
  expect(report.results.find((r) => r.check === 'apps')?.status).toBe('ok');
  expect(code).toBe(1);
});

test('an installed app missing from src/modules.ts fails, naming it', async () => {
  // Another file: the CLI runs in this process here, where Node keeps the first src/modules.ts it imported.
  await writeFile(join(dir, 'src', 'without.ts'), withoutLibrary);
  const { text } = await run('doctor', '--modules', 'src/without.ts');
  expect(line(text, 'apps'), text).toMatch(
    /^✖ apps\s+installed but missing from src\/without\.ts: library/,
  );
});
