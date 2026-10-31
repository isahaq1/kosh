/**
 * Projects on real PostgreSQL through the HTTP API (RFC 0008): installing Projects brings Contacts and the chatter
 * and the three stages; a project's tasks move through stages (Done closes them and the project's open task count
 * follows); timesheets add up on the task and the project, and a user sees only their own timesheets while the
 * manager sees all; outsiders are refused.
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
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { project } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, project];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const stages: Record<string, number> = {};
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
const expectStatus = (r: { status: number; json: Json }, status: number) =>
  expect(r.status, JSON.stringify(r.json)).toBe(status);

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-project-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(await prepareApps({ driver, catalogue, change: { install: ['project'] }, dir }), {
    driver,
    dir,
    actor: 'test',
  });
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
    ['maria', ['project.manager']],
    ['rahim', ['project.user']],
    ['sumi', ['project.user']],
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
  const rows = await call(
    'GET',
    '/api/v1/models/project.task.stage?fields=id,name&order=sequence+asc',
    'rahim',
  );
  for (const s of rows.json.items as { id: number; name: string }[]) stages[s.name] = s.id;
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('installing Projects brings its dependencies and the stages', async () => {
  const installed = await driver.query<{ name: string }>({
    text: 'SELECT name FROM kosh_module ORDER BY name',
    params: [],
  });
  expect(installed.map((r) => r.name)).toEqual([
    'base',
    'contacts',
    'messaging',
    'project',
    'reporting',
    'storage',
  ]);
  expect(Object.keys(stages)).toEqual(['New', 'In progress', 'Done']);
  expectStatus(await call('GET', '/api/v1/models/project.project', 'bob'), 403);
});

test('tasks move through stages; Done closes them and the project counts its open tasks', async () => {
  const customer = await call('POST', '/api/v1/models/res.partner', 'rahim', {
    name: 'Bengal Steel',
    isCompany: true,
    isCustomer: true,
  });
  expectStatus(customer, 201);
  const p = await call('POST', '/api/v1/models/project.project', 'rahim', {
    name: 'Bridge works',
    partner: customer.json.id,
    dateEnd: '2027-06-30',
  });
  expectStatus(p, 201);
  expect(p.json.manager).toBeDefined(); // the creator
  // A task of the project takes its customer (the form's onchange).
  const draft = await call('POST', '/api/v1/models/project.task/onchange', 'rahim', {
    values: { name: 'x', project: p.json.id },
    changed: ['project'],
  });
  expectStatus(draft, 200);
  expect(draft.json.values).toMatchObject({ partner: customer.json.id });
  const t1 = await call('POST', '/api/v1/models/project.task', 'rahim', {
    name: 'Survey',
    project: p.json.id,
    stage: stages['New'],
    plannedHours: '8',
  });
  const t2 = await call('POST', '/api/v1/models/project.task', 'rahim', {
    name: 'Design',
    project: p.json.id,
    stage: stages['New'],
    priority: 'high',
  });
  expectStatus(t1, 201);
  expectStatus(t2, 201);
  expect(t1.json.done).toBe(false);
  expect(
    (await call('GET', `/api/v1/models/project.project/${p.json.id}?fields=taskCount`, 'rahim'))
      .json.taskCount,
  ).toBe(2);
  expectStatus(
    await call('PATCH', `/api/v1/models/project.task/${t1.json.id}`, 'rahim', {
      stage: stages['Done'],
    }),
    200,
  );
  expect(
    (await call('GET', `/api/v1/models/project.task/${t1.json.id}?fields=done`, 'rahim')).json.done,
  ).toBe(true);
  expect(
    (await call('GET', `/api/v1/models/project.project/${p.json.id}?fields=taskCount`, 'rahim'))
      .json.taskCount,
  ).toBe(1);
  // The kanban's columns: the stages, Done folded.
  const folded = await call(
    'GET',
    '/api/v1/models/project.task.stage?fields=name,fold,done',
    'rahim',
  );
  expect(folded.json.items.find((s: Json) => s.name === 'Done')).toMatchObject({
    fold: true,
    done: true,
  });
});

test('timesheets add up on the task and the project; users see their own, managers all', async () => {
  const p = (await call('POST', '/api/v1/models/project.project', 'maria', { name: 'Audit' })).json;
  const t = (
    await call('POST', '/api/v1/models/project.task', 'maria', {
      name: 'Fieldwork',
      project: p.id,
      stage: stages['In progress'],
    })
  ).json;
  expectStatus(
    await call('POST', '/api/v1/models/project.timesheet', 'rahim', {
      task: t.id,
      hours: '2.5',
      description: 'Site visit',
    }),
    201,
  );
  expectStatus(
    await call('POST', '/api/v1/models/project.timesheet', 'sumi', { task: t.id, hours: '1.25' }),
    201,
  );
  expect(
    (await call('POST', '/api/v1/models/project.timesheet', 'sumi', { task: t.id, hours: '0' }))
      .status,
  ).toBe(422);
  expect(
    (await call('GET', `/api/v1/models/project.task/${t.id}?fields=effectiveHours`, 'rahim')).json
      .effectiveHours,
  ).toBe('3.75');
  expect(
    (await call('GET', `/api/v1/models/project.project/${p.id}?fields=hours`, 'rahim')).json.hours,
  ).toBe('3.75');
  const mine = await call('GET', '/api/v1/models/project.timesheet?fields=hours', 'rahim');
  expect(mine.json.items.map((l: Json) => l.hours)).toEqual(['2.5']);
  const all = await call('GET', '/api/v1/models/project.timesheet?fields=hours,project', 'maria');
  expect(all.json.items).toHaveLength(2);
  expect(all.json.items.every((l: Json) => l.project === p.id)).toBe(true);
});

test('the Projects overview (RFC 0022 step 2) to a user; the project form has its tiles', async () => {
  const overview = await call('GET', '/api/v1/reports/overview?app=projects', 'rahim');
  expect(overview.status, JSON.stringify(overview.json)).toBe(200);
  expect(overview.json.cards.map((c: { id: string }) => c.id)).toContain('open_tasks');
  const form = await call('GET', '/api/v1/views/project.project.form', 'rahim');
  expect(form.status, JSON.stringify(form.json)).toBe(200);
  expect(form.json.view.sheet[0].children.map((c: { id: string }) => c.id)).toEqual([
    'project_tasks',
    'project_open_tasks',
    'project_hours',
  ]);
  const gantt = await call('GET', '/api/v1/views?model=project.project&type=gantt', 'rahim');
  expect(gantt.status, JSON.stringify(gantt.json)).toBe(200);
});
