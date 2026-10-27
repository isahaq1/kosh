/**
 * Projects in the portal on real PostgreSQL (RFC 0015 step 4): a customer's portal user sees the projects made for
 * their company and those projects' open tasks — through the task's project, whatever the task's own customer — and
 * nothing of another customer's projects; done tasks leave the portal.
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
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { projectPortal } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, projectPortal];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
const tokens = new Map<string, string>();
const ids: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(method: 'GET' | 'POST', url: string, as: string, payload?: unknown) {
  let token = tokens.get(as);
  if (token === undefined) {
    const res = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    token = (res.json() as { token: string }).token;
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

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-project-portal-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['project_portal'] }, dir }),
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
  const maria = await auth.createUser({
    login: 'maria',
    name: 'Maria',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['project.manager', 'portal.manager'],
  });
  type Model = { create(rows: unknown[]): Promise<{ ids: number[] }> };
  await host.server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    const model = (name: string) => env.model(name as never) as unknown as Model;
    const [acme, globex] = (
      await model('res.partner').create([
        { name: 'Acme Trading', isCompany: true },
        { name: 'Globex', isCompany: true },
      ])
    ).ids;
    const [rina] = (
      await model('res.partner').create([
        { name: 'Rina Akter', email: 'rina@acme.test', parent: acme },
      ])
    ).ids;
    const [stages] = await Promise.all([
      env.sql<{
        id: number;
        done: boolean;
      }>`SELECT id, done FROM project_task_stage ORDER BY sequence`,
    ]);
    const open = stages?.find((s) => !s.done)?.id;
    const closed = stages?.find((s) => s.done)?.id;
    const [warehouse, other] = (
      await model('project.project').create([
        { name: 'Warehouse fit-out', partner: acme, manager: maria },
        { name: 'Globex audit', partner: globex, manager: maria },
      ])
    ).ids;
    const tasks = (
      await model('project.task').create([
        { name: 'Measure the racks', project: warehouse, stage: open }, // no customer of its own
        { name: 'Install lighting', project: warehouse, stage: closed }, // done
        { name: 'Audit the books', project: other, stage: open },
      ])
    ).ids;
    Object.assign(ids, {
      acme,
      rina,
      warehouse,
      other,
      open: tasks[0],
      done: tasks[1],
      theirs: tasks[2],
    });
    await env.flush();
  });
  const granted = await call('POST', '/api/v1/portal/access', 'maria', { partner: ids['rina'] });
  const token = new URL(granted.json.activationUrl).searchParams.get('token');
  await host.server.app.inject({
    method: 'POST',
    url: '/api/portal/v1/activate',
    payload: { token, password: PASSWORD },
  });
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

const RINA = 'rina@acme.test';

test('the projects made for the customer’s company, and their open tasks through the project', async () => {
  const types = await call('GET', '/api/portal/v1/documents', RINA);
  expect(types.json.documents).toEqual([
    { key: 'projects', label: 'Projects', count: 1 },
    { key: 'tasks', label: 'Tasks', count: 1 },
  ]);
  const project = await call('GET', `/api/portal/v1/documents/projects/${ids['warehouse']}`, RINA);
  expect(project.json.record).toMatchObject({
    name: 'Warehouse fit-out',
    manager: { name: 'Maria' },
  });
  const tasks = await call('GET', '/api/portal/v1/documents/tasks', RINA);
  expect(tasks.json.items.map((t: Json) => t.id)).toEqual([ids['open']]);
  expect(tasks.json.items[0].project).toEqual({ id: ids['warehouse'], name: 'Warehouse fit-out' });
  for (const [type, id] of [
    ['projects', ids['other']],
    ['tasks', ids['theirs']],
    ['tasks', ids['done']],
  ] as const)
    expect((await call('GET', `/api/portal/v1/documents/${type}/${id}`, RINA)).status).toBe(404);
  const posted = await call('POST', `/api/portal/v1/documents/tasks/${ids['open']}/thread`, RINA, {
    body: 'The racks are 2.4 m high.',
  });
  expect(posted.status).toBe(201);
  // The project's internals stay closed.
  expect((await call('GET', '/api/v1/models/project.task', RINA)).status).toBe(403);
});
