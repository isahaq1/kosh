/**
 * Workforce on real PostgreSQL through the HTTP API (RFC 0021): the directory for every employee, personal details
 * and wages for HR managers only; a leave counts working days by the company's week (the weekend setting) and the
 * server checks them; no overlaps; the year's balance is enforced; the line manager or HR decides, never the person
 * asking, and only waiting requests; one's own contract only; the demo data loads.
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
import { hr, workingDays } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, hr];
const L = '/api/v1/models/hr.leave';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const users: Record<string, number> = {};
const employees: Record<string, number> = {};
const types: Record<string, number> = {};
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
const leave = (from: string, to: string, days: number, type = 'Casual leave') =>
  call('POST', L, 'rahim', {
    employee: employees['rahim'],
    type: types[type],
    dateFrom: from,
    dateTo: to,
    days,
  });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-hr-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'hr'] }, dir }),
    {
      driver,
      dir,
      actor: 'test',
    },
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
    ['dina', ['hr.user']],
    ['rahim', ['hr.user']],
    ['sumi', ['hr.user']],
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
  const E = '/api/v1/models/hr.employee';
  employees['dina'] = (
    await call('POST', E, 'hana', { name: 'Dina', user: users['dina'] })
  ).json.id;
  for (const who of ['rahim', 'sumi'])
    employees[who] = (
      await call('POST', E, 'hana', {
        name: who,
        user: users[who],
        manager: employees['dina'],
        birthday: '1990-05-01',
        nationalId: `NID-${who}`,
      })
    ).json.id;
  for (const t of (await call('GET', '/api/v1/models/hr.leave.type?fields=name', 'hana')).json
    .items as Json[])
    types[t.name] = t.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('working days by the weekend', () => {
  // Sunday 1 to Saturday 7 November 2026.
  expect(workingDays('2026-11-01', '2026-11-07', [5, 6])).toBe(5);
  expect(workingDays('2026-11-01', '2026-11-07', [6, 0])).toBe(5);
  expect(workingDays('2026-11-06', '2026-11-07', [5, 6])).toBe(0);
});

test('the directory for everyone; personal details for HR managers only; a user is one employee', async () => {
  const seen = await call('GET', `/api/v1/models/hr.employee/${employees['rahim']}`, 'sumi');
  expect(seen.status).toBe(200);
  expect(JSON.stringify(seen.json)).not.toContain('NID-rahim');
  expect(
    JSON.stringify(
      (await call('GET', `/api/v1/models/hr.employee/${employees['rahim']}`, 'hana')).json,
    ),
  ).toContain('NID-rahim');
  expect(
    (
      await call('PATCH', `/api/v1/models/hr.employee/${employees['sumi']}`, 'sumi', {
        workPhone: '1',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('POST', '/api/v1/models/hr.employee', 'hana', {
        name: 'Twin',
        user: users['rahim'],
      })
    ).status,
  ).toBe(422);
  expect((await call('GET', '/api/v1/models/hr.employee', 'bob')).status).toBe(403);
});

test('leave: working days checked, decided by the manager only, never by the person; no overlap; the balance', async () => {
  const onchange = await call('POST', `${L}/onchange`, 'rahim', {
    values: {
      employee: employees['rahim'],
      type: types['Casual leave'],
      dateFrom: '2026-11-01',
      dateTo: '2026-11-07',
    },
    changed: ['dateTo'],
  });
  expect(onchange.json.values.days).toBe(5);
  expect((await leave('2026-11-01', '2026-11-07', 7)).status).toBe(422); // the form cannot claim 7
  expect((await leave('2026-11-06', '2026-11-07', 0)).status).toBe(422); // a weekend only

  const made = await leave('2026-11-01', '2026-11-07', 5);
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const id = made.json.id as number;
  expect((await call('POST', `${L}/${id}/transitions/submit`, 'rahim')).status).toBe(200);
  // Not by himself, not by a colleague, not through the transition without the permission.
  const decide = (as: string, decision: string) =>
    call('POST', `/api/v1/workforce/leaves/${id}/decide`, as, { decision });
  expect((await decide('rahim', 'approve')).status).toBe(403);
  expect((await decide('sumi', 'approve')).status).toBe(403);
  expect((await call('POST', `${L}/${id}/transitions/approve`, 'dina')).status).toBe(403);
  // His manager sees it and approves it.
  expect((await call('GET', `${L}/${id}`, 'dina')).status).toBe(200);
  expect((await call('GET', `${L}/${id}`, 'sumi')).status).toBe(403);
  const approved = await decide('dina', 'approve');
  expect(approved.status, JSON.stringify(approved.json)).toBe(200);
  expect((await call('GET', `${L}/${id}?fields=state`, 'rahim')).json.state).toBe('approved');
  const [event] = await driver.query<{ actor: number }>({
    text: "SELECT actor_id AS actor FROM audit_event WHERE kind = 'hr.leave_approved' ORDER BY id DESC LIMIT 1",
    params: [],
  });
  expect(event?.actor).toBe(users['dina']); // decided by her, in the audit log
  expect((await decide('dina', 'refuse')).status).toBe(409);
  expect((await call('PATCH', `${L}/${id}`, 'rahim', { reason: 'changed' })).status).toBe(403); // no longer a draft

  expect((await leave('2026-11-05', '2026-11-08', 2)).status).toBe(422); // overlaps

  // 10 casual days a year: 5 taken, 6 more refused when submitted, 5 accepted.
  const more = await leave('2026-12-06', '2026-12-13', 6);
  expect(more.status, JSON.stringify(more.json)).toBe(201);
  const over = await call('POST', `${L}/${more.json.id}/transitions/submit`, 'rahim');
  expect(over.status).toBe(422);
  expect(JSON.stringify(over.json)).toContain('Not enough days');
  const balance = await call('GET', '/api/v1/workforce/balance?year=2026', 'rahim');
  expect(balance.status, JSON.stringify(balance.json)).toBe(200);
  expect(balance.json.types.find((t: Json) => t.name === 'Casual leave')).toMatchObject({
    allowed: 10,
    taken: 5,
    waiting: 0,
    left: 5,
  });
  expect(balance.json.types.find((t: Json) => t.name === 'Unpaid leave').left).toBeNull();
});

test('the weekend setting changes the count; contracts are one’s own; wages for HR', async () => {
  expect(
    (
      await call('PATCH', '/api/v1/settings/app-settings/hr/week', 'hana', {
        values: { weekend: 'sat_sun' },
      })
    ).status,
  ).toBe(200);
  const onchange = await call('POST', `${L}/onchange`, 'sumi', {
    values: {
      employee: employees['sumi'],
      type: types['Sick leave'],
      dateFrom: '2026-11-06',
      dateTo: '2026-11-09',
    },
    changed: ['dateTo'],
  });
  expect(onchange.json.values.days).toBe(2); // Friday and Monday
  expect(
    (
      await call('PATCH', '/api/v1/settings/app-settings/hr/week', 'dina', {
        values: { weekend: 'fri' },
      })
    ).status,
  ).toBe(403);

  const C = '/api/v1/models/hr.contract';
  const contract = await call('POST', C, 'hana', {
    name: 'CT-001',
    employee: employees['rahim'],
    dateStart: '2026-01-01',
    wage: '85000',
  });
  expect(contract.status, JSON.stringify(contract.json)).toBe(201);
  const own = await call('GET', `${C}/${contract.json.id}`, 'rahim');
  expect(own.status).toBe(200);
  expect(JSON.stringify(own.json)).not.toContain('85000');
  expect((await call('GET', `${C}/${contract.json.id}`, 'sumi')).status).toBe(403);
});

test('an HR manager does not approve their own leave, through the route or the transition', async () => {
  const self = await call('POST', '/api/v1/models/hr.employee', 'hana', {
    name: 'Hana',
    user: users['hana'],
  });
  expect(self.status).toBe(201);
  const made = await call('POST', L, 'hana', {
    employee: self.json.id,
    type: types['Sick leave'],
    dateFrom: '2026-11-10',
    dateTo: '2026-11-10',
    days: 1,
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  expect((await call('POST', `${L}/${made.json.id}/transitions/submit`, 'hana')).status).toBe(200);
  expect((await call('POST', `${L}/${made.json.id}/transitions/approve`, 'hana')).status).toBe(409);
  expect(
    (
      await call('POST', `/api/v1/workforce/leaves/${made.json.id}/decide`, 'hana', {
        decision: 'approve',
      })
    ).status,
  ).toBe(403);
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
  expect(JSON.stringify(summary)).toContain('Workforce');
});

test('the Workforce overview (RFC 0022 step 2) to a user; the employee form has its tiles', async () => {
  const overview = await call('GET', '/api/v1/reports/overview?app=workforce', 'dina');
  expect(overview.status, JSON.stringify(overview.json)).toBe(200);
  expect(overview.json.cards.map((c: { id: string }) => c.id)).toContain('leave_waiting');
  const form = await call('GET', '/api/v1/views/hr.employee.form', 'dina');
  expect(form.json.view.sheet[0].children.map((c: { id: string }) => c.id)).toEqual([
    'employee_team',
    'employee_leave_days',
    'employee_contracts',
  ]);
});
