/**
 * The Studio generator (RFC 0012 step 1): a spec is validated with the place of every problem; it generates the
 * same bytes every time; the generated module loads with the apps it extends (the round trip): the fields are on
 * the models with their prefix, the own model exists with its access, the view extensions apply by node id, the
 * menus and actions are there; `kosh studio build` writes only what changed.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { base, buildKoshRegistry, publicApiModels, ViewRegistry } from '@kosh/server';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  buildModule,
  generateModule,
  lit,
  prefixedKey,
  runStudio,
  type StudioSpec,
  validateSpec,
} from '../src/index.js';
import { crm } from './fixtures/crm.js';

const spec: StudioSpec = {
  name: 'acme',
  label: 'Acme customizations',
  version: '0.1.0',
  description: "Acme's GST number, vehicles, and a column",
  depends: ['crm'],
  app: { label: 'Fleet', icon: 'box' },
  fields: [
    { model: 'res.partner', name: 'gstNumber', type: 'char', label: 'GST number', tracking: true },
    {
      model: 'res.partner',
      name: 'tier',
      type: 'selection',
      label: 'Tier',
      options: { gold: 'Gold', silver: 'Silver' },
      default: 'silver',
    },
    { model: 'res.partner', name: 'creditDays', type: 'integer', label: "Credit days (it's net)" },
  ],
  models: [
    {
      name: 'vehicle',
      label: 'Vehicle',
      archivable: true,
      fields: [
        { name: 'plate', type: 'char', label: 'Plate', required: true },
        { name: 'owner', type: 'many2one', label: 'Owner', target: 'res.partner' },
        { name: 'capacity', type: 'decimal', label: 'Capacity (t)', scale: 1 },
        { name: 'notes', type: 'text', label: 'Notes' },
      ],
    },
  ],
  viewChanges: [
    {
      view: 'res.partner.form',
      operations: [{ insertAfter: 'email', fields: ['gstNumber', 'tier'] }],
    },
    { view: 'res.partner.list', operations: [{ insertAfter: 'city', fields: ['tier'] }] },
  ],
  menus: [{ id: 'vehicles', label: 'Vehicles', model: 'vehicle' }],
};

const out = join(import.meta.dirname, '.generated', 'acme');
/** The workspace's packages, and the fixture app for `crm` (two folders up from a generated module). */
const workspace = {
  imports: 'workspace',
  moduleImport: (name: string) => (name === 'crm' ? '../../fixtures/crm.js' : undefined),
} as const;

beforeAll(async () => {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
});
afterAll(async () => {
  await rm(join(import.meta.dirname, '.generated'), { recursive: true, force: true });
});

test('validation: every problem with where it is', () => {
  expect(validateSpec(spec)).toEqual([]);
  const bad = validateSpec({
    name: 'Base',
    label: '',
    version: '1',
    depends: [],
    fields: [
      { model: 'res.partner', name: 'Gst', type: 'char', label: 'x' },
      { model: 'res.partner', name: 'kind', type: 'selection', label: 'Kind' },
      { model: 'res.partner', name: 'owner', type: 'many2one', label: 'Owner' },
    ],
    models: [{ name: 'thing', label: 'Thing', fields: [], recName: 'title' }],
    menus: [{ id: 'things', label: 'Things', model: 'thing' }],
  });
  expect(bad).toEqual([
    'name: lower-case letters, digits and _ (2–41 characters), not a reserved name',
    'label: required',
    'version: major.minor.patch',
    'fields[0].name: camelCase letters and digits, starting lower-case',
    'fields[1].options: a selection needs its options',
    'fields[2].target: the target model (res.partner)',
    'models[0].fields: at least one field',
    "models[0].recName: 'title' is not a field of the model",
    'menus[0].parent: a parent menu, or an app of the module',
  ]);
  expect(() => generateModule({ ...spec, version: 'x' })).toThrow('version: major.minor.patch');
});

test('literals and prefixes', () => {
  expect(lit("it's")).toBe("'it\\'s'");
  expect(lit({ a: 1, 'b-c': [true, null] })).toBe("{\n  a: 1,\n  'b-c': [true, null],\n}");
  expect(prefixedKey('acme_custom', 'gstNumber')).toBe('xAcmeCustomGstNumber');
});

test('deterministic: the same spec gives the same bytes', () => {
  expect(generateModule(spec)).toEqual(generateModule(structuredClone(spec)));
  const files = generateModule(spec);
  expect(Object.keys(files)).toEqual(['models.ts', 'index.ts', 'README.md']);
  expect(files['models.ts']).toContain("import { orm } from 'kosh-erp/orm';");
  expect(files['index.ts']).toContain("import { crm } from 'kosh-erp/crm';");
  expect(files['README.md']).toContain('- `res.partner.xAcmeGstNumber`: GST number (char)');
});

test('the round trip: the generated module loads with the app it extends and changes what the spec says', async () => {
  for (const [name, content] of Object.entries(generateModule(spec, workspace)))
    await writeFile(join(out, name), content, 'utf8');
  const { acme } = (await import(join(out, 'index.ts'))) as {
    acme: Parameters<typeof buildKoshRegistry>[0][number];
  };
  const registry = buildKoshRegistry([base, crm, acme]);
  const models = registry.registry.models as unknown as ReadonlyMap<
    string,
    { model: { fields: Record<string, { kind?: string; type?: string }> } }
  >;
  const partner = models.get('res.partner')?.model.fields ?? {};
  expect(Object.keys(partner)).toEqual(
    expect.arrayContaining(['xAcmeGstNumber', 'xAcmeTier', 'xAcmeCreditDays']),
  );
  const vehicle = models.get('x_acme.vehicle')?.model.fields ?? {};
  expect(Object.keys(vehicle)).toEqual(
    expect.arrayContaining(['plate', 'owner', 'capacity', 'notes']),
  );
  // The views: the partner form has the new fields after the email, by node id; the menus and actions are there.
  const views = new ViewRegistry(registry.loaded.modules, publicApiModels(registry));
  const form = JSON.stringify(views.views.get('res.partner.form'));
  expect(form.indexOf('"xAcmeGstNumber"')).toBeGreaterThan(form.indexOf('"email"'));
  expect(form).toContain('"xAcmeTier"');
  expect(JSON.stringify(views.views.get('res.partner.list'))).toContain('"xAcmeTier"');
  expect(views.views.has('x_acme.vehicle.form')).toBe(true);
  expect(views.actions.has('acme.action_vehicles')).toBe(true);
  expect(registry.loaded.menus.map((m) => m.id)).toEqual(
    expect.arrayContaining(['acme.root', 'acme.vehicles']),
  );
  expect([...registry.loaded.accessLevels.keys()]).toEqual(
    expect.arrayContaining(['acme.user', 'acme.manager']),
  );
});

test('a view change on a node that does not exist fails at load, naming the module', async () => {
  const { app: _app, ...rest } = spec;
  const broken: StudioSpec = {
    ...rest,
    name: 'acme_broken',
    models: [],
    menus: [],
    viewChanges: [
      {
        view: 'res.partner.form',
        operations: [{ insertAfter: 'no_such_node', fields: ['gstNumber'] }],
      },
    ],
  };
  const dir = join(import.meta.dirname, '.generated', 'acme_broken');
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(generateModule(broken, workspace)))
    await writeFile(join(dir, name), content, 'utf8');
  const { acmeBroken } = (await import(join(dir, 'index.ts'))) as {
    acmeBroken: Parameters<typeof buildKoshRegistry>[0][number];
  };
  const registry = buildKoshRegistry([base, crm, acmeBroken]);
  expect(() => new ViewRegistry(registry.loaded.modules, publicApiModels(registry))).toThrow(
    /no_such_node/,
  );
});

test('kosh studio build: every src/modules/*/studio.json, only what changed', async () => {
  const project = join(import.meta.dirname, '.generated', 'project');
  const dir = join(project, 'src', 'modules', 'acme');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'studio.json'), JSON.stringify(spec, null, 2));
  const lines: string[] = [];
  expect(await runStudio(['build'], (t) => lines.push(t), project)).toBe(0);
  expect(lines).toEqual(['acme: wrote models.ts, index.ts, README.md\n']);
  lines.length = 0;
  expect(await runStudio(['build'], (t) => lines.push(t), project)).toBe(0);
  expect(lines).toEqual(['acme: up to date\n']);
  await writeFile(join(dir, 'studio.json'), JSON.stringify({ ...spec, version: '0.1.1' }));
  expect((await buildModule(dir)).written).toEqual(['models.ts', 'README.md']);
  expect(await readFile(join(dir, 'models.ts'), 'utf8')).toContain("version: '0.1.1'");
  await writeFile(join(dir, 'studio.json'), JSON.stringify({ ...spec, version: 'bad' }));
  lines.length = 0;
  expect(await runStudio(['build'], (t) => lines.push(t), project)).toBe(1);
  expect(lines[0]).toContain('version: major.minor.patch');
  expect(await runStudio(['nope'], (t) => lines.push(t), project)).toBe(2);
});
