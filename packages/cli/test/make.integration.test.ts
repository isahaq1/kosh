/**
 * What `shutro-erp make` writes, running (RFC 0036 §2.2): a module made by `module create`, a model, a field and
 * two transitions made by `make`, installed on real PostgreSQL and served — a user of the module creates a record
 * through the API, takes it through its steps and finds its print template; someone without the module's role is
 * refused by the server.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { messaging } from '@kosh/messaging';
import type { KoshModule } from '@kosh/modules-sdk';
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
import { type TestDatabase, testDatabase } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { runCli } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const project = join(fileURLToPath(import.meta.url), '..', '.tmp-make-live');
const VIEWS = pathToFileURL(
  join(fileURLToPath(import.meta.url), '..', '..', '..', 'views', 'src', 'index.ts'),
).href;

let container: TestDatabase;
let driver: Driver;
let dir: string;
let host: AppHost;

const make = async (...args: string[]) => {
  let out = '';
  const code = await runCli(
    args,
    (t) => {
      out += t;
    },
    { cwd: project },
  );
  expect(code, out).toBe(0);
};

/** Points the generated files at the workspace packages `shutro-erp` is built from. */
async function inWorkspace(folder: string): Promise<void> {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await inWorkspace(path);
    else if (entry.name.endsWith('.ts'))
      await writeFile(
        path,
        (await readFile(path, 'utf8'))
          .replaceAll("'shutro-erp/orm'", "'@kosh/server/orm'")
          .replaceAll("'shutro-erp/modules-sdk'", "'@kosh/modules-sdk'")
          .replaceAll("'shutro-erp/views'", `'${VIEWS}'`)
          .replaceAll("'shutro-erp/messaging'", "'@kosh/messaging'")
          .replaceAll("'shutro-erp/reporting'", "'@kosh/reporting'")
          .replaceAll("'shutro-erp'", "'@kosh/server'"),
      );
  }
}

const tokens = new Map<string, string>();
// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST',
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

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  // The module, made by the commands.
  await rm(project, { recursive: true, force: true });
  await mkdir(join(project, 'src'), { recursive: true });
  await make('module', 'create', 'library');
  await make(
    'make',
    'model',
    'library',
    'loan',
    '--fields',
    'reference:char! due:date kind:selection:short|long notes:text',
  );
  await make('make', 'field', 'library.loan', 'pages:integer');
  await make(
    'make',
    'transition',
    'library.loan',
    'confirm',
    '--from',
    'draft',
    '--to',
    'confirmed',
  );
  await make(
    'make',
    'transition',
    'library.loan',
    'close',
    '--from',
    'confirmed',
    '--to',
    'returned',
  );
  await make('make', 'action', 'library.loan', 'settle', '--from', 'returned', '--to', 'settled');
  await make('make', 'report', 'library.loan', '--measure', 'pages');
  await inWorkspace(join(project, 'src'));
  const { library } = (await import(
    pathToFileURL(join(project, 'src', 'modules', 'library', 'index.ts')).href
  )) as { library: KoshModule };

  container = await testDatabase();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-make-'));
  const catalogue = [base, messaging, reporting, library];
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['messaging', 'reporting', 'library'] },
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
  const { company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Library', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  for (const [login, groups] of [
    ['lina', ['library.user']],
    ['mona', ['library.manager']],
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
}, 300_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
  await container?.stop();
});

test('a user of the module creates a record, takes it through its steps and finds its print template', async () => {
  const created = await call('POST', '/api/v1/models/library.loan', 'lina', {
    reference: 'L-0001',
    due: '2026-12-01',
    kind: 'short',
    pages: 320,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.id as number;
  expect(created.json.state).toBe('draft');

  // A step out of order is refused; in order, each is taken.
  const early = await call('POST', `/api/v1/models/library.loan/${id}/transitions/close`, 'lina');
  expect(early.status).toBeGreaterThanOrEqual(400);
  const confirmed = await call(
    'POST',
    `/api/v1/models/library.loan/${id}/transitions/confirm`,
    'lina',
  );
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  expect(confirmed.json.state).toBe('confirmed');
  const closed = await call('POST', `/api/v1/models/library.loan/${id}/transitions/close`, 'lina');
  expect(closed.json.state).toBe('returned');

  // The list finds it by its reference (the search), and the print template is there.
  const found = await call('GET', '/api/v1/models/library.loan?search=L-0001', 'lina');
  expect(found.status).toBe(200);
  const templates = await call('GET', '/api/v1/models/library.loan/documents', 'lina');
  expect(templates.status, JSON.stringify(templates.json)).toBe(200);
  expect(templates.json.templates.map((t: { key: string }) => t.key)).toContain('library.loan');
  // A required field is required.
  const empty = await call('POST', '/api/v1/models/library.loan', 'lina', { due: '2026-12-01' });
  expect(empty.status).toBe(422);
});

test('someone without the module’s role is refused by the server', async () => {
  expect((await call('GET', '/api/v1/models/library.loan', 'bob')).status).toBe(403);
  expect(
    (await call('POST', '/api/v1/models/library.loan', 'bob', { reference: 'L-0002' })).status,
  ).toBe(403);
  // A user reads and writes, and does not delete: that is the manager's.
  const made = await call('POST', '/api/v1/models/library.loan', 'lina', { reference: 'L-0003' });
  const removed = await host.server.app.inject({
    method: 'DELETE',
    url: `/api/v1/models/library.loan/${made.json.id}`,
    headers: { authorization: `Bearer ${tokens.get('lina')}` },
  });
  expect(removed.statusCode).toBe(403);
});

test('an action is for those who hold its permission: a user is refused, a manager takes it', async () => {
  const made = await call('POST', '/api/v1/models/library.loan', 'lina', { reference: 'L-0004' });
  const id = made.json.id as number;
  for (const step of ['confirm', 'close'])
    expect(
      (await call('POST', `/api/v1/models/library.loan/${id}/transitions/${step}`, 'lina')).status,
    ).toBe(200);
  const refused = await call(
    'POST',
    `/api/v1/models/library.loan/${id}/transitions/settle`,
    'lina',
  );
  expect(refused.status, JSON.stringify(refused.json)).toBe(403);
  const settled = await call(
    'POST',
    `/api/v1/models/library.loan/${id}/transitions/settle`,
    'mona',
  );
  expect(settled.status, JSON.stringify(settled.json)).toBe(200);
  expect(settled.json.state).toBe('settled');
});

test('the sample record is seeded, and the report’s pivot answers', async () => {
  const sample = await call('GET', '/api/v1/models/library.loan?search=Sample', 'lina');
  expect(sample.status).toBe(200);
  expect(JSON.stringify(sample.json)).toContain('Sample reference');
  // The pivot's query: loans by state, their pages summed.
  const pivot = await call('POST', '/api/v1/models/library.loan/aggregate', 'lina', {
    groupBy: ['state'],
    measures: { pages: { sum: 'pages' }, count: 'count' },
  });
  expect(pivot.status, JSON.stringify(pivot.json)).toBe(200);
  expect(JSON.stringify(pivot.json)).toContain('settled');
});
