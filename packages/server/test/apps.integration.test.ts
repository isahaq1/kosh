/**
 * The App manager's engine on real PostgreSQL (RFC 0008): installs bring dependencies, data and postInstall hooks in
 * one transaction; a failing install leaves nothing (tables, rows, migration file); disable keeps tables and data
 * and takes dependents along; enable brings dependencies back; disabling an extension with required columns and
 * applying a stale plan are refused.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineModule as defineKoshModule, type KoshModule } from '@kosh/modules-sdk';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  APPS_LOG_TABLE,
  applyApps,
  installedModules,
  prepareApps,
  readInstalledApps,
  recordInstalledApps,
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
