/**
 * @packageDocumentation
 * `@kosh/contacts` (RFC 0008): the Contacts app. Companies and people, customers and vendors: what Sales,
 * Purchase and Accounting deal with.
 */
import { defineModule } from '@kosh/modules-sdk';
import { base } from '@kosh/server';
import { action, form, hierarchy, list, search } from '@kosh/views';
import { contactsDemo } from './demo.js';
import { contactsShutro, ResPartner } from './module.js';

export { contactsDemo, DINA } from './demo.js';
export { contactsShutro, ResPartner } from './module.js';

export const contacts: ReturnType<typeof defineModule> = defineModule({
  shutro: contactsShutro,
  kosh: '^0.1.0',
  hooks: { demo: contactsDemo },
  depends: [base],
  app: {
    code: 'contacts',
    label: 'Contacts',
    icon: 'contacts',
    sequence: 20,
    category: 'Sales',
    summary: 'Customers, vendors and the people who work there',
  },
  accessLevels: {
    user: { label: 'User', groups: ['contacts.user'] },
    manager: { label: 'Manager', groups: ['contacts.manager'], implies: ['user'] },
  },
  // A sample customer sheet for the import screen (RFC 0014 §5.4), when Data import is installed.
  importTemplates: [
    {
      key: 'customers',
      model: 'res.partner',
      label: 'Customers',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Company', field: 'isCompany' },
        { header: 'Email', field: 'email' },
        { header: 'Phone', field: 'phone' },
        { header: 'Mobile', field: 'mobile' },
        { header: 'Street', field: 'street' },
        { header: 'City', field: 'city' },
        { header: 'Postal code', field: 'zip' },
        { header: 'Country', field: 'country' },
        { header: 'Tax ID', field: 'taxId' },
        { header: 'Customer', field: 'isCustomer' },
      ],
    },
  ],
  actions: {
    'contacts.action_partners': action(ResPartner, {
      label: 'Contacts',
      views: ['list', 'hierarchy', 'form'],
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
  views: {
    'res.partner.list': list(ResPartner, {
      columns: ['name', 'email', 'phone', 'city', 'country', 'isCustomer', 'isVendor'],
      defaultOrder: ['name asc'],
    }),
    'res.partner.hierarchy': hierarchy(ResPartner, {
      parent: 'parent',
      title: 'name',
      subtitle: 'email',
    }),
    'res.partner.form': form(ResPartner, (k) => ({
      sheet: [
        k.group('identity', ['name', 'isCompany', 'parent', 'taxId']),
        k.group('reach', ['email', 'phone', 'mobile', 'website']),
        k.notebook('more', [
          k.page('address', 'Address', [
            k.group('where', ['street', 'city', 'zip', 'state', 'country']),
          ]),
          k.page('sales', 'Sales & purchase', [
            k.group('roles', ['isCustomer', 'isVendor', 'currency']),
          ]),
          k.page('notes_page', 'Notes', ['notes']),
        ]),
      ],
    })),
  },
  search: {
    'res.partner': search(ResPartner, {
      fields: ['name', 'email', 'phone', 'city', 'taxId'],
      filters: {
        companies: { label: 'Companies', domain: { isCompany: true }, group: 'kind' },
        people: { label: 'People', domain: { isCompany: false }, group: 'kind' },
        customers: { label: 'Customers', domain: { isCustomer: true }, group: 'role' },
        vendors: { label: 'Vendors', domain: { isVendor: true }, group: 'role' },
      },
      groupBy: ['country', 'city', 'isCompany'],
    }),
  },
});
