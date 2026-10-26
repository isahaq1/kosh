/**
 * The App manager's engine on real PostgreSQL (RFC 0008): installs bring dependencies, data and postInstall hooks in
 * one transaction; a failing install leaves nothing (tables, rows, migration file); disable keeps tables and data
 * and takes dependents along; enable brings dependencies back; disabling an extension with required columns and
 * applying a stale plan are refused.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineModule as defineKoshModule, type KoshModule } from '@kosh/modules-sdk';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  APPS_CHANNEL,
  APPS_LOG_TABLE,
  applyApps,
  appsDigest,
  appTableStatements,
  installedModules,
  prepareApps,
  readInstalledApps,
  recordInstalledApps,
  restoreAppMigrations,
} from '../src/apps.js';
import { base, baseShutro } from '../src/auth/base.js';
import { type Driver, orm, pg } from '../src/orm.js';

const { defineGroup, defineModel, defineModule, extendModel, f, record } = orm;

type Env = { model(name: string): { create(values: unknown[]): Promise<unknown> } };

/** A Kosh module around a Shutro module with one group `<name>.user`. */
function app(
  shutro: ReturnType<typeof defineModule>,
  depends: KoshModule[] = [],
  hooks?: KoshModule['hooks'],
): KoshModule {
  return defineKoshModule({
    shutro,
    kosh: '^0.1.0',
    depends,
    accessLevels: { user: { label: 'User', groups: [`${shutro.name}.user`] } },
    ...(hooks === undefined ? {} : { hooks }),
  });
}
const group = (name: string) => defineGroup({ code: `${name}.user`, label: name });

const sLibrary = defineModule({
  name: 'library',
  version: '1.0.0',
  depends: [baseShutro],
  groups: [group('library')],
  models: [
    defineModel('library.book', {
      access: { 'library.user': ['read'] },
      fields: { title: f.char({ required: true }) },
    }),
  ],
  data: [record('library.book', 'book_welcome', { title: 'Welcome' })],
});
const sShelf = defineModule({
  name: 'shelf',
  version: '1.0.0',
  depends: [sLibrary],
  groups: [group('shelf')],
  models: [
    defineModel('library.shelf', {
      access: { 'shelf.user': ['read'] },
      fields: { code: f.char({ required: true }) },
    }),
  ],
});
const sTags = defineModule({
  name: 'tags',
  version: '1.0.0',
  depends: [sLibrary],
  groups: [group('tags')],
  models: [],
  extensions: [extendModel('library.book', { fields: { tag: f.char() } })],
});
const sCatalog = defineModule({
  name: 'catalog',
  version: '1.0.0',
  depends: [baseShutro],
  groups: [group('catalog')],
  models: [
    defineModel('catalog.item', {
      access: { 'catalog.user': ['read'] },
      fields: { name: f.char({ required: true }) },
    }),
  ],
});
const sCatalogExtra = defineModule({
  name: 'catalog_extra',
  version: '1.0.0',
  depends: [sCatalog],
  groups: [group('catalog_extra')],
  models: [],
  extensions: [
    extendModel('catalog.item', {
      fields: { sku: f.char({ required: true, default: () => 'NEW' }) },
    }),
  ],
});
const sBroken = defineModule({
  name: 'broken',
  version: '1.0.0',
  depends: [baseShutro],
  groups: [group('broken')],
  models: [
    defineModel('broken.thing', {
      access: { 'broken.user': ['read'] },
      fields: { name: f.char() },
    }),
  ],
});

const library = app(sLibrary, [base]);
const shelf = app(sShelf, [library], {
  async postInstall(env) {
    await (env as Env).model('library.shelf').create([{ code: 'A1' }]);
  },
});
const tags = app(sTags, [library]);
const catalog = app(sCatalog, [base]);
const catalogExtra = app(sCatalogExtra, [catalog]);
const broken = app(sBroken, [base], {
  async postInstall() {
    throw new Error('postInstall failed on purpose');
  },
});
const catalogue = [base, library, shelf, tags, catalog, catalogExtra, broken];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;

const count = async (sql: string) =>
  Number((await driver.query<{ n: string }>({ text: sql, params: [] }))[0]?.n ?? 0);
const exists = async (table: string) =>
  (
    await driver.query<{ found: string | null }>({
      text: 'SELECT to_regclass($1)::text AS found',
      params: [`public.${table}`],
    })
  )[0]?.found !== null;
const change = async (c: Parameters<typeof prepareApps>[0]['change']) => {
  const prepared = await prepareApps({ driver, catalogue, change: c, dir });
  return { prepared, result: await applyApps(prepared, { driver, dir, actor: 'test' }) };
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-apps-'));
  await recordInstalledApps(driver, [], [], 'test'); // a database with nothing installed yet
  await change({ install: ['base'] });
}, 120_000);

afterAll(async () => {
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('install brings dependencies, their data and postInstall, in one change', async () => {
  const { prepared, result } = await change({ install: ['shelf'] });
  expect(prepared.plan.install).toEqual([
    { name: 'library', reason: 'dependency' },
    { name: 'shelf', reason: 'selected' },
  ]);
  expect(result.migration).not.toBeNull();
  expect(await count('SELECT count(*)::text AS n FROM library_book')).toBe(1); // seed data
  expect(await count('SELECT count(*)::text AS n FROM library_shelf')).toBe(1); // postInstall
  expect((await readInstalledApps(driver))?.slice(1)).toEqual([
    { name: 'library', version: '1.0.0', state: 'installed', reason: 'dependency' },
    { name: 'shelf', version: '1.0.0', state: 'installed', reason: 'selected' },
  ]);
  expect(await count(`SELECT count(*)::text AS n FROM ${APPS_LOG_TABLE}`)).toBe(2); // base, then this change
  expect((await installedModules(driver, catalogue)).map((m) => m.name)).toEqual([
    'base',
    'library',
    'shelf',
  ]);
});

test('a failing install leaves nothing behind', async () => {
  const files = await readdir(dir);
  const ledger = await count('SELECT count(*)::text AS n FROM shutro_migration');
  await expect(change({ install: ['broken'] })).rejects.toThrow('postInstall failed on purpose');
  expect(await exists('broken_thing')).toBe(false);
  expect((await readInstalledApps(driver))?.map((r) => r.name)).toEqual([
    'base',
    'library',
    'shelf',
  ]);
  expect(await readdir(dir)).toEqual(files); // the migration file is removed again
  expect(await count('SELECT count(*)::text AS n FROM shutro_migration')).toBe(ledger);
});

test('disable keeps tables and data and takes dependents along; enable brings them back', async () => {
  await change({ install: ['tags'] });
  const { prepared } = await change({ disable: ['library'] });
  expect(prepared.migration.statements).toEqual([]); // nothing dropped
  expect(prepared.plan.disable.map((d) => [d.name, d.cascade])).toEqual([
    ['tags', true],
    ['shelf', true],
    ['library', false],
  ]);
  expect((await installedModules(driver, catalogue)).map((m) => m.name)).toEqual(['base']);
  expect(await count('SELECT count(*)::text AS n FROM library_book')).toBe(1);
  // The schema still matches: the disabled modules' tables and columns are kept.
  const again = await prepareApps({ driver, catalogue, change: {}, dir });
  expect(again.empty).toBe(true);

  const { prepared: enabled } = await change({ enable: ['shelf'] });
  expect(enabled.plan.enable).toEqual(['library', 'shelf']);
  expect((await installedModules(driver, catalogue)).map((m) => m.name)).toEqual([
    'base',
    'library',
    'shelf',
  ]);
  expect(await count('SELECT count(*)::text AS n FROM library_shelf')).toBe(1); // the data is still there
});

test('disabling an extension whose required columns stay behind is refused', async () => {
  await change({ install: ['catalog_extra'] });
  await expect(
    prepareApps({ driver, catalogue, change: { disable: ['catalog_extra'] }, dir }),
  ).rejects.toThrow(/required fields that no enabled module fills: catalog\.item\.sku/);
  // Disabling both is fine: nothing serves catalog.item any more.
  await change({ disable: ['catalog'] });
  expect(
    (await readInstalledApps(driver))?.filter((r) => r.state === 'disabled').map((r) => r.name),
  ).toEqual(expect.arrayContaining(['catalog', 'catalog_extra']));
});

test('a plan made before another change is refused', async () => {
  const first = await prepareApps({ driver, catalogue, change: { disable: ['shelf'] }, dir });
  const second = await prepareApps({ driver, catalogue, change: { enable: ['tags'] }, dir });
  await applyApps(first, { driver, dir, actor: 'test' });
  await expect(applyApps(second, { driver, dir, actor: 'test' })).rejects.toThrow(
    /changed since this change was planned/,
  );
});

test('a committed change notifies every listener with the new digest', async () => {
  const heard: string[] = [];
  const stop = await driver.listen(APPS_CHANNEL, (payload) => heard.push(payload));
  try {
    await change({ enable: ['shelf'] });
    for (let i = 0; i < 50 && heard.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(heard).toEqual([appsDigest((await readInstalledApps(driver)) ?? [])]);
  } finally {
    await stop();
  }
});

test('applied app migrations missing from the folder are restored byte for byte', async () => {
  const files = (await readdir(dir)).sort();
  expect(files.length).toBeGreaterThan(0);
  const before = await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')));
  for (const f of files) await rm(join(dir, f));
  expect((await restoreAppMigrations(driver, dir)).sort()).toEqual(files);
  expect(await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).toEqual(before);
  expect(await restoreAppMigrations(driver, dir)).toEqual([]); // nothing missing any more
  // Planning works on the restored folder (checksums match, no pending file).
  expect((await prepareApps({ driver, catalogue, change: {}, dir })).empty).toBe(true);
});

/** The notes module at a version: 1.1.0 adds `body` and fills it; 2.0.0 drops `legacy`. */
function notesAt(version: '1.0.0' | '1.1.0' | '2.0.0'): KoshModule[] {
  const fields: Record<string, ReturnType<typeof f.char>> = { title: f.char({ required: true }) };
  if (version !== '2.0.0') fields['legacy'] = f.char();
  if (version !== '1.0.0') fields['body'] = f.char();
  const shutro = defineModule({
    name: 'notes',
    version,
    depends: [baseShutro],
    groups: [group('notes')],
    models: [defineModel('notes.note', { access: { 'notes.user': ['read'] }, fields })],
    migrations:
      version === '1.0.0'
        ? []
        : [
            {
              version: '1.1.0',
              description: 'Fill the new body from the title',
              up: async ({ sql }) => {
                await sql`UPDATE notes_note SET body = 'about ' || title WHERE body IS NULL`;
              },
            },
          ],
  });
  return [...catalogue, app(shutro, [base])]; // the rest of the installed set stays in the catalogue
}

test('upgrade: the schema, the data migrations and the version, in one change; data is dropped only when asked', async () => {
  const v1 = notesAt('1.0.0');
  await applyApps(
    await prepareApps({ driver, catalogue: v1, change: { install: ['notes'] }, dir }),
    {
      driver,
      dir,
      actor: 'test',
    },
  );
  await driver.query({
    text: "INSERT INTO notes_note (title, legacy, created_at, updated_at) VALUES ('Beams', 'old', now(), now())",
    params: [],
  });

  // The new code: an app change is refused until the upgrade is asked for (the database is behind the code).
  const v11 = notesAt('1.1.0');
  await expect(prepareApps({ driver, catalogue: v11, change: {}, dir })).rejects.toThrow(
    'does not match',
  );
  const prepared = await prepareApps({
    driver,
    catalogue: v11,
    change: { upgrade: ['notes'] },
    dir,
  });
  expect(prepared.plan.upgrade).toEqual([{ name: 'notes', from: '1.0.0', to: '1.1.0' }]);
  expect(prepared.migration.statements.map((s) => s.sql).join('\n')).toContain('"body"');
  const result = await applyApps(prepared, { driver, dir, actor: 'test' });
  expect(result.upgraded).toEqual(['notes']);
  expect(await driver.query({ text: 'SELECT title, body FROM notes_note', params: [] })).toEqual([
    { title: 'Beams', body: 'about Beams' },
  ]);
  const installed = (await readInstalledApps(driver))?.find((r) => r.name === 'notes');
  expect(installed?.version).toBe('1.1.0');
  const [log] = await driver.query<{ change: string }>({
    text: `SELECT change::text AS change FROM ${APPS_LOG_TABLE} ORDER BY id DESC LIMIT 1`,
    params: [],
  });
  // Stored as a JSON object (rows written as a JSON string before 2026-10-27 are repaired at the next change).
  const logged = JSON.parse(log?.change ?? '{}') as { upgrade: unknown };
  expect(logged.upgrade).toEqual([{ name: 'notes', from: '1.0.0', to: '1.1.0' }]);

  // Back to older code: refused. The same version again: nothing to do.
  await expect(
    prepareApps({ driver, catalogue: v1, change: { upgrade: ['notes'] }, dir }),
  ).rejects.toThrow('go back');
  const again = await prepareApps({ driver, catalogue: v11, change: { upgrade: ['notes'] }, dir });
  expect(again.empty).toBe(true);

  // 2.0.0 drops a field: refused with what it would drop, unless "remove data".
  const v2 = notesAt('2.0.0');
  await expect(
    prepareApps({ driver, catalogue: v2, change: { upgrade: ['notes'] }, dir }),
  ).rejects.toThrow(/legacy/);
  const removing = await prepareApps({
    driver,
    catalogue: v2,
    change: { upgrade: ['notes'] },
    dir,
    removeData: true,
  });
  expect(removing.allowDestructive).toBe(true);
  await applyApps(removing, { driver, dir, actor: 'test' });
  expect(
    await count(
      "SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'notes_note' AND column_name = 'legacy'",
    ),
  ).toBe(0);
  expect((await readInstalledApps(driver))?.find((r) => r.name === 'notes')?.version).toBe('2.0.0');
});

test('log rows written as a JSON string (before 2026-10-27) are repaired when the tables are prepared', async () => {
  await driver.query({
    text: `INSERT INTO ${APPS_LOG_TABLE} (actor, change, statements, digest) VALUES ('old', to_jsonb($1::text), '', '')`,
    params: ['{"install":[{"name":"legacy","reason":"selected"}]}'],
  });
  for (const statement of appTableStatements()) await driver.query(statement);
  const rows = await driver.query<{ kind: string; change: { install?: unknown } }>({
    text: `SELECT jsonb_typeof(change) AS kind, change FROM ${APPS_LOG_TABLE} WHERE actor = 'old'`,
    params: [],
  });
  expect(rows).toEqual([
    { kind: 'object', change: { install: [{ name: 'legacy', reason: 'selected' }] } },
  ]);
  const strings = await driver.query<{ n: string }>({
    text: `SELECT count(*)::text AS n FROM ${APPS_LOG_TABLE} WHERE jsonb_typeof(change) <> 'object'`,
    params: [],
  });
  expect(strings[0]?.n).toBe('0');
});
