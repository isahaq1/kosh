/**
 * The module set of the end-to-end tests: contacts (list, kanban, form, search) and purchase (multi-level
 * approvals), plus `purchase_approvals`, which adds the approval panel to the purchase form by a view extension.
 * Server-side code, run by Node (type stripping) against the built packages.
 */
import { messaging, messagingShutro } from '@isahaq/kosh-messaging';
import { defineModule as defineKoshModule } from '@isahaq/kosh-modules-sdk';
import {
  approvalGuard,
  permissions,
  permissionsShutro,
  requestApprovals,
} from '@isahaq/kosh-permissions';
import { reporting, reportingShutro } from '@isahaq/kosh-reporting';
import { base, baseShutro } from '@isahaq/kosh-server';
import { orm } from '@isahaq/kosh-server/orm';
import {
  action,
  calendar,
  cohort,
  form,
  gantt,
  graph,
  hierarchy,
  kanban,
  list,
  map,
  pivot,
  search,
} from '@isahaq/kosh-views';

const { defineGroup, defineModel, defineModule, definePermission, f } = orm;

const Partner = defineModel('res.partner', {
  archivable: true,
  companyScoped: { required: false },
  access: {
    'contacts.user': ['read', 'write', 'create'],
    'contacts.manager': ['read', 'write', 'create', 'unlink', 'export', 'import'],
    'purchase.user': ['read'],
  },
  fields: {
    name: f.char({ required: true }),
    email: f.char(),
    phone: f.char(),
    city: f.char(),
    latitude: f.decimal({ scale: 6 }),
    longitude: f.decimal({ scale: 6 }),
    parent: f.many2one('res.partner', { label: 'Parent company' }),
    isCompany: f.boolean({ default: false }),
    creditLimit: f.decimal({ scale: 2, groups: ['contacts.manager'] }),
    stage: f.state({
      states: { lead: 'Lead', customer: 'Customer', lost: 'Lost' },
      initial: 'lead',
      transitions: {
        qualify: { from: ['lead'], to: 'customer' },
        lose: { from: ['lead', 'customer'], to: 'lost', requires: 'contacts.mark_lost' },
        reopen: { from: ['lost'], to: 'lead' },
      },
    }),
  },
});

const contactsShutro = defineModule({
  name: 'contacts',
  version: '0.1.0',
  depends: [baseShutro, reportingShutro],
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
      label: 'Mark lost',
      groups: ['contacts.manager'],
    }),
  ],
  models: [Partner],
});

export const contacts = defineKoshModule({
  shutro: contactsShutro,
  kosh: '^0.1.0',
  depends: [base, reporting],
  app: { code: 'contacts', label: 'Contacts', icon: 'users', sequence: 1 },
  accessLevels: {
    user: { label: 'User', groups: ['contacts.user'] },
    manager: { label: 'Manager', groups: ['contacts.manager'], implies: ['user'] },
  },
  actions: {
    'contacts.action_partners': action(Partner, {
      label: 'Contacts',
      views: ['list', 'kanban', 'map', 'hierarchy', 'form'],
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
    'res.partner.list': list(Partner, {
      columns: [
        'name',
        'email',
        'city',
        { field: 'creditLimit', sum: true },
        { field: 'stage', widget: 'badge' },
      ],
      defaultOrder: ['name asc'],
      inlineEdit: ['city'],
    }),
    'res.partner.map': map(Partner, {
      latitude: 'latitude',
      longitude: 'longitude',
      title: 'name',
      subtitle: 'city',
    }),
    'res.partner.hierarchy': hierarchy(Partner, {
      parent: 'parent',
      title: 'name',
      subtitle: 'city',
    }),
    'res.partner.kanban': kanban(Partner, {
      groupBy: 'stage',
      card: { title: 'name', subtitle: 'email', footer: ['city'] },
    }),
    'res.partner.form': form(Partner, (k) => ({
      header: {
        statusbar: 'stage',
        buttons: [
          k.button('qualify', { primary: true, label: 'Qualify' }),
          k.button('lose', { label: 'Mark lost', confirm: 'Mark this contact as lost?' }),
          k.button('reopen', { label: 'Reopen' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'email', 'phone', 'city', 'isCompany']),
        k.group('finance', [{ field: 'creditLimit', widget: 'money' }], { label: 'Finance' }),
      ],
      readonlyWhen: { stage: 'lost' },
    })),
  },
  search: {
    'res.partner': search(Partner, {
      fields: ['name', 'email', 'city'],
      filters: {
        companies: { label: 'Companies', domain: { isCompany: true } },
        leads: { label: 'Leads', domain: { stage: 'lead' }, group: 'stage' },
        customers: { label: 'Customers', domain: { stage: 'customer' }, group: 'stage' },
      },
      groupBy: ['stage', 'city', 'isCompany'],
    }),
  },
});

const Order = defineModel('purchase.order', {
  companyScoped: { required: true },
  access: {
    'purchase.user': ['read', 'write', 'create'],
    'purchase.manager': ['read', 'write', 'create', 'unlink', 'export', 'import'],
  },
  rules: {
    own: {
      groups: ['purchase.user'],
      perms: ['read', 'write'],
      domain: { createdBy: { $env: 'uid' } },
    },
    all: { groups: ['purchase.approver'], perms: ['read', 'write'], domain: {} },
  },
  tracking: ['vendor', 'amountTotal'], // the chatter's change log (the state is tracked by default)
  fields: {
    name: f.char({ required: true }),
    vendor: f.many2one('res.partner'),
    amountTotal: f.decimal({ scale: 2, required: true, default: '0' }),
    dateOrder: f.date({ label: 'Order date' }),
    dateDue: f.date({ label: 'Due date' }),
    received: f.integer({ default: 0, label: 'Received %' }),
    notes: f.text(),
    state: f.state({
      states: {
        draft: 'Draft',
        submitted: 'Submitted',
        approved: 'Approved',
        rejected: 'Rejected',
      },
      initial: 'draft',
      transitions: {
        submit: {
          from: ['draft', 'rejected'],
          to: 'submitted',
          after: (orders: never) => requestApprovals(orders),
        },
        approve: {
          from: ['submitted'],
          to: 'approved',
          guard: (orders: never) => approvalGuard(orders),
          message: 'Waiting for approvals.',
        },
        reject: { from: ['submitted'], to: 'rejected' },
      },
    }),
  },
});

const purchaseShutro = defineModule({
  name: 'purchase',
  version: '0.1.0',
  depends: [contactsShutro, permissionsShutro, messagingShutro],
  groups: [
    defineGroup({ code: 'purchase.user', label: 'Requester', implies: ['base.user'] }),
    defineGroup({ code: 'purchase.approver', label: 'Approver', implies: ['purchase.user'] }),
    defineGroup({ code: 'purchase.manager', label: 'Manager', implies: ['purchase.approver'] }),
  ],
  models: [Order],
});

export const purchase = defineKoshModule({
  shutro: purchaseShutro,
  kosh: '^0.1.0',
  depends: [contacts, permissions, messaging],
  app: { code: 'purchase', label: 'Purchase', icon: 'cart', sequence: 2 },
  accessLevels: {
    user: { label: 'Requester', groups: ['purchase.user'] },
    approver: { label: 'Approver', groups: ['purchase.approver'], implies: ['user'] },
    manager: { label: 'Manager', groups: ['purchase.manager'], implies: ['approver'] },
  },
  actions: {
    'purchase.action_orders': action(Order, {
      label: 'Purchase orders',
      views: ['list', 'kanban', 'pivot', 'graph', 'calendar', 'gantt', 'cohort', 'form'],
    }),
  },
  menus: [
    { id: 'purchase.root', label: 'Purchase', app: 'purchase' },
    {
      id: 'purchase.orders',
      parent: 'purchase.root',
      label: 'Orders',
      action: 'purchase.action_orders',
    },
  ],
  views: {
    'purchase.order.list': list(Order, {
      columns: [
        'name',
        'vendor',
        { field: 'amountTotal', sum: true },
        { field: 'state', widget: 'badge' },
      ],
    }),
    'purchase.order.pivot': pivot(Order, {
      rows: ['vendor'],
      cols: ['dateOrder:month'],
      measures: ['count', { sum: 'amountTotal', label: 'Amount' }],
      heatmap: true,
      comparison: { field: 'dateOrder', mode: 'yoy' },
    }),
    'purchase.order.graph': graph(Order, {
      chart: 'bar',
      groupBy: ['dateOrder:month'],
      measure: { sum: 'amountTotal', label: 'Spend' },
    }),
    'purchase.order.calendar': calendar(Order, {
      dateStart: 'dateOrder',
      dateStop: 'dateDue',
      title: 'name',
      color: 'state',
    }),
    'purchase.order.gantt': gantt(Order, {
      dateStart: 'dateOrder',
      dateStop: 'dateDue',
      title: 'name',
      groupBy: 'vendor',
      progress: 'received',
    }),
    'purchase.order.cohort': cohort(Order, {
      dateStart: 'dateOrder',
      dateStop: 'dateDue',
      interval: 'week',
      mode: 'churn',
    }),
    'purchase.order.kanban': kanban(Order, {
      groupBy: 'state',
      card: {
        title: 'name',
        subtitle: 'vendor',
        footer: [{ field: 'amountTotal', widget: 'money' }],
      },
    }),
    'purchase.order.form': form(Order, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [k.button('submit', { primary: true, label: 'Submit' })],
      },
      sheet: [
        k.component('documents', 'reporting.Documents'),
        k.group('main', [
          'name',
          'vendor',
          { field: 'amountTotal', widget: 'money' },
          'dateOrder',
          'dateDue',
        ]),
        k.group('more', ['notes'], { columns: 1 }),
      ],
      readonlyWhen: { state: { notIn: ['draft', 'rejected'] } },
      chatter: true,
    })),
  },
  documents: [
    {
      key: 'order',
      name: 'Purchase order',
      model: 'purchase.order',
      layout: {
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Purchase order {{name}}' },
          {
            kind: 'fields',
            id: 'main',
            items: [
              { bind: 'vendor.name', label: 'Vendor' },
              { bind: 'dateOrder' },
              { bind: 'amountTotal' },
              { bind: 'state' },
            ],
          },
          { kind: 'signature', id: 'sign', labels: ['Requested by', 'Approved by'] },
        ],
      },
    },
  ],
  search: {
    'purchase.order': search(Order, {
      fields: ['name', 'vendor.name'],
      filters: { toApprove: { label: 'To approve', domain: { state: 'submitted' } } },
      groupBy: ['state', 'vendor'],
    }),
  },
  approvals: [
    {
      name: 'Purchase approvals',
      model: 'purchase.order',
      onApproved: 'approve',
      onRejected: 'reject',
      levels: [
        {
          name: 'Department head',
          condition: { amountTotal: { gt: '50000' } },
          approverRole: 'purchase.approver',
        },
        {
          name: 'Finance director',
          condition: { amountTotal: { gt: '500000' } },
          approverRole: 'purchase.manager',
        },
      ],
    },
  ],
});

/** Adds the approval panel after the main group of the order form (extension by anchor, RFC 0004). */
export const purchaseApprovals = defineKoshModule({
  shutro: defineModule({
    name: 'purchase_approvals',
    version: '0.1.0',
    depends: [purchaseShutro],
    groups: [
      defineGroup({
        code: 'purchase_approvals.user',
        label: 'Approvals',
        implies: ['purchase.user'],
      }),
    ],
    models: [],
  }),
  kosh: '^0.1.0',
  depends: [purchase],
  accessLevels: { user: { label: 'Approvals', groups: ['purchase_approvals.user'] } },
  viewExtensions: [
    {
      view: 'purchase.order.form',
      operations: [
        {
          insertAfter: 'main',
          nodes: [{ kind: 'component', id: 'approval_panel', component: 'approvals.Panel' }],
        },
      ],
    },
  ],
});

export const MODULES = [purchaseApprovals];
