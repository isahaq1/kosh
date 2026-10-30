/**
 * Asset Care on real PostgreSQL through the HTTP API (RFC 0021): meters count up; a plan by meter makes its order
 * once the meter passes its interval, with its checklist, once; the checklist is ticked before the order is done,
 * which moves the plan on; a plan by time makes its order within the lead time (the setting); a breakdown puts the
 * equipment down until it is done; reliability (failures, downtime, MTTR, MTBF, availability); access; the demo.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import {
  type AppHost,
  applyApps,
  base,
  createAppHost,
  installBase,
  installDemo,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { maintenance } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, contacts, messaging, maintenance];
const R = '/api/v1/models/maintenance.request';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const ids: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  as: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
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
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}
const find = async (model: string, filter: unknown, fields: string, as = 'maria') =>
  (
    await call(
      'GET',
      `/api/v1/models/${model}?filter=${encodeURIComponent(JSON.stringify(filter))}&fields=${fields}&order=id+asc`,
      as,
    )
  ).json.items as Json[];
const runPlans = () => call('POST', '/api/v1/assetcare/plans/run', 'maria');
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-maintenance-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'maintenance'] },
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
  for (const [login, groups] of [
    ['maria', ['maintenance.manager']],
    ['rahim', ['maintenance.user']],
    ['bob', ['base.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  const generator = await call('POST', '/api/v1/models/maintenance.equipment', 'maria', {
    name: 'Generator',
    code: 'GEN-T1',
    meters: { create: [{ name: 'Running hours', unit: 'h' }] },
  });
  expect(generator.status, JSON.stringify(generator.json)).toBe(201);
  ids['generator'] = generator.json.id;
  ids['meter'] = (await find('maintenance.meter', { equipment: ids['generator'] }, 'id'))[0].id;
  ids['forklift'] = (
    await call('POST', '/api/v1/models/maintenance.equipment', 'maria', { name: 'Forklift' })
  ).json.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('meters count up: a reading is never below an earlier one', async () => {
  const read = (value: string, date: string) =>
    call('POST', '/api/v1/models/maintenance.meter.reading', 'rahim', {
      meter: ids['meter'],
      value,
      date,
    });
  expect((await read('100', `${day(-2)}T08:00:00Z`)).status).toBe(201);
  expect((await read('90', `${day(-1)}T08:00:00Z`)).status).toBe(422);
  expect((await read('120', `${day(-1)}T08:00:00Z`)).status).toBe(201);
  expect(
    (await call('GET', `/api/v1/models/maintenance.meter/${ids['meter']}`, 'rahim')).json.value,
  ).toBe('120');
});

test('a plan by meter: its order once the meter passes, with its checklist, once; done moves it on', async () => {
  const plan = await call('POST', '/api/v1/models/maintenance.plan', 'maria', {
    name: '250-hour service',
    equipment: ids['generator'],
    trigger: 'meter',
    meter: ids['meter'],
    intervalValue: '250',
    tasks: { create: [{ name: 'Oil and filter' }, { name: 'Belts' }] },
  });
  expect(plan.status, JSON.stringify(plan.json)).toBe(201);
  expect((await runPlans()).json.made).toBe(0); // 120 < 250
  await call('POST', '/api/v1/models/maintenance.meter.reading', 'rahim', {
    meter: ids['meter'],
    value: '262',
  });
  expect((await runPlans()).json.made).toBe(1);
  expect((await runPlans()).json.made).toBe(0); // once: it has an open order
  const [order] = await find(
    'maintenance.request',
    { plan: plan.json.id },
    'kind,downtime,state',
    'rahim',
  );
  expect(order).toMatchObject({ kind: 'preventive', downtime: false, state: 'new' });
  const tasks = await find('maintenance.request.task', { request: order.id }, 'name,done', 'rahim');
  expect(tasks.map((t) => t.name)).toEqual(['Oil and filter', 'Belts']);

  expect((await call('POST', `${R}/${order.id}/transitions/start`, 'rahim')).status).toBe(200);
  const early = await call('POST', `${R}/${order.id}/transitions/finish`, 'rahim');
  expect(early.status).toBe(409);
  expect(JSON.stringify(early.json)).toContain('Tick every item');
  for (const t of tasks)
    await call('PATCH', `/api/v1/models/maintenance.request.task/${t.id}`, 'rahim', { done: true });
  expect((await call('POST', `${R}/${order.id}/transitions/finish`, 'rahim')).status).toBe(200);
  const moved = (await call('GET', `/api/v1/models/maintenance.plan/${plan.json.id}`, 'maria'))
    .json;
  expect(moved.lastDoneValue).toBe('262');
  expect(moved.lastDoneDate).toBe(day(0));
  expect((await runPlans()).json.made).toBe(0); // next at 512
});

test('a plan by time: its order within the lead time (the setting)', async () => {
  const plan = (start: number) =>
    call('POST', '/api/v1/models/maintenance.plan', 'maria', {
      name: `Inspection ${start}`,
      equipment: ids['forklift'],
      trigger: 'time',
      intervalDays: 30,
      startDate: day(start),
    });
  const soon = (await plan(5)).json.id;
  expect((await runPlans()).json.made).toBe(1); // 5 days ≤ 7
  const [order] = await find('maintenance.request', { plan: soon }, 'scheduledDate', 'maria');
  expect(order.scheduledDate).toBe(day(5));
  expect(
    (
      await call('PATCH', '/api/v1/settings/app-settings/maintenance/plans', 'maria', {
        values: { leadDays: 2 },
      })
    ).status,
  ).toBe(200);
  await plan(5);
  expect((await runPlans()).json.made).toBe(0); // 5 days > 2
  const invalid = await call('POST', '/api/v1/models/maintenance.plan', 'maria', {
    name: 'No interval',
    equipment: ids['forklift'],
    trigger: 'time',
  });
  expect(invalid.status).toBe(422);
});

test('a breakdown puts the equipment down until it is done; reliability', async () => {
  const reported = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const breakdown = await call('POST', R, 'rahim', {
    equipment: ids['forklift'],
    kind: 'breakdown',
    description: 'Hydraulic leak',
    reportedAt: reported,
  });
  expect(breakdown.status, JSON.stringify(breakdown.json)).toBe(201);
  const status = async () =>
    (await call('GET', `/api/v1/models/maintenance.equipment/${ids['forklift']}`, 'rahim')).json
      .status;
  expect(await status()).toBe('down');
  await call('POST', `${R}/${breakdown.json.id}/transitions/start`, 'rahim');
  await call('POST', `${R}/${breakdown.json.id}/transitions/finish`, 'rahim');
  expect(await status()).toBe('operational');
  const done = (await call('GET', `${R}/${breakdown.json.id}`, 'rahim')).json;
  expect(Number(done.downtimeHours)).toBeCloseTo(3, 1);

  const report = await call(
    'GET',
    `/api/v1/assetcare/reliability?from=${day(-1)}&to=${day(1)}`,
    'rahim',
  );
  expect(report.status, JSON.stringify(report.json)).toBe(200);
  const forklift = (report.json.equipment as Json[]).find((e) => e.id === ids['forklift']);
  expect(forklift.failures).toBe(1);
  expect(Number(forklift.mttrHours)).toBeCloseTo(3, 1);
  expect(Number(forklift.mtbfHours)).toBeCloseTo(72 - 3, 1); // three days less the downtime
  expect(Number(forklift.availability)).toBeCloseTo(((72 - 3) / 72) * 100, 1);
  const generator = (report.json.equipment as Json[]).find((e) => e.id === ids['generator']);
  expect(generator).toMatchObject({ failures: 0, mttrHours: null, availability: '100.00' });
});

test('access: technicians do not change equipment or run plans; others see nothing', async () => {
  expect(
    (await call('POST', '/api/v1/models/maintenance.equipment', 'rahim', { name: 'X' })).status,
  ).toBe(403);
  expect((await call('POST', '/api/v1/assetcare/plans/run', 'rahim')).status).toBe(403);
  expect((await call('GET', R, 'bob')).status).toBe(403);
});

test('the demo data loads', async () => {
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const summary = await installDemo({
    shutro: host.server.shutro,
    auth,
    driver,
    modules: host.server.registry.loaded.modules,
    company,
  });
  expect(JSON.stringify(summary)).toContain('Asset Care');
});
