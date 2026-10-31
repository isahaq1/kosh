/**
 * Pipeline on real PostgreSQL through the HTTP API (RFC 0021): salespeople see their own and unassigned deals,
 * managers all; a stage brings its probability and the weighted revenue follows; a stage's required fields are
 * enforced; a deal is won by its stage and lost with a reason (unless App settings switch it off), then reopened;
 * duplicates are found by email, phone or company; the demo data loads.
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
  installDemo,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { crm } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, crm];
const D = '/api/v1/models/crm.deal';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const users: Record<string, number> = {};
const stages: Record<string, number> = {};
const reasons: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
const names = async (as: string) =>
  ((await call('GET', `${D}?fields=name&order=name+asc`, as)).json.items as Json[]).map(
    (d) => d.name,
  );

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-crm-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'crm'] }, dir }),
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
    ['maria', ['crm.manager']],
    ['rahim', ['crm.user']],
    ['sumi', ['crm.user']],
    ['bob', ['base.user']],
  ] as const)
    users[login] = await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  for (const s of (await call('GET', '/api/v1/models/crm.stage?fields=name', 'maria')).json
    .items as Json[])
    stages[s.name] = s.id;
  for (const r of (await call('GET', '/api/v1/models/crm.lost.reason?fields=name', 'maria')).json
    .items as Json[])
    reasons[r.name] = r.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('own and unassigned deals for salespeople, all for managers; outsiders refused', async () => {
  expect(
    (await call('POST', D, 'rahim', { name: 'Rahim deal', stage: stages['New'] })).status,
  ).toBe(201);
  expect((await call('POST', D, 'sumi', { name: 'Sumi deal', stage: stages['New'] })).status).toBe(
    201,
  );
  expect(
    (await call('POST', D, 'maria', { name: 'Nobody’s deal', salesperson: null })).status,
  ).toBe(201);
  expect(await names('rahim')).toEqual(['Nobody’s deal', 'Rahim deal']);
  expect(await names('maria')).toEqual(['Nobody’s deal', 'Rahim deal', 'Sumi deal']);
  expect((await call('GET', D, 'bob')).status).toBe(403);
});

test('the stage brings its probability; weighted revenue; a stage’s required fields are enforced', async () => {
  const made = await call('POST', D, 'rahim', {
    name: 'Bengal Steel supply',
    stage: stages['New'],
  });
  const id = made.json.id as number;
  const onchange = await call('POST', `${D}/onchange`, 'rahim', {
    values: { name: 'Bengal Steel supply', stage: stages['Proposal'] },
    changed: ['stage'],
  });
  expect(onchange.json.values.probability).toBe(60);

  // Proposal needs the expected revenue and close date.
  const refused = await call('PATCH', `${D}/${id}`, 'rahim', {
    stage: stages['Proposal'],
    probability: 60,
  });
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.json)).toContain('needs more details');
  const moved = await call('PATCH', `${D}/${id}`, 'rahim', {
    stage: stages['Proposal'],
    probability: 60,
    expectedRevenue: '1250000',
    closeDate: '2026-12-15',
  });
  expect(moved.status, JSON.stringify(moved.json)).toBe(200);
  const read = (await call('GET', `${D}/${id}?fields=weightedRevenue,status`, 'rahim')).json;
  expect(read.weightedRevenue).toBe('750000'); // 1 250 000 × 60 %, exact
  expect(read.status).toBe('open');

  const won = await call('PATCH', `${D}/${id}`, 'rahim', {
    stage: stages['Won'],
    probability: 100,
  });
  expect(won.status).toBe(200);
  expect((await call('GET', `${D}/${id}?fields=status`, 'rahim')).json.status).toBe('won');
});

test('lost with a reason (unless switched off), reopened; duplicates by email, phone or company', async () => {
  const id = (
    await call('POST', D, 'rahim', {
      name: 'Printers',
      companyName: 'Rupsha Ltd',
      email: 'buyer@rupsha.example',
      phone: '+880 1711-000111',
    })
  ).json.id as number;
  expect((await call('POST', `/api/v1/pipeline/deals/${id}/lose`, 'rahim', {})).status).toBe(422);
  const lost = await call('POST', `/api/v1/pipeline/deals/${id}/lose`, 'rahim', {
    reason: reasons['Too expensive'],
  });
  expect(lost.status, JSON.stringify(lost.json)).toBe(200);
  expect((await call('GET', `${D}/${id}?fields=status`, 'rahim')).json.status).toBe('lost');
  expect((await call('POST', `/api/v1/pipeline/deals/${id}/reopen`, 'rahim')).status).toBe(200);
  expect((await call('GET', `${D}/${id}?fields=status`, 'rahim')).json.status).toBe('open');

  // Switched off in App settings: no reason needed.
  expect(
    (
      await call('PATCH', '/api/v1/settings/app-settings/crm/deals', 'maria', {
        values: { requireLostReason: false },
      })
    ).status,
  ).toBe(200);
  expect((await call('POST', `/api/v1/pipeline/deals/${id}/lose`, 'rahim', {})).status).toBe(200);
  await call('POST', `/api/v1/pipeline/deals/${id}/reopen`, 'rahim');

  const twin = await call('POST', D, 'rahim', { name: 'Toner', phone: '01711000111' });
  expect(twin.status).toBe(201);
  await call('POST', '/api/v1/models/res.partner', 'maria', {
    name: 'Rupsha Ltd',
    email: 'buyer@rupsha.example',
  });
  const dupes = await call('GET', `/api/v1/pipeline/deals/${id}/duplicates`, 'rahim');
  expect(dupes.status, JSON.stringify(dupes.json)).toBe(200);
  expect(dupes.json.deals.map((d: Json) => d.name)).toEqual(['Toner']);
  expect(dupes.json.contacts.map((c: Json) => c.name)).toEqual(['Rupsha Ltd']);
  expect((await call('GET', `/api/v1/pipeline/deals/${id}/duplicates`, 'sumi')).status).toBe(404); // not hers
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
  expect(JSON.stringify(summary)).toContain('Pipeline');
});

test('the Pipeline overview (RFC 0022 step 2) is served to a manager', async () => {
  const overview = await call('GET', '/api/v1/reports/overview?app=pipeline', 'maria');
  expect(overview.status, JSON.stringify(overview.json)).toBe(200);
  expect(overview.json.cards.map((c: { id: string }) => c.id)).toContain('forecast');
});
