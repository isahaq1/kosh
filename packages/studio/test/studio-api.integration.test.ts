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
  const studio = createStudio({ mode: 'write', root: project, generate });
  const catalogue = [base, crm, studio];
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['crm', 'studio'] }, dir }),
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
    ['designer', ['studio.manager', 'crm.user']],
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
    catalogue: [base, crm, createStudio({ mode: 'propose', root: production, generate })],
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
  ] as const) {
    expect((await http(method, path, { body })).status, path).toBe(401);
    const bob = await http(method, path, { as: 'bob', body });
    expect(bob.status, path).toBe(403);
    expect(bob.json.title).toBe('Studio managers only');
  }
  const { status, json } = await http('GET', '/api/v1/studio', { as: 'designer' });
  expect(status).toBe(200);
  expect(json).toEqual({ mode: 'write', modules: [] });
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
