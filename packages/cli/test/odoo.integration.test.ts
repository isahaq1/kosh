/**
 * The Odoo importer (RFC 0034 §2.3, step 3 part 1) against a real Odoo 18 with its demo data, recorded with
 * `KOSH_CERTIFY=live` and replayed otherwise, into Kosh with Contacts, Products and Accounting on real PostgreSQL:
 * a dry run keeps nothing; the import accounts for every Odoo record read; contacts keep their companies, products
 * their codes, taxes and units, Odoo's accounts link to the installed chart by code; a second run creates nothing.
 *
 * Live: an Odoo 18 at `KOSH_ODOO_URL` (default http://localhost:18069) with a `demo` database of its demo data
 * (Accounting, Sales, Purchase, Inventory), signed in as `admin` (`KOSH_ODOO_PASSWORD`, default the demo's `admin`).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import {
  connectOdoo,
  importFromOdoo,
  type OdooClient,
  type OdooReport,
  reportText,
} from '@kosh/odoo';
import {
  type AppHost,
  applyApps,
  base,
  createAppHost,
  installBase,
  installDefaults,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, type Env, orm, pg } from '@kosh/server/orm';
import { cassette, type TestDatabase, testDatabase } from '@kosh/server/testing';
import { settings } from '@kosh/settings';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';

const url = process.env['KOSH_ODOO_URL'] || 'http://localhost:18069';
const password = process.env['KOSH_ODOO_PASSWORD'] || 'admin';
const tape = cassette(join(import.meta.dirname, 'recordings', 'odoo-18-demo.json'), {
  adapter: 'odoo-18',
  secrets: [password],
});
const catalogue = [base, settings, accounting];

let container: TestDatabase;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let odoo: OdooClient;
/** Azure Interior's id in Odoo. */
let azureId = 0;

// The recording is kept only when every step of the contract ran and passed (not a filtered or failed run).
let total = 0;
let passed = 0;
afterEach((ctx) => {
  if (ctx.task.result?.state === 'pass') passed += 1;
});
/** A step of the contract: in order, never retried (a retry would read Odoo again, out of the recording's order). */
const contract = (name: string, fn: () => Promise<void>) => {
  total += 1;
  return test(name, { retry: 0, timeout: 300_000 }, fn);
};

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await testDatabase();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-odoo-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'accounting'] }, dir }),
    { driver, dir, actor: 'test' },
  );
  host = await createAppHost({
    databaseUrl: container.getConnectionUri(),
    catalogue,
    migrationsDir: dir,
    logger: false,
    listen: false,
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
  });
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  ({ company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: 'correct horse battery' },
  }));
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  odoo = await connectOdoo({ url, db: 'demo', login: 'admin', password, fetch: tape.fetch });
  const [azure] = await odoo.readAll('res.partner', ['name'], {
    domain: [['name', '=', 'Azure Interior']],
  });
  azureId = azure?.id ?? 0;
}, 300_000);

afterAll(async () => {
  tape.save({ failed: passed !== total });
  await host?.close();
  await driver?.end();
  await rm(dir, { recursive: true, force: true });
  await container?.stop();
});

const run = (dryRun: boolean): Promise<OdooReport> =>
  importFromOdoo(host.server.shutro, odoo, { dryRun, company, source: { url, db: 'demo' } });
const step = (report: OdooReport, key: string) => {
  const s = report.steps.find((x) => x.key === key);
  if (s === undefined) throw new Error(`no step ${key}`);
  return s;
};
const read = <T>(fn: (env: Env) => Promise<T>) =>
  host.server.shutro.bootstrap({ reason: 'test', company }, fn);
type Rows = {
  ids: readonly number[];
  length: number;
  load(k: string[]): Promise<Rows>;
  read(k: string[]): Record<string, unknown>[];
};
const search = (env: Env, model: string, where: Record<string, unknown>) =>
  (env.model(model as never) as unknown as { search(q: unknown): Promise<Rows> }).search({ where });

contract(
  'Odoo 18 answers, and the dry run accounts for every record and keeps nothing',
  async () => {
    expect(odoo.major).toBe(18);
    const before = await read(async (env) => (await search(env, 'res.partner', {})).length);
    const report = await run(true);
    expect(report.dryRun).toBe(true);
    expect(reportText(report)).toContain('dry run: nothing was kept');
    for (const s of report.steps) {
      expect(s.status, `${s.key}: ${s.reason ?? ''}`).toBe('done');
      const skipped = Object.values(s.skipped).reduce((a, b) => a + b, 0);
      expect(s.created + s.updated + s.linked + skipped + s.failed.length, s.key).toBe(s.read);
    }
    expect(step(report, 'partners').created, reportText(report)).toBeGreaterThan(10);
    expect(await read(async (env) => (await search(env, 'res.partner', {})).length)).toBe(before);
  },
);

contract(
  'the import: contacts with their companies, products with codes and taxes, accounts with their types',
  async () => {
    const report = await run(false);
    const text = reportText(report);
    expect(report.ok, text).toBe(true);
    expect(step(report, 'partners').created, text).toBeGreaterThan(10);
    expect(step(report, 'products').created, text).toBeGreaterThan(10);
    // Odoo's generic chart has codes Kosh's chart does not: created, each accounted for.
    const accounts = step(report, 'accounts');
    expect(accounts.created + accounts.linked, text).toBe(accounts.read);
    expect(step(report, 'taxes').created + step(report, 'taxes').linked, text).toBe(2);
    expect(step(report, 'units').linked, text).toBeGreaterThan(0);
    // Odoo's own users and company are not contacts.
    expect(step(report, 'partners').skipped['a user or a company of Odoo itself']).toBeGreaterThan(
      0,
    );

    await read(async (env) => {
      const azure = await (await search(env, 'res.partner', { name: 'Azure Interior' })).load([
        'isCompany',
      ]);
      expect(azure.length).toBe(1);
      expect(azure.read(['isCompany'])[0]?.['isCompany']).toBe(true);
      // Its people keep it as their company (the parent, written in the second pass).
      expect((await search(env, 'res.partner', { parent: azure.ids[0] })).length).toBeGreaterThan(
        0,
      );
      const desk = await (await search(env, 'product.product', { code: 'FURN_7800' })).load([
        'name',
        'listPrice',
        'uom',
      ]);
      expect(desk.length).toBe(1);
      const sales = await (await search(env, 'account.account', { code: '400000' })).load(['type']);
      expect(sales.read(['type'])[0]?.['type']).toBe('income');
      // Products keep their taxes: Odoo's 15 % as Kosh's 0.15.
      const taxed = await (await search(env, 'account.tax', { rate: '0.1500', use: 'sale' })).load([
        'name',
      ]);
      expect(taxed.length).toBe(1);
      // Every imported record names its Odoo record.
      const id = Number(await env.refId('res.partner' as never, `odoo.res_partner_${azureId}`));
      expect(azure.ids).toContain(id);
    });
  },
);

contract('a second run finds every record by its Odoo id: nothing is created again', async () => {
  const report = await run(false);
  for (const s of report.steps) expect(s.created, `${s.key}\n${reportText(report)}`).toBe(0);
  expect(step(report, 'partners').updated).toBeGreaterThan(10);
});
