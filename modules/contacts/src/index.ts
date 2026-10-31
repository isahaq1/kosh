/**
 * @packageDocumentation
 * `@kosh/contacts` (RFC 0008): the Contacts app. Companies and people, customers and vendors: what Sales,
 * Purchase and Accounting deal with.
 */
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { base } from '@kosh/server';
import { storage } from '@kosh/storage';
import { action, form, hierarchy, kanban, list, map, search } from '@kosh/views';
import { contactsDemo } from './demo.js';
import { contactsShutro, ResPartner, ResPartnerTag } from './module.js';

export { contactsDemo, DINA } from './demo.js';
export { contactsShutro, ResPartner, ResPartnerTag } from './module.js';

export const contacts: ReturnType<typeof defineModule> = defineModule({
  shutro: contactsShutro,
  kosh: '^0.1.0',
  hooks: { demo: contactsDemo },
  depends: [base, storage, reporting],
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
      views: ['list', 'kanban', 'map', 'hierarchy', 'form'],
    }),
    'contacts.action_tags': action(ResPartnerTag, { label: 'Tags', views: ['list', 'form'] }),
  },
  // The Overview (RFC 0022 step 2): how many, who buys and who sells, where they are, the month's new ones.
  overview: {
    cards: [
      {
        id: 'contacts_all',
        title: 'Contacts',
        kind: 'kpi',
        model: 'res.partner',
        measure: 'count',
        w: 3,
      },
      {
        id: 'customers',
        title: 'Customers',
        kind: 'kpi',
        model: 'res.partner',
        measure: 'count',
        filter: { isCustomer: true },
        w: 3,
      },
      {
        id: 'vendors',
        title: 'Vendors',
        kind: 'kpi',
        model: 'res.partner',
        measure: 'count',
        filter: { isVendor: true },
        w: 3,
      },
      {
        id: 'new_month',
        title: 'New this month',
        kind: 'kpi',
        model: 'res.partner',
        measure: 'count',
        comparison: { field: 'createdAt', mode: 'previous' },
        w: 3,
      },
      {
        id: 'by_country',
        title: 'By country',
        kind: 'chart',
        model: 'res.partner',
        measure: 'count',
        groupBy: 'country',
        chart: 'pie',
        w: 6,
      },
      {
        id: 'by_city',
        title: 'Companies by city',
        kind: 'chart',
        model: 'res.partner',
        measure: 'count',
        groupBy: 'city',
        filter: { isCompany: true },
        chart: 'bar',
        w: 6,
      },
    ],
  },
  menus: [
    { id: 'contacts.root', label: 'Contacts', app: 'contacts' },
    {
      id: 'contacts.partners',
      parent: 'contacts.root',
      label: 'Contacts',
      action: 'contacts.action_partners',
    },
    {
      id: 'contacts.tags',
      parent: 'contacts.root',
      label: 'Tags',
      action: 'contacts.action_tags',
      sequence: 9,
      visibleTo: ['contacts.manager'],
    },
  ],
  views: {
    'res.partner.list': list(ResPartner, {
      columns: [
        { field: 'image', widget: 'avatar' },
        'name',
        { field: 'email', widget: 'email' },
        { field: 'phone', widget: 'phone' },
        'city',
        'country',
        { field: 'tags', widget: 'tags' },
        'isCustomer',
        'isVendor',
      ],
      defaultOrder: ['name asc'],
    }),
    'res.partner.kanban': kanban(ResPartner, {
      groupBy: 'city',
      card: {
        title: 'name',
        subtitle: 'parent',
        avatar: 'image',
        footer: [
          { field: 'email', widget: 'email' },
          { field: 'tags', widget: 'tags' },
        ],
      },
    }),
    'res.partner.map': map(ResPartner, {
      latitude: 'latitude',
      longitude: 'longitude',
      title: 'name',
      subtitle: 'city',
    }),
    'res.partner.tag.list': list(ResPartnerTag, { columns: ['name'], inlineEdit: ['name'] }),
    'res.partner.tag.form': form(ResPartnerTag, (k) => ({
      sheet: [k.group('main', ['name'])],
    })),
    'res.partner.hierarchy': hierarchy(ResPartner, {
      parent: 'parent',
      title: 'name',
      subtitle: 'email',
    }),
    'res.partner.form': form(ResPartner, (k) => ({
      sheet: [
        // What relates to this contact: Sales, Purchase and Accounting append their tiles (RFC 0022 §3.1).
        k.stats('related', []),
        k.group('identity', [
          { field: 'image', widget: 'image' },
          'name',
          'isCompany',
          'parent',
          'taxId',
          { field: 'tags', widget: 'tags' },
        ]),
        k.group('reach', [
          { field: 'email', widget: 'email' },
          { field: 'phone', widget: 'phone' },
          { field: 'mobile', widget: 'phone' },
          { field: 'website', widget: 'url' },
        ]),
        k.notebook('more', [
          k.page('address', 'Address', [
            k.group('where', ['street', 'city', 'zip', 'state', 'country']),
            k.group('position', ['latitude', 'longitude'], {
              label: 'On the map',
              description: 'Decimal degrees; the Map view shows contacts that have them.',
            }),
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
    'res.partner.tag': search(ResPartnerTag, { fields: ['name'] }),
    'res.partner': search(ResPartner, {
      fields: ['name', 'email', 'phone', 'city', 'taxId', 'tags.name'],
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
