/**
 * Projects with Accounting on real PostgreSQL (RFC 0026 step 4): a project's cost centre is made when its figures are
 * first refreshed, once; a posted bill on it is booked, a draft one is not; beyond the budget the project is off
 * track; nothing is committed without Purchase.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { projectAccount } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, projectAccount];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const ids: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(method: 'GET' | 'POST' | 'PATCH', url: string, as: string, payload?: unknown) {
  let token = tokens.get(as);
  if (token === undefined) {
    const login = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    token = (login.json() as { token: string }).token;
    tokens.set(as, token);
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
const expectStatus = (r: { status: number; json: Json }, status: number) =>
  expect(r.status, JSON.stringify(r.json)).toBe(status);

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-project-account-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'project_account'] },
      dir,
    }),
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
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  for (const [login, groups] of [
    ['pia', ['account.manager', 'project.manager']],
    ['bob', ['account.user', 'project.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  expectStatus(
    await call('POST', '/api/v1/accounting/charts/install', 'pia', { template: 'generic' }),
    200,
  );
  for (const a of (await call('GET', '/api/v1/models/account.account?fields=code&limit=200', 'pia'))
    .json.items as Json[])
    ids[`acc${a.code}`] = a.id;
  for (const j of (await call('GET', '/api/v1/models/account.journal?fields=code', 'pia')).json
    .items as Json[])
    ids[`j${j.code}`] = j.id;
  ids['bdt'] = (
    await call('GET', '/api/v1/models/res.currency?fields=name', 'pia')
  ).json.items.find((c: Json) => c.name === 'BDT').id;
  ids['vendor'] = (
    await call('POST', '/api/v1/models/res.partner', 'pia', { name: 'Brick Co', isVendor: true })
  ).json.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('a cost centre made once; a posted bill booked, a draft not; beyond the budget off track', async () => {
  const p = await call('POST', '/api/v1/models/project.project', 'pia', {
    name: 'Hatchery 4',
    budgetLines: { create: [{ name: 'Building', category: 'materials', planned: '20000' }] },
  });
  expectStatus(p, 201);
  const refresh = async () =>
    expectStatus(
      await call('POST', '/api/v1/projects/refresh', 'pia', { projects: [p.json.id] }),
      200,
    );
  const figures = async () =>
    (
      await call(
        'GET',
        `/api/v1/models/project.project/${p.json.id}?fields=analytic,bookedCost,committedCost,variance,health`,
        'pia',
      )
    ).json;
  await refresh();
  const analytic = (await figures()).analytic as number;
  expect(analytic).toEqual(expect.any(Number));
  await refresh();
  expect((await figures()).analytic).toBe(analytic);
  const bill = async (price: string) => {
    const made = await call('POST', '/api/v1/models/account.move', 'pia', {
      kind: 'in_invoice',
      journal: ids['jBILL'],
      partner: ids['vendor'],
      currency: ids['bdt'],
      lines: {
        create: [
          {
            lineKind: 'product',
            name: 'Cement',
            quantity: '1',
            priceUnit: price,
            account: ids['acc6300'],
            analytic,
          },
        ],
      },
    });
    expectStatus(made, 201);
    return made.json.id as number;
  };
  const posted = await bill('25000.00');
  await bill('5000.00'); // a draft: not booked
  for (const t of ['submit', 'post'])
    expectStatus(
      await call('POST', `/api/v1/models/account.move/${posted}/transitions/${t}`, 'pia'),
      200,
    );
  await refresh();
  const now = await figures();
  expect(Number(now.bookedCost)).toBe(25000);
  expect(Number(now.committedCost)).toBe(0);
  expect(Number(now.variance)).toBe(-5000);
  expect(now.health).toBe('off_track');
});
