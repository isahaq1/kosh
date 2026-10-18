import { describe, expect, test } from 'vitest';
import {
  defineModule,
  type KoshModule,
  loadModules,
  ModuleDefinitionError,
  type ModuleInput,
  ModuleLoadError,
  type ShutroModuleShape,
  satisfies,
} from '../src/index.js';

// Shutro modules as the manifest reads them (the server's loader checks they are real Shutro modules).
const shutro = (
  name: string,
  depends: readonly ShutroModuleShape[] = [],
  groups: readonly string[] = [],
  permissions: readonly string[] = [],
): ShutroModuleShape => ({
  name,
  version: '1.0.0',
  depends,
  groups: groups.map((code) => ({ code })),
  permissions: permissions.map((code) => ({ code })),
});

const sBase = shutro('base', [], ['base.user', 'base.admin']);
const sContacts = shutro('contacts', [sBase], ['contacts.user', 'contacts.manager']);
const sProduct = shutro('product', [sBase], ['product.user']);
const sPurchase = shutro(
  'purchase',
  [sContacts, sProduct],
  ['purchase.user', 'purchase.approver', 'purchase.manager'],
  ['purchase.approve'],
);

const base = defineModule({
  shutro: sBase,
  kosh: '^0.1.0',
  accessLevels: { user: { label: 'User', groups: ['base.user'] } },
});
const contacts = defineModule({
  shutro: sContacts,
  kosh: '^0.1.0',
  depends: [base],
  app: { code: 'contacts', label: 'Contacts' },
  accessLevels: {
    user: { label: 'User', groups: ['contacts.user'] },
    manager: { label: 'Manager', groups: ['contacts.manager'], implies: ['user'] },
  },
  actions: { 'contacts.action_partners': { model: 'res.partner', views: ['list'] } },
  menus: [
    { id: 'contacts.root', label: 'Contacts', app: 'contacts' },
    {
      id: 'contacts.partners',
      parent: 'contacts.root',
      label: 'Contacts',
      action: 'contacts.action_partners',
    },
  ],
});
const product = defineModule({
  shutro: sProduct,
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'User', groups: ['product.user'] } },
});
const purchaseInput: ModuleInput = {
  shutro: sPurchase,
  kosh: '>=0.1.0 <1.0.0',
  depends: [contacts, product],
  app: { code: 'purchase', label: 'Purchase' },
  accessLevels: {
    user: { label: 'Requester', groups: ['purchase.user', 'contacts.user'] }, // a dependency's group is allowed
    approver: { label: 'Approver', groups: ['purchase.approver'], implies: ['user'] },
    manager: { label: 'Manager', groups: ['purchase.manager'], implies: ['approver'] },
  },
  actions: {
    'purchase.action_orders': { model: 'purchase.order', views: ['list'] },
    'purchase.action_to_approve': { model: 'purchase.order', views: ['list'] },
  },
  menus: [
    { id: 'purchase.root', label: 'Purchase', app: 'purchase' },
    {
      id: 'purchase.orders',
      parent: 'purchase.root',
      label: 'Orders',
      action: 'purchase.action_orders',
    },
    {
      id: 'purchase.to_approve',
      parent: 'purchase.root',
      label: 'To approve',
      action: 'purchase.action_to_approve',
      visibleTo: ['purchase.approve'],
    },
    // Purchase adds a menu under Contacts (a dependency's menu).
    {
      id: 'purchase.vendors',
      parent: 'contacts.root',
      label: 'Vendors',
      action: 'contacts.action_partners',
    },
  ],
};
const purchase = defineModule(purchaseInput);

describe('defineModule', () => {
  test('name and version come from the Shutro module; the result is frozen', () => {
    expect([purchase.name, purchase.version]).toEqual(['purchase', '1.0.0']);
    expect(Object.isFrozen(purchase)).toBe(true);
  });

  test('a module without access levels fails (installing grants nothing, so it must say what can be granted)', () => {
    expect(() => defineModule({ ...purchaseInput, accessLevels: {} })).toThrow(
      ModuleDefinitionError,
    );
    expect(() =>
      defineModule({ ...purchaseInput, accessLevels: { user: { label: 'U', groups: [] } } }),
    ).toThrow(/grants no group/);
    expect(() =>
      defineModule({
        ...purchaseInput,
        accessLevels: { user: { label: 'U', groups: ['purchase.user'], implies: ['boss'] } },
      }),
    ).toThrow(/implies 'boss'/);
  });

  test('ids, ranges and duplicates are checked', () => {
    expect(() => defineModule({ ...purchaseInput, kosh: 'latest' })).toThrow(/not a version range/);
    expect(() => defineModule({ ...purchaseInput, menus: [{ id: 'root', label: 'x' }] })).toThrow(
      /not '<module>.<name>'/,
    );
    expect(() =>
      defineModule({
        ...purchaseInput,
        menus: [
          { id: 'purchase.a', label: 'a' },
          { id: 'purchase.a', label: 'b' },
        ],
      }),
    ).toThrow(/declared twice/);
  });
});

describe('loadModules', () => {
  test('dependencies first, deterministic order, merged menus, access levels and actions', () => {
    const loaded = loadModules([purchase], { koshVersion: '0.1.0' });
    expect(loaded.modules.map((m) => m.name)).toEqual(['base', 'contacts', 'product', 'purchase']);
    expect(loaded.menus.map((m) => `${m.module}:${m.id}`)).toContain('purchase:purchase.vendors');
    expect([...loaded.accessLevels.keys()]).toEqual([
      'base.user',
      'contacts.user',
      'contacts.manager',
      'product.user',
      'purchase.user',
      'purchase.approver',
      'purchase.manager',
    ]);
    expect(loaded.actions.get('contacts.action_partners')).toBe('contacts');
  });

  test('framework versions are checked', () => {
    // Dependencies are checked first: base (^0.1.0) is the first that cannot run on 1.0.0.
    expect(() => loadModules([purchase], { koshVersion: '1.0.0' })).toThrow(
      /'base' needs Kosh \^0.1.0; this is Kosh 1.0.0/,
    );
    const onlyPurchaseRange = defineModule({ ...purchaseInput, kosh: '>=0.2.0 <1.0.0' });
    expect(() => loadModules([onlyPurchaseRange], { koshVersion: '0.1.5' })).toThrow(
      /'purchase' needs Kosh >=0.2.0 <1.0.0/,
    );
  });

  test('Kosh dependencies must cover the Shutro dependencies', () => {
    const lonely = defineModule({ ...purchaseInput, depends: [product], menus: [], actions: {} });
    expect(() => loadModules([lonely], { koshVersion: '0.1.0' })).toThrow(
      /uses the Shutro module 'contacts'/,
    );
  });

  test('access levels grant only groups of the module or its dependencies', () => {
    const sneaky = defineModule({
      ...purchaseInput,
      accessLevels: { user: { label: 'U', groups: ['account.manager'] } },
    });
    expect(() => loadModules([sneaky], { koshVersion: '0.1.0' })).toThrow(
      /grants the group 'account.manager'/,
    );
  });

  test('menu parents and actions must exist; ids are unique across modules', () => {
    const badParent = defineModule({
      ...purchaseInput,
      menus: [{ id: 'purchase.x', parent: 'sales.root', label: 'x' }],
    });
    expect(() => loadModules([badParent], { koshVersion: '0.1.0' })).toThrow(/parent 'sales.root'/);
    const badAction = defineModule({
      ...purchaseInput,
      menus: [{ id: 'purchase.x', label: 'x', action: 'purchase.nope' }],
    });
    expect(() => loadModules([badAction], { koshVersion: '0.1.0' })).toThrow(
      /opens action 'purchase.nope'/,
    );
    const clash = defineModule({ ...purchaseInput, menus: [{ id: 'contacts.root', label: 'x' }] });
    expect(() => loadModules([clash], { koshVersion: '0.1.0' })).toThrow(
      /Menu 'contacts.root' is declared by 'contacts' and 'purchase'/,
    );
  });

  test('cycles and two modules with one name are refused', () => {
    const a: { depends: KoshModule[] } & KoshModule = { ...base, name: 'a', depends: [] } as never;
    const b: KoshModule = { ...base, name: 'b', depends: [a] };
    a.depends.push(b);
    expect(() => loadModules([a], { koshVersion: '0.1.0' })).toThrow(ModuleLoadError);
    const fork = defineModule({
      shutro: sBase,
      kosh: '^0.1.0',
      accessLevels: { user: { label: 'U', groups: ['base.user'] } },
    });
    expect(() => loadModules([contacts, fork], { koshVersion: '0.1.0' })).toThrow(
      /Two different modules are named 'base'/,
    );
  });
});

describe('satisfies', () => {
  test.each([
    ['1.2.3', '^1.0.0', true],
    ['2.0.0', '^1.0.0', false],
    ['0.2.5', '^0.2.0', true],
    ['0.3.0', '^0.2.0', false],
    ['1.2.9', '~1.2.0', true],
    ['1.3.0', '~1.2.0', false],
    ['1.5.0', '>=1.2.0 <2.0.0', true],
    ['1.0.0', '1.0.0', true],
    ['9.9.9', '*', true],
  ])('%s in %s → %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
  test('unreadable input is a RangeError', () => {
    expect(() => satisfies('1.0', '^1.0.0')).toThrow(RangeError);
    expect(() => satisfies('1.0.0', 'latest')).toThrow(RangeError);
  });
});
