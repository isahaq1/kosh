/**
 * Products on real PostgreSQL (RFC 0022 step 2): the Overview served to a Products user, and the product form's
 * row of tiles, empty until Sales, Purchase or Stockroom fill it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissions } from '@kosh/permissions';
import { reporting } from '@kosh/reporting';
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
import { type Driver, orm, pg } from '@kosh/server/orm';
import { settings } from '@kosh/settings';
import { storage } from '@kosh/storage';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { product } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, storage, permissions, reporting, product];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let token: string | undefined;

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  if (token === undefined) {
    const res = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'sam', password: PASSWORD },
    });
    token = (res.json() as { token: string }).token;
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-product-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'product'] }, dir }),
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
  const { company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  await auth.createUser({
    login: 'sam',
    name: 'Sam',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['product.user'],
  });
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('the Overview (RFC 0022 step 2) to a Products user; the form has a row of tiles for the other apps', async () => {
  const overview = await call('GET', '/api/v1/reports/overview?app=product');
  expect(overview.status, JSON.stringify(overview.json)).toBe(200);
  expect(overview.json.cards.map((c: { id: string }) => c.id)).toEqual([
    'products_all',
    'goods',
    'services',
    'average_price',
    'by_category',
    'priciest',
  ]);
  const form = await call('GET', '/api/v1/views?model=product.product&type=form');
  expect(form.status, JSON.stringify(form.json)).toBe(200);
  const [row] = form.json.view.sheet;
  expect(row).toMatchObject({ kind: 'stats', id: 'related', children: [] });
});
