/**
 * `kosh migrate`, `kosh migrate status` and `kosh seed` on an installation, with a module whose version, fields and
 * seed data change between runs: the schema change becomes a new versioned file, the module's data migration runs
 * once on the upgrade, seed data is created, updated and deleted by external id, and a destructive change waits for
 * --allow-destructive.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { runCli } from '../src/index.js';

let pg: StartedPostgreSqlContainer;
// Inside the package, so the project's files resolve the workspace packages (@kosh/server, ...).
const dir = join(import.meta.dirname, `.work-${process.pid}`);

/** A version of the `library` module: fields and seed data per version, a data migration for 0.2.0. */
function moduleFile(version: string, extraField: boolean, books: [string, string][]): string {
  return `import { defineModule } from '@kosh/modules-sdk';
import { base, baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';

const Book = orm.defineModel('library.book', {
  access: { 'library.user': ['read'] },
  fields: { title: orm.f.char({ required: true }), code: orm.f.char()${extraField ? ', shelf: orm.f.char()' : ''} },
});
export const library = defineModule({
  shutro: orm.defineModule({
    name: 'library',
    version: '${version}',
    depends: [baseShutro],
    groups: [orm.defineGroup({ code: 'library.user', implies: ['base.user'] })],
    models: [Book],
    data: [${books.map(([name, title]) => `orm.record('library.book', '${name}', { title: '${title}' })`).join(', ')}],
    migrations: [${
      version === '0.1.0'
        ? ''
        : `
      { version: '0.2.0', description: 'codes', up: async ({ sql }) => { await sql\`UPDATE library_book SET code = 'C-' || id\`; } },
    `
    }],
  }),
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'Library', groups: ['library.user'] } },
});
export const modules = [base, library];
`;
}

const run = async (...args: string[]) => {
  const out: string[] = [];
  const code = await runCli(args, (t) => out.push(t), { cwd: dir });
  return { code, text: out.join('') };
};

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:18').start();
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, '.env'), `DATABASE_URL=${pg.getConnectionUri()}\n`);
  await writeFile(
    join(dir, 'src', 'v1.ts'),
    moduleFile('0.1.0', false, [
      ['book_a', 'Gitanjali'],
      ['book_b', 'Gora'],
    ]),
  );
  await writeFile(
    join(dir, 'src', 'v2.ts'),
    moduleFile('0.2.0', true, [['book_a', 'Gitanjali (2nd ed.)']]),
  );
  await writeFile(
    join(dir, 'src', 'v3.ts'),
    moduleFile('0.2.0', false, [['book_a', 'Gitanjali (2nd ed.)']]),
  );
}, 180_000);

afterAll(async () => {
  await pg?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('migrate, seed, upgrade with a data migration, status, and the destructive guard', async () => {
  // A fresh database: the first file, no company yet (seed data waits for kosh init).
  const first = await run('migrate', '--modules', './src/v1.ts', '--name', 'init');
  expect(first.code, first.text).toBe(0);
  expect(first.text).toMatch(/Planned \d+ change\(s\) in .*0001_init\.sql/);
  expect(first.text).toContain('module library: new → 0.1.0');
  expect(first.text).toContain('No company yet');

  const { createServer } = await import('@kosh/server');
  process.env['KOSH_SCHEDULES'] = 'off';
  const db = await createServer({ databaseUrl: pg.getConnectionUri(), modules: [], logger: false });
  const q = (text: string) => db.driver.query<Record<string, unknown>>({ text, params: [] });
  try {
    await q("INSERT INTO res_currency (name) VALUES ('BDT')");
    await q("INSERT INTO res_company (name, currency_id) VALUES ('Co', 1)");

    const seeded = await run('seed', '--modules', './src/v1.ts', 'library');
    expect(seeded.code, seeded.text).toBe(0);
    expect(seeded.text).toContain(
      'library          2 created, 0 updated, 0 unchanged, 0 kept, 0 deleted',
    );
    expect((await q('SELECT title FROM library_book ORDER BY id')).map((r) => r['title'])).toEqual([
      'Gitanjali',
      'Gora',
    ]);
    expect((await run('seed', '--modules', './src/v1.ts', 'nope')).text).toContain(
      'Not installed: nope',
    );

    // 0.2.0: a new column (a new file), the data migration once, seed data updated and the removed record deleted.
    const upgrade = await run('migrate', '--modules', './src/v2.ts');
    expect(upgrade.code, upgrade.text).toBe(0);
    expect(upgrade.text).toMatch(/0002_update\.sql/);
    expect(upgrade.text).toContain('module library: 0.1.0 → 0.2.0');
    expect(upgrade.text).toContain('data migration library@0.2.0');
    expect(upgrade.text).toContain(
      'library          0 created, 1 updated, 0 unchanged, 0 kept, 1 deleted',
    );
    expect(await q('SELECT title, code FROM library_book')).toEqual([
      { title: 'Gitanjali (2nd ed.)', code: 'C-1' },
    ]);

    const again = await run('migrate', '--modules', './src/v2.ts');
    expect(again.text).toContain('no new migration');
    expect(again.text).toContain('Applied 0 migration file(s)');
    expect(again.text).not.toContain('data migration'); // once

    const status = await run('migrate', 'status', '--modules', './src/v2.ts');
    expect(status.text).toContain('Applied (2):\n  0001_init\n  0002_update');
    expect(status.text).toContain('Pending (0):');

    // Users: created with roles, signed in with that password, password reset; unknown roles refused.
    const created = await run(
      'user',
      'create',
      'clerk',
      '--modules',
      './src/v2.ts',
      '--name',
      'Rina Clerk',
      '--roles',
      'library.user',
      '--password',
      'clerk password 1',
    );
    expect(created.code, created.text).toBe(0);
    expect(
      (
        await run(
          'user',
          'create',
          'clerk',
          '--modules',
          './src/v2.ts',
          '--password',
          'clerk password 1',
        )
      ).text,
    ).toContain('exists already');
    expect(
      (
        await run(
          'user',
          'create',
          'x',
          '--modules',
          './src/v2.ts',
          '--roles',
          'nope.user',
          '--password',
          'clerk password 1',
        )
      ).text,
    ).toContain('Unknown role(s): nope.user');
    expect(
      (
        await run(
          'user',
          'password',
          'clerk',
          '--modules',
          './src/v2.ts',
          '--password',
          'clerk password 2',
        )
      ).code,
    ).toBe(0);
    const app = await createServer({
      databaseUrl: pg.getConnectionUri(),
      modules: [(await import(`./${join(`.work-${process.pid}`, 'src', 'v2.ts')}`)).library],
      logger: false,
    });
    try {
      const login = (password: string) =>
        app.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { login: 'clerk', password },
        });
      expect((await login('clerk password 1')).statusCode).toBe(401);
      expect((await login('clerk password 2')).statusCode).toBe(200);
      expect(
        await q(
          'SELECT "group" FROM auth_user_group g JOIN res_users u ON u.id = g.user_id WHERE u.login = \'clerk\'',
        ),
      ).toEqual([{ group: 'library.user' }]);
    } finally {
      await app.close();
    }

    // Dropping the column needs --allow-destructive; the planned file waits for review.
    const refused = await run('migrate', '--modules', './src/v3.ts');
    expect(refused.code).toBe(1);
    expect(refused.text).toContain('destructive:');
    expect(refused.text).toContain('kosh migrate --allow-destructive');
    const allowed = await run('migrate', '--modules', './src/v3.ts', '--allow-destructive');
    expect(allowed.code, allowed.text).toBe(0);
    expect(allowed.text).toContain('0003_update.sql');
    expect(await readdir(join(dir, 'migrations'))).toEqual([
      '0001_init.sql',
      '0002_update.sql',
      '0003_update.sql',
    ]);
  } finally {
    await db.close();
  }
}, 240_000);

test('module create: the files and the modules list; invalid names are refused', async () => {
  const project = join(dir, 'scaffold');
  await mkdir(join(project, 'src'), { recursive: true });
  await writeFile(
    join(project, 'src', 'modules.ts'),
    "import { base } from 'kosh-erp';\nimport { messaging } from 'kosh-erp/messaging';\n\nexport const modules = [base, messaging];\n",
  );
  const out: string[] = [];
  expect(
    await runCli(['module', 'create', 'fleet-care'], (t) => out.push(t), { cwd: project }),
  ).toBe(0);
  for (const f of ['models.ts', 'data.ts', 'migrations.ts', 'index.ts'])
    expect(existsSync(join(project, 'src', 'modules', 'fleet-care', f)), f).toBe(true);
  const { readFile } = await import('node:fs/promises');
  const list = await readFile(join(project, 'src', 'modules.ts'), 'utf8');
  expect(list).toContain("import { fleetCare } from './modules/fleet-care/index.ts';");
  expect(list).toContain('export const modules = [base, messaging, fleetCare];');
  const index = await readFile(join(project, 'src', 'modules', 'fleet-care', 'index.ts'), 'utf8');
  expect(index).toContain("name: 'fleet-care'");
  expect(index).toContain("'fleet-care.item.list': list(Item");
  expect(await runCli(['module', 'create', 'fleet-care'], () => {}, { cwd: project })).toBe(1);
  expect(await runCli(['module', 'create', 'Base'], () => {}, { cwd: project })).toBe(2);
  expect(await runCli(['module', 'create', 'base'], () => {}, { cwd: project })).toBe(2);
});
