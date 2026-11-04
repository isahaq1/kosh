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
