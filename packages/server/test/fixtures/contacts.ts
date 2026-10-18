/**
 * A small real "contacts" app for server tests, on the framework's `base` module: contacts (partners), a Shutro
 * module wrapped by a Kosh manifest.
 */
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { form, kanban, list, search } from '@kosh/views';
import { base, baseShutro } from '../../src/auth/base.js';
import { orm } from '../../src/orm.js';

export { base };

const { defineGroup, defineModel, defineModule, definePermission, f } = orm;

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
        lose: { from: ['lead', 'customer'], to: 'lost', requires: 'contacts.mark_lost' },
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
  permissions: [
    definePermission({
      code: 'contacts.mark_lost',
      label: 'Mark contacts as lost',
      groups: ['contacts.manager'],
    }),
  ],
  models: [ResPartner],
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
  actions: {
    'contacts.action_partners': {
      model: 'res.partner',
      label: 'Contacts',
      views: ['list', 'kanban', 'form'],
    },
  },
  views: {
    'res.partner.list': list(ResPartner, {
      columns: [
        'name',
        'email',
        'phone',
        { field: 'creditLimit', sum: true },
        { field: 'stage', widget: 'badge' },
      ],
      defaultOrder: ['name asc'],
    }),
    'res.partner.kanban': kanban(ResPartner, {
      groupBy: 'stage',
      card: { title: 'name', subtitle: 'email', footer: ['phone'] },
    }),
    'res.partner.form': form(ResPartner, (f) => ({
      header: {
        statusbar: 'stage',
        buttons: [f.button('qualify', { primary: true }), f.button('lose')],
      },
      sheet: [
        f.group('main', ['name', 'email', 'phone', 'isCompany']),
        f.group('finance', [{ field: 'creditLimit', widget: 'money' }], { label: 'Finance' }),
      ],
      readonlyWhen: { stage: 'lost' },
    })),
  },
  search: {
    'res.partner': search(ResPartner, {
      fields: ['name', 'email', 'company.name'],
      filters: {
        companies: { label: 'Companies', domain: { isCompany: true } },
        leads: { label: 'Leads', domain: { stage: 'lead' }, group: 'stage' },
        customers: { label: 'Customers', domain: { stage: 'customer' }, group: 'stage' },
        bigCredit: { label: 'Large credit', domain: { creditLimit: { gt: '100000' } } },
      },
      groupBy: ['stage', 'isCompany'],
    }),
  },
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
