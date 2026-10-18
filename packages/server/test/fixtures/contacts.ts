/**
 * A small real "contacts" app for server tests: a base module (users, currencies, companies) and contacts (partners),
 * each a Shutro module wrapped by a Kosh manifest.
 */
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { orm } from '../../src/orm.js';

const { defineGroup, defineModel, defineModule, f } = orm;

const ResUsers = defineModel('res.users', {
  access: { 'base.user': ['read'] },
  fields: { login: f.char({ required: true, index: 'unique' }), name: f.char({ required: true }) },
});
const ResCurrency = defineModel('res.currency', {
  access: { 'base.user': ['read'] },
  fields: {
    name: f.char({ required: true }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
  },
});
const ResCompany = defineModel('res.company', {
  access: { 'base.user': ['read'] },
  fields: {
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
  },
});
const baseShutro = defineModule({
  name: 'base',
  version: '0.1.0',
  groups: [
    defineGroup({ code: 'base.user', label: 'Internal user' }),
    defineGroup({
      code: 'base.admin',
      label: 'Administrator',
      implies: ['base.user'],
      administrator: true,
    }),
  ],
  models: [ResUsers, ResCurrency, ResCompany],
});

const ResPartner = defineModel('res.partner', {
  archivable: true,
  companyScoped: { required: false },
  access: {
    'contacts.user': ['read', 'write', 'create'],
    'contacts.manager': ['read', 'write', 'create', 'unlink', 'export', 'import'],
  },
  fields: {
    name: f.char({ required: true }),
    email: f.char(),
    phone: f.char(),
    isCompany: f.boolean({ default: false }),
    /** Managers only (field security). */
    creditLimit: f.decimal({ scale: 2, groups: ['contacts.manager'] }),
    stage: f.state({
      states: { lead: 'Lead', customer: 'Customer', lost: 'Lost' },
      initial: 'lead',
      transitions: {
        qualify: { from: ['lead'], to: 'customer' },
        lose: { from: ['lead', 'customer'], to: 'lost' },
      },
    }),
  },
  onchange: {
    // Suggests an email address from the name (form assistance through the API).
    name(draft: unknown): void {
      const d = draft as { get(k: string): unknown; set(k: string, v: unknown): void };
      const name = d.get('name');
      if (typeof name === 'string' && d.get('email') === null)
        d.set('email', `${name.toLowerCase().replaceAll(/\W+/g, '.')}@example.com`);
    },
  },
});
const contactsShutro = defineModule({
  name: 'contacts',
  version: '0.1.0',
  depends: [baseShutro],
  groups: [
    defineGroup({ code: 'contacts.user', label: 'Contacts user', implies: ['base.user'] }),
    defineGroup({
      code: 'contacts.manager',
      label: 'Contacts manager',
      implies: ['contacts.user'],
    }),
  ],
  models: [ResPartner],
});

export const base = defineKoshModule({
  shutro: baseShutro,
  kosh: '^0.1.0',
  accessLevels: {
    user: { label: 'Internal user', groups: ['base.user'] },
    admin: { label: 'Administrator', groups: ['base.admin'], implies: ['user'] },
  },
});

export const contacts = defineKoshModule({
  shutro: contactsShutro,
  kosh: '^0.1.0',
  depends: [base],
  app: { code: 'contacts', label: 'Contacts', icon: 'users' },
  accessLevels: {
    user: { label: 'User', groups: ['contacts.user'] },
    manager: { label: 'Manager', groups: ['contacts.manager'], implies: ['user'] },
  },
  actions: { 'contacts.action_partners': {} },
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
