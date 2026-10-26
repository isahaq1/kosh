import { expect, test } from 'vitest';
import {
  AppPlanError,
  defineModule,
  type InstalledApp,
  type KoshModule,
  planApps,
  type ShutroModuleShape,
  servedModules,
} from '../src/index.js';

const shutro = (name: string, depends: readonly ShutroModuleShape[] = []): ShutroModuleShape => ({
  name,
  version: '1.0.0',
  depends,
  groups: [{ code: `${name}.user` }],
  permissions: [],
});
const mod = (s: ShutroModuleShape, depends: KoshModule[] = []): KoshModule =>
  defineModule({
    shutro: s,
    kosh: '^0.1.0',
    depends,
    accessLevels: { user: { label: 'User', groups: [`${s.name}.user`] } },
  });

const sBase = shutro('base');
const sContacts = shutro('contacts', [sBase]);
const sProduct = shutro('product', [sBase]);
const sSales = shutro('sales', [sContacts, sProduct]);
const sProjects = shutro('projects', [sContacts]);
const base = mod(sBase);
const contacts = mod(sContacts, [base]);
const product = mod(sProduct, [base]);
const sales = mod(sSales, [contacts, product]);
const projects = mod(sProjects, [contacts]);
const catalogue = [base, contacts, product, sales, projects];

const row = (name: string, state: InstalledApp['state'] = 'installed'): InstalledApp => ({
  name,
  version: '1.0.0',
  state,
  reason: 'selected',
});

test('install brings missing dependencies, dependencies first', () => {
  const plan = planApps(catalogue, [row('base')], { install: ['sales'] });
  expect(plan.install).toEqual([
    { name: 'contacts', reason: 'dependency' },
    { name: 'product', reason: 'dependency' },
    { name: 'sales', reason: 'selected' },
  ]);
  expect(plan.after.map((r) => r.name)).toEqual(['base', 'contacts', 'product', 'sales']);
});

test('installing an installed app changes nothing; a disabled one is enabled', () => {
  const current = [row('base'), row('contacts', 'disabled'), row('projects', 'disabled')];
  const plan = planApps(catalogue, [...current, row('product')], {
    install: ['product', 'projects'],
  });
  expect(plan.install).toEqual([]);
  expect(plan.unchanged).toEqual(['product']);
  expect(plan.enable).toEqual(['contacts', 'projects']); // its dependency wakes too
});

test('disable takes dependents along, dependents first', () => {
  const current = ['base', 'contacts', 'product', 'sales', 'projects'].map((n) => row(n));
  const plan = planApps(catalogue, current, { disable: ['contacts'] });
  expect(plan.disable).toEqual([
    { name: 'sales', cascade: true },
    { name: 'projects', cascade: true },
    { name: 'contacts', cascade: false },
  ]);
  expect(servedModules(catalogue, plan.after).map((m) => m.name)).toEqual(['base', 'product']);
  expect(
    servedModules(catalogue, plan.after, ['installed', 'disabled']).map((m) => m.name),
  ).toHaveLength(5);
});

test('refusals: unknown, protected, not installed, contradictory', () => {
  const current = [row('base'), row('contacts')];
  expect(() => planApps(catalogue, current, { install: ['crm'] })).toThrow(
    /Not in the catalogue: crm/,
  );
  expect(() => planApps(catalogue, current, { disable: ['base'] })).toThrow(AppPlanError);
  expect(() => planApps(catalogue, current, { disable: ['contacts'] }, ['contacts'])).toThrow(
    /cannot be disabled/,
  );
  expect(() => planApps(catalogue, current, { enable: ['sales'] })).toThrow(/Not installed/);
  expect(() => planApps(catalogue, current, { install: ['sales'], disable: ['sales'] })).toThrow(
    /on and off/,
  );
  expect(() =>
    planApps(catalogue, [...current, row('projects')], {
      install: ['projects'],
      disable: ['contacts'],
    }),
  ).toThrow(/on and off|enabled and disabled/);
});

test('upgrade: installed modules move to their code version; never back; unchanged when equal; the outdated list', async () => {
  const { planApps, outdatedApps, compareVersions } = await import('../src/index.js');
  expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
  expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  const mod = (name: string, version: string) =>
    ({ name, version, depends: [], accessLevels: {} }) as unknown as Parameters<
      typeof planApps
    >[0][number];
  const cat = [mod('a', '1.2.0'), mod('b', '1.0.0')];
  const current = [
    { name: 'a', version: '1.0.0', state: 'installed', reason: 'selected' },
    { name: 'b', version: '1.0.0', state: 'installed', reason: 'selected' },
  ] as const;
  const plan = planApps(cat, current, { upgrade: ['a', 'b'] });
  expect(plan.upgrade).toEqual([{ name: 'a', from: '1.0.0', to: '1.2.0' }]);
  expect(plan.unchanged).toEqual(['b']);
  expect(plan.after.find((r) => r.name === 'a')?.version).toBe('1.2.0');
  expect(outdatedApps(cat, current)).toEqual([{ name: 'a', from: '1.0.0', to: '1.2.0' }]);
  expect(() => planApps([mod('a', '0.9.0')], current, { upgrade: ['a'] })).toThrow('go back');
  expect(() => planApps(cat, [], { upgrade: ['a'] })).toThrow('Not installed');
});
