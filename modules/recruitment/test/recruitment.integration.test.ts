/**
 * Hiring on real PostgreSQL through the HTTP API (RFC 0021): one application per email and opening; interviewers see
 * only their own scorecards while the average shows to all; expected salaries for hiring managers only; a refusal
 * says why; hiring is the hire step only — it makes the Workforce employee, moves the applicant to the hired stage
 * and closes a filled opening, for hiring managers, never twice and never beyond the headcount; the demo data loads.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hr } from '@kosh/hr';
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
import { recruitment } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, hr, recruitment];
const A = '/api/v1/models/hiring.applicant';
const S = '/api/v1/models/hiring.scorecard';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let opening: number;
const users: Record<string, number> = {};
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
const apply = (name: string, email: string, at = opening) =>
  call('POST', A, 'rahim', { name, email, opening: at });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-hiring-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'recruitment'] },
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
    ['hana', ['hr.manager']],
    ['dina', ['hiring.manager']],
    ['rahim', ['hiring.user']],
    ['sumi', ['hiring.user']],
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
  opening = (
    await call('POST', '/api/v1/models/hiring.opening', 'dina', {
      name: 'Accountant',
      headcount: 1,
    })
  ).json.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('one application per email and opening; refusals say why; salaries for hiring managers', async () => {
  const nusrat = await apply('Nusrat', 'nusrat@example.test');
  expect(nusrat.status).toBe(201);
  expect((await apply('Nusrat again', 'NUSRAT@example.test')).status).toBe(422);
  expect((await call('PATCH', `${A}/${nusrat.json.id}`, 'rahim', { refused: true })).status).toBe(
    422,
  );
  // Expected salaries: set and seen by hiring managers only.
  expect(
    (await call('PATCH', `${A}/${nusrat.json.id}`, 'dina', { expectedSalary: '60000' })).status,
  ).toBe(200);
  expect(JSON.stringify((await call('GET', `${A}/${nusrat.json.id}`, 'rahim')).json)).not.toContain(
    '60000',
  );
  expect((await call('GET', `${A}/${nusrat.json.id}`, 'dina')).json.expectedSalary).toBe('60000');
  expect((await call('GET', A, 'bob')).status).toBe(403);
});

test('scorecards: each interviewer sees their own; the average shows to all', async () => {
  const arif = (await apply('Arif', 'arif@example.test')).json.id;
  expect(
    (await call('POST', S, 'rahim', { applicant: arif, score: 4, recommendation: 'yes' })).status,
  ).toBe(201);
  expect(
    (await call('POST', S, 'sumi', { applicant: arif, score: 1, recommendation: 'strong_no' }))
      .status,
  ).toBe(201);
  expect((await call('POST', S, 'sumi', { applicant: arif, score: 9 })).status).toBe(422);
  const mine = (
    await call(
      'GET',
      `${S}?filter=${encodeURIComponent(JSON.stringify({ applicant: arif }))}&fields=score`,
      'rahim',
    )
  ).json.items as Json[];
  expect(mine.map((s) => s.score)).toEqual([4]);
  const all = (
    await call(
      'GET',
      `${S}?filter=${encodeURIComponent(JSON.stringify({ applicant: arif }))}&fields=score`,
      'dina',
    )
  ).json.items as Json[];
  expect(all).toHaveLength(2);
  expect((await call('GET', `${A}/${arif}`, 'sumi')).json.rating).toBe('2.5');
});

test('hiring: the hire step only; the employee made; a filled opening closes; never twice or beyond', async () => {
  const tania = (await apply('Tania', 'tania@example.test')).json.id;
  const kamal = (await apply('Kamal', 'kamal@example.test')).json.id;
  // Not by marking the link, and not by interviewers.
  const someone = (await call('POST', '/api/v1/models/hr.employee', 'hana', { name: 'Someone' }))
    .json.id;
  expect((await call('PATCH', `${A}/${tania}`, 'dina', { employee: someone })).status).toBe(422);
  expect((await call('POST', `/api/v1/hiring/applicants/${tania}/hire`, 'rahim')).status).toBe(403);

  const hired = await call('POST', `/api/v1/hiring/applicants/${tania}/hire`, 'dina');
  expect(hired.status).toBe(200);
  expect(hired.json.openingClosed).toBe(true);
  const after = (await call('GET', `${A}/${tania}`, 'dina')).json;
  expect(after.status).toBe('hired');
  expect(after.employee?.id ?? after.employee).toBe(hired.json.employee);
  const employee = (await call('GET', `/api/v1/models/hr.employee/${hired.json.employee}`, 'hana'))
    .json;
  expect(employee.name).toBe('Tania');
  expect(employee.workEmail).toBe('tania@example.test');
  const o = (await call('GET', `/api/v1/models/hiring.opening/${opening}`, 'dina')).json;
  expect(o.state).toBe('closed');
  expect(o.hiredCount).toBe(1);

  expect((await call('POST', `/api/v1/hiring/applicants/${tania}/hire`, 'dina')).status).toBe(409);
  expect((await call('POST', `/api/v1/hiring/applicants/${kamal}/hire`, 'dina')).status).toBe(409);
  // Reopened, it is still full: the headcount is hired.
  expect(
    (await call('POST', `/api/v1/models/hiring.opening/${opening}/transitions/reopen`, 'dina'))
      .status,
  ).toBe(200);
  const full = await call('POST', `/api/v1/hiring/applicants/${kamal}/hire`, 'dina');
  expect(full.status).toBe(409);
  expect(full.json.type).toContain('opening-filled');
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
  expect(JSON.stringify(summary)).toContain('Hiring');
});
