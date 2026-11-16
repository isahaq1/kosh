/**
 * Rehearsed backups (RFC 0034 step 2): `shutro-erp backup` writes a dump with a manifest measured in the dump's own
 * snapshot, `shutro-erp backup verify` restores it into a scratch database and compares, records the result, and
 * `shutro-erp doctor` reads it; a backup that does not restore as recorded fails verification and doctor.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestDatabase, testDatabase } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { latestBackup } from '../src/backup.js';
import { runCli } from '../src/index.js';

let pg: TestDatabase;
const dir = join(import.meta.dirname, `.work-backup-${process.pid}`);

const run = async (...args: string[]) => {
  const out: string[] = [];
  const code = await runCli(args, (t) => out.push(t), { cwd: dir });
  return { code, text: out.join('') };
};
const line = (text: string, check: string): string =>
  text.split('\n').find((l) => l.slice(2).trimStart().split(' ')[0] === check) ?? '';

beforeAll(async () => {
  pg = await testDatabase();
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, '.env'), `DATABASE_URL=${pg.getConnectionUri()}\n`);
  await writeFile(
    join(dir, 'src', 'modules.ts'),
    "import { base } from '@kosh/server';\nexport const modules = [base];\n",
  );
  const migrated = await run('migrate');
  expect(migrated.code, migrated.text).toBe(0);
}, 240_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await pg?.stop();
});

test('a backup with its manifest, verified by a restore, and doctor says so', async () => {
  const before = await run('doctor');
  expect(line(before.text, 'backups')).toMatch(/^▲ backups\s+no verified backup recorded/);

  const made = await run('backup');
  expect(made.code, made.text).toBe(0);
  expect(made.text).toMatch(/✔ backups[\\/].+\.dump: \d+ tables, \d+ rows/);
  const file = latestBackup(join(dir, 'backups'));
  expect(file).not.toBeNull();
  const manifest = JSON.parse(await readFile(`${file}.json`, 'utf8')) as {
    rows: Record<string, number>;
  };
  expect(Object.keys(manifest.rows).length).toBeGreaterThan(5);

  const verified = await run('backup', 'verify');
  expect(verified.code, verified.text).toBe(0);
  expect(verified.text).toMatch(/✔ .+\.dump: restored and checked/);

  const after = await run('doctor');
  expect(line(after.text, 'backups'), after.text).toMatch(/^✔ backups\s+verified today/);
}, 240_000);

test('a backup that does not restore as recorded fails, and doctor fails with it', async () => {
  const file = latestBackup(join(dir, 'backups'));
  if (file === null) throw new Error('the first test made a backup');
  const manifest = JSON.parse(await readFile(`${file}.json`, 'utf8')) as {
    rows: Record<string, number>;
  };
  const table = Object.keys(manifest.rows)[0] ?? '';
  manifest.rows[table] = (manifest.rows[table] ?? 0) + 1;
  await writeFile(`${file}.json`, JSON.stringify(manifest));

  const verified = await run('backup', 'verify');
  expect(verified.code).toBe(1);
  expect(verified.text).toContain(`table ${table}:`);
  // The scratch database is gone.
  expect((await readdir(join(dir, 'backups'))).length).toBe(2);

  const after = await run('doctor');
  expect(line(after.text, 'backups'), after.text).toMatch(/^✖ backups\s+the last backup verified/);
}, 240_000);
