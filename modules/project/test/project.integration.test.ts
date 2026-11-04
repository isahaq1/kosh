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
    'permissions',
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
    'project_phases',
    'project_work_packages',
    'project_risks',
    'project_issues',
    'project_changes',
    'project_reports',
    'project_children',
  ]);
  const gantt = await call('GET', '/api/v1/views?model=project.project&type=gantt', 'rahim');
  expect(gantt.status, JSON.stringify(gantt.json)).toBe(200);
});

test('App settings › Projects (RFC 0020 step 2): timesheets on the step; planned hours on new tasks', async () => {
  // Set as the company's fields (the Settings app is not in this catalogue).
  await driver.query({
    text: "UPDATE res_company SET project_timesheet_step = 'half', project_planned_hours_default = 8",
    params: [],
  });
  const p = (await call('POST', '/api/v1/models/project.project', 'maria', { name: 'Steps' })).json;
  const t = (
    await call('POST', '/api/v1/models/project.task', 'maria', {
      name: 'Measured',
      project: p.id,
      stage: stages['In progress'],
    })
  ).json;
  expect(
    (await call('POST', '/api/v1/models/project.timesheet', 'rahim', { task: t.id, hours: '1.25' }))
      .status,
  ).toBe(422);
  expectStatus(
    await call('POST', '/api/v1/models/project.timesheet', 'rahim', { task: t.id, hours: '1.5' }),
    201,
  );
  // The onchange: a task's project chosen fills the planned hours when empty.
  const changed = await call('POST', '/api/v1/models/project.task/onchange', 'maria', {
    values: { name: 'New', project: p.id },
    changed: ['project'],
  });
  expect(changed.status, JSON.stringify(changed.json)).toBe(200);
  expect(Number(changed.json.values?.plannedHours ?? changed.json.plannedHours)).toBe(8);
  await driver.query({
    text: "UPDATE res_company SET project_timesheet_step = 'none', project_planned_hours_default = NULL",
    params: [],
  });
});

test('programmes, phases, work packages and tasks (RFC 0026 step 1): codes, progress from planned hours, same-project checks', async () => {
  const type = await call('POST', '/api/v1/models/project.type', 'maria', {
    name: 'Farm build',
    code: 'FARM',
  });
  expectStatus(type, 201);
  const programme = await call('POST', '/api/v1/models/project.project', 'rahim', {
    name: 'Northern farms',
    type: type.json.id,
    riskLevel: 'high',
  });
  expectStatus(programme, 201);
  expect(programme.json.code).toMatch(/^PRJ-\d{4}$/);
  const farm = await call('POST', '/api/v1/models/project.project', 'rahim', {
    name: 'Farm 1',
    parentProject: programme.json.id,
    dateStart: '2027-01-01',
    dateEnd: '2027-06-30',
  });
  expectStatus(farm, 201);
  // No cycles: the programme cannot go inside its own project; dates in order.
  expectStatus(
    await call('PATCH', `/api/v1/models/project.project/${programme.json.id}`, 'rahim', {
      parentProject: farm.json.id,
    }),
    422,
  );
  expectStatus(
    await call('PATCH', `/api/v1/models/project.project/${farm.json.id}`, 'rahim', {
      dateEnd: '2026-12-01',
    }),
    422,
  );
  const phase = await call('POST', '/api/v1/models/project.phase', 'rahim', {
    name: 'Civil works',
    project: farm.json.id,
  });
  expectStatus(phase, 201);
  const wp = await call('POST', '/api/v1/models/project.work.package', 'rahim', {
    name: 'Sheds',
    project: farm.json.id,
    phase: phase.json.id,
    deliverables: 'Four sheds, roofed',
  });
  expectStatus(wp, 201);
  // The work package sets the task's phase (the form's onchange).
  const draft = await call('POST', '/api/v1/models/project.task/onchange', 'rahim', {
    values: { name: 'x', project: farm.json.id, workPackage: wp.json.id },
    changed: ['workPackage'],
  });
  expectStatus(draft, 200);
  expect(draft.json.values).toMatchObject({ phase: phase.json.id });
  const t1 = await call('POST', '/api/v1/models/project.task', 'rahim', {
    name: 'Foundations',
    project: farm.json.id,
    phase: phase.json.id,
    workPackage: wp.json.id,
    stage: stages['New'],
    plannedHours: '30',
  });
  const t2 = await call('POST', '/api/v1/models/project.task', 'rahim', {
    name: 'Roofing',
    project: farm.json.id,
    phase: phase.json.id,
    workPackage: wp.json.id,
    stage: stages['New'],
    plannedHours: '10',
    milestone: true,
  });
  expectStatus(t1, 201);
  expectStatus(t2, 201);
  expectStatus(
    await call('PATCH', `/api/v1/models/project.task/${t1.json.id}`, 'rahim', {
      stage: stages['Done'],
    }),
    200,
  );
  const progressOf = async (model: string, id: number) =>
    Number(
      (await call('GET', `/api/v1/models/${model}/${id}?fields=progress`, 'rahim')).json.progress,
    );
  expect(await progressOf('project.work.package', wp.json.id)).toBe(75);
  expect(await progressOf('project.phase', phase.json.id)).toBe(75);
  expect(await progressOf('project.project', farm.json.id)).toBe(75);
  // A manual override shows instead, within 0–100.
  expectStatus(
    await call('PATCH', `/api/v1/models/project.phase/${phase.json.id}`, 'rahim', {
      progressOverride: '40',
    }),
    200,
  );
  expect(await progressOf('project.phase', phase.json.id)).toBe(40);
  expectStatus(
    await call('PATCH', `/api/v1/models/project.phase/${phase.json.id}`, 'rahim', {
      progressOverride: '140',
    }),
    422,
  );
  // A task cannot sit in another project's phase.
  const other = await call('POST', '/api/v1/models/project.project', 'rahim', { name: 'Farm 2' });
  expectStatus(
    await call('POST', '/api/v1/models/project.task', 'rahim', {
      name: 'Wrong place',
      project: other.json.id,
      phase: phase.json.id,
    }),
    422,
  );
  // The programme's hierarchy view.
  expectStatus(
    await call('GET', '/api/v1/views?model=project.project&type=hierarchy', 'rahim'),
    200,
  );
});

test('sub-tasks, several assignees, tags and dependencies (RFC 0026 step 1): blocked until done, no circles', async () => {
  const p = await call('POST', '/api/v1/models/project.project', 'rahim', { name: 'Hatchery' });
  const users = await driver.query<{ id: number; login: string }>({
    text: 'SELECT id, login FROM res_users',
    params: [],
  });
  const idOf = (login: string) => users.find((u) => u.login === login)?.id;
  const tag = await call('POST', '/api/v1/models/project.tag', 'maria', { name: 'Civil' });
  expectStatus(tag, 201);
  const a = await call('POST', '/api/v1/models/project.task', 'rahim', {
    name: 'Order incubators',
    project: p.json.id,
    stage: stages['New'],
    assignees: { set: [idOf('rahim'), idOf('sumi')] },
    tags: { set: [tag.json.id] },
  });
  expectStatus(a, 201);
  const b = await call('POST', '/api/v1/models/project.task', 'rahim', {
    name: 'Install incubators',
    project: p.json.id,
    stage: stages['New'],
  });
  const link = await call('POST', '/api/v1/models/project.task.link', 'rahim', {
    predecessor: a.json.id,
    successor: b.json.id,
    lag: 2,
  });
  expectStatus(link, 201);
  const blocked = async (id: number) =>
    (await call('GET', `/api/v1/models/project.task/${id}?fields=blocked`, 'rahim')).json.blocked;
  expect(await blocked(b.json.id)).toBe(true);
  // B waiting for A, A waiting for B: refused; nor on itself.
  expectStatus(
    await call('POST', '/api/v1/models/project.task.link', 'rahim', {
      predecessor: b.json.id,
      successor: a.json.id,
    }),
    422,
  );
  expectStatus(
    await call('POST', '/api/v1/models/project.task.link', 'rahim', {
      predecessor: a.json.id,
      successor: a.json.id,
    }),
    422,
  );
  // Sub-tasks: the parent's progress is theirs, weighted by planned hours.
  const s1 = await call('POST', '/api/v1/models/project.task', 'rahim', {
    name: 'Get quotes',
    project: p.json.id,
    parentTask: a.json.id,
    stage: stages['Done'],
    plannedHours: '1',
  });
  const s2 = await call('POST', '/api/v1/models/project.task', 'rahim', {
    name: 'Place the order',
    project: p.json.id,
    parentTask: a.json.id,
    stage: stages['New'],
    plannedHours: '3',
  });
  expectStatus(s1, 201);
  expectStatus(s2, 201);
  const read = await call(
    'GET',
    `/api/v1/models/project.task/${a.json.id}?fields=progress,assignees,tags`,
    'rahim',
  );
  expect(Number(read.json.progress)).toBe(25);
  expect(read.json.assignees).toHaveLength(2);
  expectStatus(
    await call('PATCH', `/api/v1/models/project.task/${a.json.id}`, 'rahim', {
      stage: stages['Done'],
    }),
    200,
  );
  expect(await blocked(b.json.id)).toBe(false);
  // Outsiders still cannot see any of it.
  expectStatus(await call('GET', '/api/v1/models/project.phase', 'bob'), 403);
});

test('plans (RFC 0026 step 2): submitted with their case, decided by the sponsor and a manager, a project started with the baseline', async () => {
  const users = await driver.query<{ id: number; login: string }>({
    text: 'SELECT id, login FROM res_users',
    params: [],
  });
  const idOf = (login: string) => users.find((u) => u.login === login)?.id;
  const run = (id: number, transition: string, as: string) =>
    call('POST', `/api/v1/models/project.plan/${id}/transitions/${transition}`, as);
  const plan = await call('POST', '/api/v1/models/project.plan', 'rahim', {
    title: 'Hatchery 2',
    sponsor: idOf('sumi'),
  });
  expectStatus(plan, 201);
  expect(plan.json.name).toMatch(/^PLAN-\d{4}$/);
  // Without its objectives, dates and estimate it is not submitted.
  expectStatus(await run(plan.json.id, 'submit', 'rahim'), 409);
  expectStatus(
    await call('PATCH', `/api/v1/models/project.plan/${plan.json.id}`, 'rahim', {
      objectives: 'Double the chicks hatched a week',
      dateStart: '2027-02-01',
      dateEnd: '2027-08-31',
      estimatedBudget: '1500000',
    }),
    200,
  );
  expectStatus(await run(plan.json.id, 'submit', 'rahim'), 200);
  // Outsiders never see it; the requester cannot change it once submitted.
  expectStatus(await call('GET', `/api/v1/models/project.plan/${plan.json.id}`, 'bob'), 403);
  expect(
    (
      await call('PATCH', `/api/v1/models/project.plan/${plan.json.id}`, 'rahim', {
        estimatedBudget: '10',
      })
    ).status,
  ).toBeGreaterThanOrEqual(403);
  const decide = async (who: string) => {
    const inbox = (await call('GET', '/api/v1/approvals/inbox', who)).json.requests as Json[];
    const mine = inbox.filter(
      (r) => r.targetModel === 'project.plan' && r.targetId === plan.json.id,
    );
    for (const r of mine)
      expectStatus(await call('POST', `/api/v1/approvals/requests/${r.id}/approve`, who), 200);
    return mine.length;
  };
  // The sponsor first; above 1 000 000 a Projects manager too.
  expect(await decide('sumi')).toBe(1);
  const state = async () =>
    (await call('GET', `/api/v1/models/project.plan/${plan.json.id}`, 'maria')).json;
  expect((await state()).state).toBe('submitted');
  expect(await decide('maria')).toBe(1);
  const approved = await state();
  expect(approved.state).toBe('approved');
  expect(Number(approved.approvedBudget)).toBe(1500000);
  expect(approved.approvedAt).not.toBeNull();

  // The project starts from it with the baseline.
  expectStatus(await run(plan.json.id, 'start', 'rahim'), 200);
  const projects = await call(
    'GET',
    `/api/v1/models/project.project?filter=${encodeURIComponent(JSON.stringify({ plan: plan.json.id }))}&fields=id,name,baselineStart,baselineEnd,baselineBudget,dateEnd,slipDays`,
    'rahim',
  );
  expect(projects.json.items).toHaveLength(1);
  const started = projects.json.items[0];
  expect(started).toMatchObject({
    name: 'Hatchery 2',
    baselineStart: '2027-02-01',
    baselineEnd: '2027-08-31',
    slipDays: 0,
  });
  expect(Number(started.baselineBudget)).toBe(1500000);
  // The deadline slips ten days: the baseline says so; only a manager takes the baseline again.
  expectStatus(
    await call('PATCH', `/api/v1/models/project.project/${started.id}`, 'rahim', {
      dateEnd: '2027-09-10',
    }),
    200,
  );
  const slip = async () =>
    (await call('GET', `/api/v1/models/project.project/${started.id}?fields=slipDays`, 'rahim'))
      .json.slipDays;
  expect(await slip()).toBe(10);
  // A user cannot move the baseline by hand.
  expect(
    (
      await call('PATCH', `/api/v1/models/project.project/${started.id}`, 'rahim', {
        baselineEnd: '2027-09-10',
      })
    ).status,
  ).toBeGreaterThanOrEqual(403);
  expectStatus(await run(plan.json.id, 'baseline', 'rahim'), 403);
  expectStatus(await run(plan.json.id, 'baseline', 'maria'), 200);
  expect(await slip()).toBe(0);
});

test('App settings › Plans (RFC 0026 step 2): a project starts from an approved plan', async () => {
  await driver.query({ text: 'UPDATE res_company SET project_require_plan = true', params: [] });
  try {
    expectStatus(
      await call('POST', '/api/v1/models/project.project', 'rahim', { name: 'No plan' }),
      422,
    );
    const draft = await call('POST', '/api/v1/models/project.plan', 'rahim', { title: 'Draft' });
    expectStatus(
      await call('POST', '/api/v1/models/project.project', 'rahim', {
        name: 'Draft plan',
        plan: draft.json.id,
      }),
      422,
    );
    // Inside a programme the programme's plan stands.
    const [programme] = await driver.query<{ id: number }>({
      text: "SELECT id FROM project_project WHERE name = 'Hatchery 2'",
      params: [],
    });
    expectStatus(
      await call('POST', '/api/v1/models/project.project', 'rahim', {
        name: 'Hatchery 2 — sheds',
        parentProject: programme?.id,
      }),
      201,
    );
  } finally {
    await driver.query({ text: 'UPDATE res_company SET project_require_plan = false', params: [] });
  }
});

test('teams (RFC 0026 step 3): roles and hourly costs for managers only, over-allocation across projects, labour cost from timesheets, the workload', async () => {
  const users = await driver.query<{ id: number; login: string }>({
    text: 'SELECT id, login FROM res_users',
    params: [],
  });
  const idOf = (login: string) => users.find((u) => u.login === login)?.id;
  const role = await call('POST', '/api/v1/models/project.role', 'maria', {
    name: 'Site engineer',
    code: 'SE',
    defaultHourlyCost: '500',
  });
  expectStatus(role, 201);
  const a = await call('POST', '/api/v1/models/project.project', 'maria', { name: 'Shed A' });
  const b = await call('POST', '/api/v1/models/project.project', 'maria', { name: 'Shed B' });
  const sumi = idOf('sumi');
  const m1 = await call('POST', '/api/v1/models/project.member', 'maria', {
    project: a.json.id,
    user: sumi,
    role: role.json.id,
    allocation: 60,
    dateFrom: '2027-03-01',
    dateTo: '2027-03-31',
  });
  expectStatus(m1, 201);
  // Users are not team managers; and they never see hourly costs.
  expectStatus(
    await call('POST', '/api/v1/models/project.member', 'rahim', {
      project: a.json.id,
      user: sumi,
    }),
    403,
  );
  expectStatus(
    await call(
      'GET',
      `/api/v1/models/project.member/${m1.json.id}?fields=allocation,hourlyCost`,
      'rahim',
    ),
    403,
  );
  const asUser = await call('GET', `/api/v1/models/project.member/${m1.json.id}`, 'rahim');
  expectStatus(asUser, 200);
  expect(asUser.json.allocation).toBe(60);
  expect(asUser.json).not.toHaveProperty('hourlyCost');
  const over = async (id: number) => {
    const r = await call(
      'GET',
      `/api/v1/models/project.member/${id}?fields=overallocated`,
      'maria',
    );
    expectStatus(r, 200);
    return r.json.overallocated;
  };
  expect(await over(m1.json.id)).toBe(false);
  // Flagged on the form, before it is saved: 60 % in A plus 50 % more.
  const draft = await call('POST', '/api/v1/models/project.member/onchange', 'maria', {
    values: {
      project: b.json.id,
      user: sumi,
      allocation: 50,
      dateFrom: '2027-03-15',
      dateTo: '2027-04-30',
    },
    changed: ['allocation'],
  });
  expectStatus(draft, 200);
  expect(draft.json.values).toMatchObject({ overallocated: true });
  // 60 % plus 50 % in the same weeks of March: over-allocated, both of them; not in April.
  const m2 = await call('POST', '/api/v1/models/project.member', 'maria', {
    project: b.json.id,
    user: sumi,
    allocation: 50,
    dateFrom: '2027-03-15',
    dateTo: '2027-04-30',
    hourlyCost: '700',
  });
  expectStatus(m2, 201);
  expect(await over(m1.json.id)).toBe(true);
  expect(await over(m2.json.id)).toBe(true);
  expectStatus(
    await call('POST', '/api/v1/models/project.member', 'maria', {
      project: b.json.id,
      user: sumi,
      allocation: 120,
    }),
    422,
  );

  // Labour: Sumi's hours at her cost in each project (the role's default in A, her own in B).
  const taskOf = async (project: number) =>
    (
      await call('POST', '/api/v1/models/project.task', 'maria', {
        name: 'Work',
        project,
        stage: stages['In progress'],
      })
    ).json.id as number;
  const ta = await taskOf(a.json.id);
  const tb = await taskOf(b.json.id);
  for (const [task, date] of [
    [ta, '2027-03-10'],
    [tb, '2027-04-02'],
  ] as const)
    expectStatus(
      await call('POST', '/api/v1/models/project.timesheet', 'sumi', {
        task,
        date,
        hours: '2',
      }),
      201,
    );
  const labour = async (id: number) =>
    Number(
      (await call('GET', `/api/v1/models/project.project/${id}?fields=labourCost`, 'maria')).json
        .labourCost,
    );
  expect(await labour(a.json.id)).toBe(1000);
  expect(await labour(b.json.id)).toBe(1400);
  // Her own cost is not hers to see: asked for, refused; by default, left out.
  expectStatus(
    await call('GET', '/api/v1/models/project.timesheet?fields=hours,cost', 'sumi'),
    403,
  );
  const own = await call('GET', '/api/v1/models/project.timesheet', 'sumi');
  expectStatus(own, 200);
  expect(own.json.items[0]).not.toHaveProperty('cost');

  // The workload: the peak of each week; Sumi sees herself, managers everyone.
  const load = await call('GET', '/api/v1/projects/workload?from=2027-03-01&weeks=9', 'maria');
  expectStatus(load, 200);
  expect(load.json.weeks[0]).toBe('2027-03-01');
  const row = load.json.people.find((p: Json) => p.user === sumi);
  expect(row.weeks).toEqual([60, 60, 110, 110, 110, 50, 50, 50, 50]);
  const mine = await call('GET', '/api/v1/projects/workload?from=2027-03-01&weeks=2', 'rahim');
  expectStatus(mine, 200);
  expect(mine.json.people).toEqual([]);
  expectStatus(await call('GET', '/api/v1/projects/workload?from=2027-03-01', 'bob'), 403);
  expectStatus(await call('GET', '/api/v1/projects/workload?weeks=99', 'maria'), 422);
});

test('money and health (RFC 0026 step 4): budget lines and figures for managers only, health from the schedule, milestones and costs, overridden with a reason', async () => {
  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const p = await call('POST', '/api/v1/models/project.project', 'maria', {
    name: 'Brooder house',
    dateStart: day(-50),
    dateEnd: day(50),
  });
  expectStatus(p, 201);
  // Budget lines are the managers'.
  expectStatus(
    await call('POST', '/api/v1/models/project.budget.line', 'rahim', {
      project: p.json.id,
      name: 'Bricks',
      planned: '1000',
    }),
    403,
  );
  expectStatus(
    await call('POST', '/api/v1/models/project.budget.line', 'maria', {
      project: p.json.id,
      name: 'Bricks',
      category: 'materials',
      planned: '1000',
    }),
    201,
  );
  const figures = async () =>
    (
      await call(
        'GET',
        `/api/v1/models/project.project/${p.json.id}?fields=budget,variance,actualCost,health,healthComputed,healthNotes`,
        'maria',
      )
    ).json;
  expect(Number((await figures()).budget)).toBe(1000);
  expectStatus(
    await call('GET', `/api/v1/models/project.project/${p.json.id}?fields=budget`, 'rahim'),
    403,
  );

  // Half the time gone, nothing done: off track once refreshed (only managers refresh).
  expectStatus(
    await call('POST', '/api/v1/projects/refresh', 'rahim', { projects: [p.json.id] }),
    403,
  );
  const refreshed = await call('POST', '/api/v1/projects/refresh', 'maria', {
    projects: [p.json.id],
  });
  expectStatus(refreshed, 200);
  expect(refreshed.json.refreshed).toBe(1);
  let now = await figures();
  expect(now.health).toBe('off_track');
  expect(now.healthNotes).toContain('points behind');
  expect(Number(now.variance)).toBe(1000);

  // A phase past its end and not finished is marked late by the refresh.
  const phase = await call('POST', '/api/v1/models/project.phase', 'maria', {
    name: 'Foundations',
    project: p.json.id,
    dateStart: day(-40),
    dateEnd: day(-1),
  });
  expectStatus(phase, 201);
  await call('POST', '/api/v1/projects/refresh', 'maria', { projects: [p.json.id] });
  expect(
    (await call('GET', `/api/v1/models/project.phase/${phase.json.id}?fields=late`, 'rahim')).json
      .late,
  ).toBe(true);
  // Half done: on track; a milestone late: at risk.
  const task = await call('POST', '/api/v1/models/project.task', 'maria', {
    name: 'Walls',
    project: p.json.id,
    stage: stages['Done'],
    plannedHours: '5',
  });
  await call('POST', '/api/v1/models/project.task', 'maria', {
    name: 'Roof',
    project: p.json.id,
    stage: stages['New'],
    plannedHours: '5',
  });
  expectStatus(task, 201);
  await call('POST', '/api/v1/projects/refresh', 'maria', { projects: [p.json.id] });
  expect((await figures()).health).toBe('on_track');
  await call('POST', '/api/v1/models/project.task', 'maria', {
    name: 'Inspection',
    project: p.json.id,
    stage: stages['New'],
    milestone: true,
    deadline: day(-2),
  });
  await call('POST', '/api/v1/projects/refresh', 'maria', { projects: [p.json.id] });
  now = await figures();
  expect(now.health).toBe('at_risk');
  expect(now.healthNotes).toContain('milestone');

  // Overridden by the manager: only with the reason; the figures stay underneath.
  expectStatus(
    await call('PATCH', `/api/v1/models/project.project/${p.json.id}`, 'maria', {
      healthOverride: 'on_track',
    }),
    422,
  );
  expectStatus(
    await call('PATCH', `/api/v1/models/project.project/${p.json.id}`, 'maria', {
      healthOverride: 'on_track',
      healthReason: 'The inspector moved the visit; nothing is late on our side.',
    }),
    200,
  );
  now = await figures();
  expect(now.health).toBe('on_track');
  expect(now.healthComputed).toBe('at_risk');
  // A user's new project form computes without the money (the managers' to see).
  const blank = await call('POST', '/api/v1/models/project.project/onchange', 'rahim', {
    values: { name: 'x' },
    changed: ['name'],
  });
  expectStatus(blank, 200);
  expect(blank.json.values).not.toHaveProperty('variance');
  // Everyone sees the health.
  expect(
    (await call('GET', `/api/v1/models/project.project/${p.json.id}?fields=health`, 'rahim')).json
      .health,
  ).toBe('on_track');
});

test('control (RFC 0026 step 5): risks scored, issues resolved with a resolution, a change request approved and applied to the baseline, a status report sent to the project', async () => {
  const users = await driver.query<{ id: number; login: string }>({
    text: 'SELECT id, login FROM res_users',
    params: [],
  });
  const idOf = (login: string) => users.find((u) => u.login === login)?.id;
  const p = await call('POST', '/api/v1/models/project.project', 'maria', {
    name: 'Feed store',
    sponsor: idOf('sumi'),
    dateStart: '2027-01-01',
    dateEnd: '2027-06-30',
  });
  expectStatus(p, 201);

  // A risk: 4 × 4 = 16, critical; 1–5 only.
  const risk = await call('POST', '/api/v1/models/project.risk', 'rahim', {
    project: p.json.id,
    name: 'Monsoon floods the site',
    category: 'schedule',
    probability: 4,
    impact: 4,
    mitigation: 'Raise the plinth first',
  });
  expectStatus(risk, 201);
  const r = (
    await call('GET', `/api/v1/models/project.risk/${risk.json.id}?fields=score,level`, 'rahim')
  ).json;
  expect(r).toMatchObject({ score: 16, level: 'critical' });
  expectStatus(
    await call('POST', '/api/v1/models/project.risk', 'rahim', {
      project: p.json.id,
      name: 'Bad',
      probability: 6,
      impact: 1,
    }),
    422,
  );
  expectStatus(await call('GET', '/api/v1/models/project.risk', 'bob'), 403);

  // An issue is resolved only with its resolution.
  const issue = await call('POST', '/api/v1/models/project.issue', 'rahim', {
    project: p.json.id,
    name: 'Cement delivery late',
    severity: 'high',
    risk: risk.json.id,
  });
  expectStatus(issue, 201);
  expectStatus(
    await call('PATCH', `/api/v1/models/project.issue/${issue.json.id}`, 'rahim', {
      status: 'resolved',
    }),
    422,
  );
  expectStatus(
    await call('PATCH', `/api/v1/models/project.issue/${issue.json.id}`, 'rahim', {
      status: 'resolved',
      resolution: 'Second supplier delivered.',
    }),
    200,
  );

  // A change request: refused without anything asked; then the sponsor and a manager approve, and it is applied.
  const change = await call('POST', '/api/v1/models/project.change', 'rahim', {
    project: p.json.id,
    title: 'Two more weeks for the floods',
    reason: 'The monsoon came early.',
  });
  expectStatus(change, 201);
  expect(change.json.name).toMatch(/^CR-\d{4}$/);
  const run = (t: string, as: string) =>
    call('POST', `/api/v1/models/project.change/${change.json.id}/transitions/${t}`, as);
  expectStatus(await run('submit', 'rahim'), 409);
  expectStatus(
    await call('PATCH', `/api/v1/models/project.change/${change.json.id}`, 'rahim', {
      newDateEnd: '2027-07-14',
    }),
    200,
  );
  expectStatus(await run('submit', 'rahim'), 200);
  const decide = async (who: string) => {
    const inbox = (await call('GET', '/api/v1/approvals/inbox', who)).json.requests as Json[];
    const mine = inbox.filter(
      (x) => x.targetModel === 'project.change' && x.targetId === change.json.id,
    );
    for (const x of mine)
      expectStatus(await call('POST', `/api/v1/approvals/requests/${x.id}/approve`, who), 200);
    return mine.length;
  };
  expect(await decide('sumi')).toBe(1);
  expect(await decide('maria')).toBe(1);
  const applied = (
    await call(
      'GET',
      `/api/v1/models/project.change/${change.json.id}?fields=state,previousDateEnd,appliedAt`,
      'maria',
    )
  ).json;
  expect(applied).toMatchObject({ state: 'applied', previousDateEnd: '2027-06-30' });
  expect(
    (
      await call(
        'GET',
        `/api/v1/models/project.project/${p.json.id}?fields=dateEnd,baselineEnd`,
        'maria',
      )
    ).json,
  ).toMatchObject({ dateEnd: '2027-07-14', baselineEnd: '2027-07-14' });

  // A status report: the figures and open risks filled in; sent, it is posted on the project; the sponsor follows.
  const draft = await call('POST', '/api/v1/models/project.status.report/onchange', 'rahim', {
    values: { project: p.json.id },
    changed: ['project'],
  });
  expectStatus(draft, 200);
  expect(draft.json.values.health).toBe('on_track');
  expect(draft.json.values.risks).toContain('Monsoon floods the site');
  const report = await call('POST', '/api/v1/models/project.status.report', 'rahim', {
    project: p.json.id,
    health: draft.json.values.health,
    progress: draft.json.values.progress,
    risks: draft.json.values.risks,
    done: 'Plinth raised.',
    next: 'Walls.',
  });
  expectStatus(report, 201);
  expectStatus(
    await call(
      'POST',
      `/api/v1/models/project.status.report/${report.json.id}/transitions/send`,
      'rahim',
    ),
    200,
  );
  const chatter = await call('GET', `/api/v1/chatter/project.project/${p.json.id}`, 'maria');
  expectStatus(chatter, 200);
  expect(JSON.stringify(chatter.json)).toContain('Plinth raised.');
  expect(JSON.stringify(chatter.json.followers ?? chatter.json)).toContain(String(idOf('sumi')));
  // Sent reports are no longer the author's to change.
  expectStatus(
    await call('PATCH', `/api/v1/models/project.status.report/${report.json.id}`, 'rahim', {
      done: 'Changed afterwards',
    }),
    403,
  );
});

test('the schedule (RFC 0026 step 5): the critical path, waiting tasks moved after a slip, repeating tasks', async () => {
  const p = await call('POST', '/api/v1/models/project.project', 'maria', {
    name: 'Layer house',
    dateStart: '2027-03-01',
  });
  expectStatus(p, 201);
  const task = async (name: string, dateStart: string, deadline: string, extra = {}) => {
    const r = await call('POST', '/api/v1/models/project.task', 'rahim', {
      name,
      project: p.json.id,
      stage: stages['New'],
      dateStart,
      deadline,
      ...extra,
    });
    expectStatus(r, 201);
    return r.json.id as number;
  };
  const a = await task('Dig', '2027-03-01', '2027-03-03');
  const b = await task('Pour', '2027-03-04', '2027-03-08');
  const c = await task('Order roof', '2027-03-04', '2027-03-05');
  for (const [pred, succ] of [
    [a, b],
    [a, c],
  ])
    expectStatus(
      await call('POST', '/api/v1/models/project.task.link', 'rahim', {
        predecessor: pred,
        successor: succ,
      }),
      201,
    );
  expectStatus(
    await call('POST', '/api/v1/models/project.task', 'rahim', {
      name: 'Backwards',
      project: p.json.id,
      dateStart: '2027-03-05',
      deadline: '2027-03-01',
    }),
    422,
  );
  const schedule = await call('GET', `/api/v1/projects/${p.json.id}/schedule`, 'rahim');
  expectStatus(schedule, 200);
  const byId = new Map((schedule.json.tasks as Json[]).map((t) => [t.id, t]));
  expect(byId.get(a).critical).toBe(true);
  expect(byId.get(b).critical).toBe(true);
  expect(byId.get(c)).toMatchObject({ critical: false, float: 3 });
  expectStatus(await call('GET', `/api/v1/projects/${p.json.id}/schedule`, 'bob'), 403);

  // Dig slips two days: Pour and Order roof move two days later, keeping their length.
  expectStatus(
    await call('PATCH', `/api/v1/models/project.task/${a}`, 'rahim', { deadline: '2027-03-05' }),
    200,
  );
  const applied = await call('POST', `/api/v1/projects/${p.json.id}/schedule/apply`, 'rahim', {});
  expectStatus(applied, 200);
  expect(applied.json.moved).toHaveLength(2);
  expect(
    (await call('GET', `/api/v1/models/project.task/${b}?fields=dateStart,deadline`, 'rahim')).json,
  ).toMatchObject({ dateStart: '2027-03-06', deadline: '2027-03-10' });

  // A weekly inspection, done: the next one is made a week later by the refresh, once.
  const weekly = await task('Inspection', '2027-03-01', '2027-03-01', {
    repeatEvery: 1,
    repeatUnit: 'week',
    repeatUntil: '2027-03-31',
  });
  expectStatus(
    await call('PATCH', `/api/v1/models/project.task/${weekly}`, 'rahim', {
      stage: stages['Done'],
    }),
    200,
  );
  for (let i = 0; i < 2; i += 1)
    expectStatus(
      await call('POST', '/api/v1/projects/refresh', 'maria', { projects: [p.json.id] }),
      200,
    );
  const next = (await call('GET', `/api/v1/models/project.task/${weekly}?fields=nextTask`, 'rahim'))
    .json.nextTask;
  expect(next).toEqual(expect.any(Number));
  expect(
    (
      await call(
        'GET',
        `/api/v1/models/project.task/${next}?fields=name,dateStart,deadline,done,repeatEvery`,
        'rahim',
      )
    ).json,
  ).toMatchObject({
    name: 'Inspection',
    dateStart: '2027-03-08',
    deadline: '2027-03-08',
    done: false,
    repeatEvery: 1,
  });
  const copies = await call(
    'GET',
    `/api/v1/models/project.task?filter=${encodeURIComponent(JSON.stringify({ project: p.json.id, name: 'Inspection' }))}&fields=id`,
    'rahim',
  );
  expect(copies.json.items).toHaveLength(2);
});

test('duplicate (RFC 0023 R1): a copy as the user — lines with it, numbers new, unique fields left out', async () => {
  const p = await call('POST', '/api/v1/models/project.project', 'maria', {
    name: 'Template farm',
    description: 'Copy me',
    phases: { create: [{ name: 'Survey' }, { name: 'Build' }] },
  });
  expectStatus(p, 201);
  const copy = await call('POST', `/api/v1/models/project.project/${p.json.id}/duplicate`, 'maria');
  expectStatus(copy, 201);
  expect(copy.json.id).not.toBe(p.json.id);
  expect(copy.json).toMatchObject({ name: 'Template farm', description: 'Copy me' });
  expect(copy.json.code).not.toBe(p.json.code); // a new number
  const phases = await call(
    'GET',
    `/api/v1/models/project.phase?filter=${encodeURIComponent(JSON.stringify({ project: copy.json.id }))}&fields=name`,
    'maria',
  );
  expect((phases.json.items as Json[]).map((x) => x.name).sort()).toEqual(['Build', 'Survey']);
  // A unique code is not copied as it is: required, it gets "(copy)".
  const type = await call('POST', '/api/v1/models/project.type', 'maria', {
    name: 'Shed',
    code: 'SHED',
  });
  const typeCopy = await call(
    'POST',
    `/api/v1/models/project.type/${type.json.id}/duplicate`,
    'maria',
  );
  expectStatus(typeCopy, 201);
  expect(typeCopy.json).toMatchObject({ name: 'Shed', code: 'SHED (copy)' });
  // Without the right to create, no copy.
  expectStatus(
    await call('POST', `/api/v1/models/project.type/${type.json.id}/duplicate`, 'rahim'),
    403,
  );
});

test('in Bangla (RFC 0023 §3.1): menus and a form’s field labels come translated; English stays the default', async () => {
  const token = (
    await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'rahim', password: PASSWORD },
    })
  ).json().token as string;
  const get = (url: string, lang?: string) =>
    host.server.app.inject({
      method: 'GET',
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(lang === undefined ? {} : { 'accept-language': lang }),
      },
    });
  const labels = (menus: Json[]): string[] =>
    menus.flatMap((m) => [String(m.label), ...labels((m.children as Json[] | undefined) ?? [])]);
  const bn = labels(
    (await get('/api/v1/menus', 'bn-BD,bn;q=0.9')).json().menus ??
      (await get('/api/v1/menus', 'bn')).json(),
  );
  expect(bn).toContain('প্রকল্প');
  const en = labels(
    (await get('/api/v1/menus')).json().menus ?? (await get('/api/v1/menus')).json(),
  );
  expect(en).toContain('Projects');
  const form = (await get('/api/v1/views/project.task.form', 'bn')).json();
  expect(form.fields['project.task'].deadline.label).toBe('শেষ সময়');
});
