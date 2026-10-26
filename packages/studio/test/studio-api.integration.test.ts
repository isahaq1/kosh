/**
 * The Studio API through the app host, on real PostgreSQL and real HTTP (RFC 0012 step 3): only Administrators and
 * Studio managers reach it; a preview shows the version, the diff and the SQL and writes nothing; apply installs the
 * module (its field is served at once by the REST API, its files are in the project, it is listed in
 * src/modules.ts), a second apply upgrades it to the next patch version; a stale plan, a taken name and an invalid
 * spec are refused; propose mode returns a patch, refuses to apply and writes nothing.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationModule } from '@kosh/automation';
import { permissions } from '@kosh/permissions';
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
import { createStudio, type StudioSpec } from '../src/index.js';
import { crm } from './fixtures/crm.js';

const PASSWORD = 'correct horse battery';
const generated = join(import.meta.dirname, '.generated-api');
const project = join(generated, 'project');
const production = join(generated, 'production');
/** The generated modules import the workspace packages, and the fixture app from five folders up. */
const generate = {
  imports: 'workspace',
  moduleImport: (name: string) => (name === 'crm' ? '../../../../../fixtures/crm.js' : undefined),
} as const;
/** A fake GitHub: every call is recorded; the branch, the files and the pull request are accepted. */
const githubCalls: { method: string; path: string; body: Record<string, unknown> }[] = [];
const github = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const body = (init?.body === undefined ? {} : JSON.parse(String(init.body))) as Record<
    string,
    unknown
  >;
  githubCalls.push({ method, path: url.pathname, body });
  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
  if (url.pathname.endsWith('/git/ref/heads/main')) return json(200, { object: { sha: 'base' } });
  if (url.pathname.endsWith('/git/refs')) return json(201, {});
  if (method === 'GET' && url.pathname.includes('/contents/'))
    return json(404, { message: 'Not Found' });
  if (method === 'PUT') return json(201, {});
  if (url.pathname.endsWith('/pulls'))
    return json(201, { html_url: 'https://github.com/acme/erp/pull/1' });
  return json(500, { message: 'unexpected' });
}) as typeof fetch;
const MODULES_TS = `import { base } from 'kosh-erp';\n\nexport const modules = [base];\n`;

const spec: StudioSpec = {
  name: 'acme',
  label: 'Acme customizations',
  version: '0.1.0',
  depends: ['crm'],
  fields: [{ model: 'res.partner', name: 'gstNumber', type: 'char', label: 'GST number' }],
  models: [
    {
      name: 'vehicle',
      label: 'Vehicle',
      fields: [{ name: 'plate', type: 'char', label: 'Plate', required: true }],
    },
  ],
  viewChanges: [
    { view: 'res.partner.form', operations: [{ insertAfter: 'email', fields: ['gstNumber'] }] },
  ],
};

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let proposer: AppHost;
let url: string;
let proposeUrl: string;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function http(
  method: string,
  path: string,
  options: { as?: string; body?: unknown; base?: string } = {},
): Promise<{ status: number; json: Json }> {
  const at = options.base ?? url;
  const token = options.as === undefined ? undefined : await tokenOf(at, options.as);
  const res = await fetch(`${at}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : JSON.parse(text) };
}
async function tokenOf(at: string, login: string): Promise<string> {
  const key = `${at} ${login}`;
  const cached = tokens.get(key);
  if (cached !== undefined) return cached;
  const session = await fetch(`${at}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password: PASSWORD }),
  });
  const token = ((await session.json()) as { token: string }).token;
  tokens.set(key, token);
  return token;
}
const entries = async (path: string): Promise<string[]> =>
  existsSync(path) ? (await readdir(path, { recursive: true })).map(String).sort() : [];

beforeAll(async () => {
  await rm(generated, { recursive: true, force: true });
  for (const root of [project, production]) {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'modules.ts'), MODULES_TS);
  }
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-studio-'));
  const studio = createStudio({ mode: 'write', root: project, generate, git: null });
  const catalogue = [base, crm, studio, permissions, automationModule({ workers: false })];
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['crm', 'studio', 'permissions', 'automation'] },
      dir,
    }),
    { driver, dir, actor: 'test' },
  );
  const common = {
    databaseUrl: container.getConnectionUri(),
    migrationsDir: dir,
    logger: false,
    listen: false,
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
  } as const;
  host = await createAppHost({ ...common, catalogue });
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const { company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  for (const [login, groups] of [
    ['designer', ['studio.manager', 'crm.user', 'automation.manager']],
    ['bob', ['crm.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  url = await host.listen({ port: 0, host: '127.0.0.1' });
  proposer = await createAppHost({
    ...common,
    catalogue: [
      base,
      crm,
      createStudio({
        mode: 'propose',
        root: production,
        generate,
        git: {
          provider: 'github',
          repository: 'acme/erp',
          api: 'https://api.github.test',
          token: 'ghp_secret',
          base: 'main',
          fetch: github,
        },
      }),
      permissions,
      automationModule({ workers: false }),
    ],
  });
  proposeUrl = await proposer.listen({ port: 0, host: '127.0.0.1' });
}, 180_000);

afterAll(async () => {
  await proposer?.close();
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
  await rm(generated, { recursive: true, force: true });
});

test('only Administrators and Studio managers reach Studio', async () => {
  for (const [method, path, body] of [
    ['GET', '/api/v1/studio', undefined],
    ['GET', '/api/v1/studio/modules/acme', undefined],
    ['POST', '/api/v1/studio/preview', { spec }],
    ['POST', '/api/v1/studio/apply', { spec, planId: 'x' }],
    ['POST', '/api/v1/studio/propose', { spec }],
    [
      'POST',
      '/api/v1/studio/edit',
      {
        edit: {
          kind: 'show',
          view: 'res.partner.list',
          field: 'email',
          anchor: { insertAfter: 'city' },
        },
      },
    ],
  ] as const) {
    expect((await http(method, path, { body })).status, path).toBe(401);
    const bob = await http(method, path, { as: 'bob', body });
    expect(bob.status, path).toBe(403);
    expect(bob.json.title).toBe('Studio managers only');
  }
  const { status, json } = await http('GET', '/api/v1/studio', { as: 'designer' });
  expect(status).toBe(200);
  expect(json).toEqual({ mode: 'write', modules: [], git: null });
});

test('invalid specs and taken names are refused', async () => {
  const bad = await http('POST', '/api/v1/studio/preview', {
    as: 'designer',
    body: { spec: { ...spec, fields: [{ ...spec.fields?.[0], type: 'blob' }] } },
  });
  expect(bad.status).toBe(400);
  expect(bad.json.detail).toContain('fields[0].type');
  const missing = await http('POST', '/api/v1/studio/preview', {
    as: 'designer',
    body: { spec: { ...spec, depends: ['crm', 'payroll'] } },
  });
  expect(missing.status).toBe(400);
  expect(missing.json.detail).toContain('payroll');
  const taken = await http('POST', '/api/v1/studio/preview', {
    as: 'designer',
    body: { spec: { ...spec, name: 'crm' } },
  });
  expect(taken.status).toBe(409);
  expect(taken.json.title).toBe('The name is taken');
  const anchor = await http('POST', '/api/v1/studio/preview', {
    as: 'designer',
    body: {
      spec: {
        ...spec,
        viewChanges: [
          {
            view: 'res.partner.form',
            operations: [{ insertAfter: 'phone', fields: ['gstNumber'] }],
          },
        ],
      },
    },
  });
  expect(anchor.status).toBe(422);
  expect(anchor.json.title).toBe('A view change does not apply');
  expect(anchor.json.detail).toContain('phone');
});

test('edit: a change made in Studio mode becomes the spec to review', async () => {
  const { status, json } = await http('POST', '/api/v1/studio/edit', {
    as: 'designer',
    body: {
      module: 'acme',
      label: 'Acme customizations',
      edit: {
        kind: 'field',
        model: 'res.partner',
        field: { label: 'GST number', type: 'char' },
        view: 'res.partner.form',
        anchor: { insertAfter: 'email' },
      },
    },
  });
  expect(status).toBe(200);
  expect(json.spec).toEqual({
    name: 'acme',
    label: 'Acme customizations',
    version: '0.1.0',
    depends: ['crm'],
    fields: [{ model: 'res.partner', name: 'gstNumber', label: 'GST number', type: 'char' }],
    viewChanges: [
      { view: 'res.partner.form', operations: [{ insertAfter: 'email', fields: ['gstNumber'] }] },
    ],
  });
  const unknown = await http('POST', '/api/v1/studio/edit', {
    as: 'designer',
    body: {
      edit: { kind: 'field', model: 'hr.employee', field: { label: 'Badge', type: 'char' } },
    },
  });
  expect(unknown.status).toBe(400);
  expect(unknown.json.detail).toBe('The model hr.employee is not served here.');
  const bad = await http('POST', '/api/v1/studio/edit', {
    as: 'designer',
    body: { edit: { kind: 'drop' } },
  });
  expect(bad.status).toBe(400);
});

test('preview: the diff and the SQL, nothing written', async () => {
  const { status, json } = await http('POST', '/api/v1/studio/preview', {
    as: 'designer',
    body: { spec },
  });
  expect(status).toBe(200);
  expect(json.change).toBe('install');
  expect(json.from).toBeNull();
  expect(json.spec.version).toBe('0.1.0');
  expect(json.destructive).toBe(false);
  const sql = (json.statements as string[]).join('\n');
  expect(sql).toMatch(/ALTER TABLE "res_partner" ADD COLUMN "x_acme_gst_number"/);
  expect(sql).toMatch(/CREATE TABLE "x_acme_vehicle"/);
  expect((json.diff as Json[]).map((d) => d.path)).toEqual([
    'src/modules/acme/studio.json',
    'src/modules/acme/models.ts',
    'src/modules/acme/index.ts',
    'src/modules/acme/README.md',
    'src/modules.ts',
  ]);
  expect(json.diff[0].diff).toContain('new file mode 100644');
  expect(json.diff[4].diff).toContain("+import { acme } from './modules/acme/index.ts';");
  expect(json.diff[4].diff).toContain('+export const modules = [base, acme];');
  expect(await entries(join(project, 'src'))).toEqual(['modules.ts']);
  expect(await entries(join(project, '.kosh-studio', 'plan'))).toEqual([]);
});

test('propose mode: a pull request on the configured repository, nothing written; none without one', async () => {
  const fleet: StudioSpec = { ...spec, name: 'fleet', viewChanges: [] };
  const info = await http('GET', '/api/v1/studio', { as: 'designer', base: proposeUrl });
  expect(info.json.git).toEqual({ provider: 'github', repository: 'acme/erp', base: 'main' }); // never the token
  const opened = await http('POST', '/api/v1/studio/propose', {
    as: 'designer',
    base: proposeUrl,
    body: { spec: fleet, pullRequest: true },
  });
  expect(opened.status).toBe(200);
  expect(opened.json.pullRequest).toEqual({
    url: 'https://github.com/acme/erp/pull/1',
    branch: 'studio/fleet-0.1.0',
  });
  const puts = githubCalls
    .filter((c) => c.method === 'PUT')
    .map((c) => c.path.replace('/repos/acme/erp/contents/', ''));
  expect(puts).toEqual([
    'src/modules/fleet/studio.json',
    'src/modules/fleet/models.ts',
    'src/modules/fleet/index.ts',
    'src/modules/fleet/README.md',
    'src/modules.ts',
  ]);
  const pull = githubCalls.find((c) => c.path.endsWith('/pulls'));
  expect(pull?.body['title']).toBe('Studio: Acme customizations 0.1.0');
  expect(String(pull?.body['body'])).toContain('npx kosh apps install fleet');
  expect(String(pull?.body['body'])).toMatch(/ADD COLUMN "x_fleet_gst_number"/);
  // The server wrote nothing.
  expect(await entries(join(production, 'src'))).toEqual(['modules.ts']);
  // Without a repository: refused, the patch still works.
  const none = await http('POST', '/api/v1/studio/propose', {
    as: 'designer',
    body: { spec: fleet, pullRequest: true },
  });
  expect(none.status).toBe(409);
  expect(none.json.title).toBe('No repository for proposals');
  expect(
    (
      await http('POST', '/api/v1/studio/propose', {
        as: 'designer',
        base: proposeUrl,
        body: { spec: fleet },
      })
    ).json.pullRequest,
  ).toBeUndefined();
});

test('propose mode: a patch, no apply, nothing written', async () => {
  const fleet: StudioSpec = { ...spec, name: 'fleet', viewChanges: [] };
  const proposal = await http('POST', '/api/v1/studio/propose', {
    as: 'designer',
    base: proposeUrl,
    body: { spec: fleet },
  });
  expect(proposal.status).toBe(200);
  expect(proposal.json.change).toBe('install');
  expect(proposal.json.statements.join('\n')).toMatch(/ADD COLUMN "x_fleet_gst_number"/);
  const patch = proposal.json.patch as string;
  expect(patch).toContain(
    'diff --git a/src/modules/fleet/studio.json b/src/modules/fleet/studio.json',
  );
  expect(patch).toContain('+++ b/src/modules/fleet/models.ts');
  expect(patch).toContain("+import { fleet } from './modules/fleet/index.ts';");

  const preview = await http('POST', '/api/v1/studio/preview', {
    as: 'designer',
    base: proposeUrl,
    body: { spec: fleet },
  });
  const apply = await http('POST', '/api/v1/studio/apply', {
    as: 'designer',
    base: proposeUrl,
    body: { spec: fleet, planId: preview.json.planId },
  });
  expect(apply.status).toBe(409);
  expect(apply.json.title).toBe('Studio proposes changes here');
  expect(await entries(join(production, 'src'))).toEqual(['modules.ts']);
  expect(await readFile(join(production, 'src', 'modules.ts'), 'utf8')).toBe(MODULES_TS);
  const [row] = await driver.query<{ n: string }>({
    text: "SELECT count(*)::text AS n FROM kosh_module WHERE name = 'fleet'",
    params: [],
  });
  expect(row?.n).toBe('0');
});

test('apply: installed, served at once, written to the project; a stale plan is refused', async () => {
  const preview = await http('POST', '/api/v1/studio/preview', { as: 'designer', body: { spec } });
  const stale = await http('POST', '/api/v1/studio/apply', {
    as: 'designer',
    body: { spec: { ...spec, label: 'Changed' }, planId: preview.json.planId },
  });
  expect(stale.status).toBe(409);
  expect(stale.json.title).toBe('The plan changed');

  const applied = await http('POST', '/api/v1/studio/apply', {
    as: 'designer',
    body: { spec, planId: preview.json.planId },
  });
  expect(applied.status).toBe(200);
  expect(applied.json).toMatchObject({
    name: 'acme',
    version: '0.1.0',
    change: 'install',
    installed: ['acme'],
  });
  expect(applied.json.written).toContain('src/modules.ts');

  // The REST API serves the new field right away.
  const created = await http('POST', '/api/v1/models/res.partner', {
    as: 'designer',
    body: { name: 'Meghna Foods', xAcmeGstNumber: '29ABCDE1234F1Z5' },
  });
  expect(created.status).toBe(201);
  const read = await http('GET', `/api/v1/models/res.partner/${created.json.id}`, {
    as: 'designer',
  });
  expect(read.json.xAcmeGstNumber).toBe('29ABCDE1234F1Z5');

  // The project has the module, listed in src/modules.ts.
  expect(await entries(join(project, 'src', 'modules', 'acme'))).toEqual([
    'README.md',
    'index.ts',
    'models.ts',
    'studio.json',
  ]);
  expect(JSON.parse(await readFile(join(project, 'src/modules/acme/studio.json'), 'utf8'))).toEqual(
    spec,
  );
  expect(await readFile(join(project, 'src/modules.ts'), 'utf8')).toContain(
    'export const modules = [base, acme];',
  );
  const listed = await http('GET', '/api/v1/studio', { as: 'designer' });
  expect(listed.json.modules).toEqual([
    { name: 'acme', label: 'Acme customizations', version: '0.1.0' },
  ]);
});

test('a second apply upgrades the module to its next patch version', async () => {
  const next: StudioSpec = {
    ...spec,
    fields: [
      ...(spec.fields ?? []),
      {
        model: 'res.partner',
        name: 'tier',
        type: 'selection',
        label: 'Tier',
        options: { gold: 'Gold', silver: 'Silver' },
      },
    ],
  };
  const preview = await http('POST', '/api/v1/studio/preview', {
    as: 'designer',
    body: { spec: next },
  });
  expect(preview.status).toBe(200);
  expect(preview.json).toMatchObject({ change: 'upgrade', from: '0.1.0' });
  expect(preview.json.spec.version).toBe('0.1.1');
  expect(preview.json.statements).toHaveLength(1);
  expect(preview.json.statements[0]).toMatch(/ADD COLUMN "x_acme_tier"/);
  const paths = (preview.json.diff as Json[]).map((d) => d.path);
  expect(paths).not.toContain('src/modules.ts');
  const models = (preview.json.diff as Json[]).find((d) => d.path.endsWith('models.ts'));
  expect(models.diff).toContain('+    xAcmeTier: f.selection(');
  expect(models.diff).not.toContain('new file mode');

  const applied = await http('POST', '/api/v1/studio/apply', {
    as: 'designer',
    body: { spec: next, planId: preview.json.planId },
  });
  expect(applied.status).toBe(200);
  expect(applied.json).toMatchObject({ change: 'upgrade', version: '0.1.1', upgraded: ['acme'] });
  const meta = await http('GET', '/api/v1/meta/res.partner', { as: 'designer' });
  expect(JSON.stringify(meta.json)).toContain('xAcmeTier');
  const module = await http('GET', '/api/v1/studio/modules/acme', { as: 'designer' });
  expect(module.json.spec.version).toBe('0.1.1');
  expect(Object.keys(module.json.files).sort()).toEqual(['README.md', 'index.ts', 'models.ts']);
  const [row] = await driver.query<{ version: string }>({
    text: 'SELECT version FROM kosh_module WHERE name = $1',
    params: ['acme'],
  });
  expect(row?.version).toBe('0.1.1');
});

test('a rule made in the Automation app moves into the module; an approval policy; the original is archived', async () => {
  const made = await http('POST', '/api/v1/models/automation.rule', {
    as: 'designer',
    body: {
      name: 'Welcome note',
      targetModel: 'res.partner',
      trigger: 'created',
      actions: [{ kind: 'note', text: 'Welcome {{name}}' }],
    },
  });
  expect(made.status).toBe(201);
  const listed = await http('GET', '/api/v1/studio/rules', { as: 'designer' });
  expect(listed.json.rules).toEqual([
    {
      id: made.json.id,
      name: 'Welcome note',
      targetModel: 'res.partner',
      trigger: 'created',
      enabled: true,
    },
  ]);

  const moved = await http('POST', '/api/v1/studio/edit', {
    as: 'designer',
    body: { module: 'acme', edit: { kind: 'move-rule', rule: made.json.id } },
  });
  expect(moved.status).toBe(200);
  expect(moved.json.retire).toEqual([made.json.id]);
  expect(moved.json.spec.automationRules).toEqual([
    {
      id: 'welcome_note',
      name: 'Welcome note',
      model: 'res.partner',
      trigger: 'created',
      actions: [{ kind: 'note', text: 'Welcome {{name}}' }],
      runAs: 'actor',
      logOnRecord: false,
      sequence: 10,
      enabled: true,
    },
  ]);
  expect(moved.json.spec.depends).toEqual(['automation', 'crm']);
  // The edits build on the module's spec in the project: add the approval policy to the moved rule's spec.
  const withPolicy = await http('POST', '/api/v1/studio/edit', {
    as: 'designer',
    body: {
      module: 'acme',
      edit: {
        kind: 'approval',
        approval: {
          name: 'Big customers',
          model: 'res.partner',
          levels: [{ name: 'Manager', approverRole: 'crm.user' }],
        },
      },
    },
  });
  expect(withPolicy.json.spec.depends).toEqual(['crm', 'permissions']);
  const spec = {
    ...moved.json.spec,
    approvals: withPolicy.json.spec.approvals,
    depends: ['automation', 'crm', 'permissions'],
  };

  const preview = await http('POST', '/api/v1/studio/preview', { as: 'designer', body: { spec } });
  expect(preview.status).toBe(200);
  const index = (preview.json.diff as Json[]).find((d) => d.path.endsWith('index.ts'));
  expect(index.diff).toContain('+  automationRules: {');
  expect(index.diff).toContain('+  approvals: [');
  const applied = await http('POST', '/api/v1/studio/apply', {
    as: 'designer',
    body: { spec, planId: preview.json.planId, retire: [made.json.id] },
  });
  expect(applied.status).toBe(200);
  expect(applied.json.retired).toEqual([made.json.id]);

  const rules = await driver.query<{
    id: number;
    module: string | null;
    module_key: string | null;
    active: boolean;
  }>({
    text: 'SELECT id, module, module_key, active FROM automation_rule ORDER BY id',
    params: [],
  });
  expect(rules).toEqual([
    { id: made.json.id, module: null, module_key: null, active: false },
    { id: expect.any(Number), module: 'acme', module_key: 'welcome_note', active: true },
  ]);
  const policies = await driver.query<{ name: string }>({
    text: 'SELECT name FROM approval_policy ORDER BY id',
    params: [],
  });
  expect(policies.map((p) => p.name)).toContain('Big customers');
  // A rule shipped by a module is changed in the module, not moved again.
  const owned = rules.find((r) => r.module === 'acme');
  const again = await http('POST', '/api/v1/studio/edit', {
    as: 'designer',
    body: { module: 'acme', edit: { kind: 'move-rule', rule: owned?.id } },
  });
  expect(again.status).toBe(409);
});
