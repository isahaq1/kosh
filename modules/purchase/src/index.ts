/**
 * @packageDocumentation
 * `@kosh/purchase` (RFC 0008): the Purchase app. Requests for quotation and purchase orders, prices from the
 * product cost, totals in the order's currency, and amount-based approvals (a manager above 100,000, a director
 * above 1,000,000 by default; administrators change the thresholds in the approval policy).
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { permissions } from '@kosh/permissions';
import { product } from '@kosh/product';
import { action, form, kanban, list, search } from '@kosh/views';
import { purchaseDemo } from './demo.js';
import { PurchaseOrder, purchaseShutro } from './module.js';

export { PurchaseOrder, PurchaseOrderLine, purchaseShutro } from './module.js';

export const purchase: ReturnType<typeof defineModule> = defineModule({
  shutro: purchaseShutro,
  kosh: '^0.1.0',
  hooks: { demo: purchaseDemo },
  depends: [contacts, product, messaging, permissions],
  app: {
    code: 'purchase',
    label: 'Purchase',
    icon: 'purchase',
    sequence: 40,
    category: 'Inventory',
    summary: 'Requests for quotation, purchase orders and their approvals',
  },
  accessLevels: {
    user: { label: 'Buyer (own orders)', groups: ['purchase.user'] },
    manager: { label: 'Manager (all orders)', groups: ['purchase.manager'], implies: ['user'] },
    director: { label: 'Director', groups: ['purchase.director'], implies: ['manager'] },
  },
  approvals: [
    {
      name: 'Purchase approvals',
      model: 'purchase.order',
      onApproved: 'confirm',
      onRejected: 'reject',
      levels: [
        {
          name: 'Purchase manager',
          condition: { amountTotal: { gt: '100000' } },
          approverRole: 'purchase.manager',
        },
        {
          name: 'Purchase director',
          condition: { amountTotal: { gt: '1000000' } },
          approverRole: 'purchase.director',
        },
      ],
    },
  ],
  actions: {
    'purchase.action_rfqs': action(PurchaseOrder, {
      label: 'Requests for quotation',
      views: ['list', 'kanban', 'form'],
      defaultFilters: ['rfqs'],
    }),
    'purchase.action_orders': action(PurchaseOrder, {
      label: 'Purchase orders',
      views: ['list', 'kanban', 'form'],
      defaultFilters: ['orders'],
    }),
    'purchase.action_to_approve': action(PurchaseOrder, {
      label: 'To approve',
      views: ['list', 'form'],
      domain: { state: 'to_approve' },
      visibleTo: ['purchase.manager'],
    }),
    'purchase.action_vendors': {
      model: 'res.partner',
      label: 'Vendors',
      views: ['list', 'form'],
      domain: { isVendor: true },
    },
  },
  menus: [
    { id: 'purchase.root', label: 'Purchase', app: 'purchase' },
    {
      id: 'purchase.rfqs',
      parent: 'purchase.root',
      label: 'Requests for quotation',
      action: 'purchase.action_rfqs',
      sequence: 1,
    },
    {
      id: 'purchase.orders',
      parent: 'purchase.root',
      label: 'Purchase orders',
      action: 'purchase.action_orders',
      sequence: 2,
    },
    {
      id: 'purchase.to_approve',
      parent: 'purchase.root',
      label: 'To approve',
      action: 'purchase.action_to_approve',
      sequence: 3,
      visibleTo: ['purchase.manager'],
    },
    {
      id: 'purchase.vendors',
      parent: 'purchase.root',
      label: 'Vendors',
      action: 'purchase.action_vendors',
      sequence: 4,
    },
  ],
  views: {
    'purchase.order.list': list(PurchaseOrder, {
      columns: [
        'name',
        'dateOrder',
        'partner',
        'user',
        'datePlanned',
        { field: 'amountTotal', sum: true },
        { field: 'state', widget: 'badge' },
      ],
      defaultOrder: ['dateOrder desc'],
    }),
    'purchase.order.kanban': kanban(PurchaseOrder, {
      groupBy: 'state',
      card: { title: 'partner', subtitle: 'name', footer: ['amountTotal', 'datePlanned'] },
    }),
    'purchase.order.form': form(PurchaseOrder, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('send', { label: 'Mark as sent' }),
          k.button('submit', { primary: true, label: 'Submit for approval' }),
          k.button('confirm', { primary: true, label: 'Confirm order' }),
          k.button('lock', { label: 'Lock' }),
          k.button('unlock', { label: 'Unlock' }),
          k.button('cancel', { label: 'Cancel', confirm: 'Cancel this order?' }),
          k.button('redraft', { label: 'Set to draft' }),
        ],
      },
      sheet: [
        k.group('vendor', ['partner', 'partnerReference', 'currency']),
        k.group('dates', ['name', 'dateOrder', 'datePlanned', 'user', 'origin']),
        k.lines(
          'lines',
          [
            'product',
            { field: 'name', id: 'line_name' },
            'quantity',
            'uom',
            'priceUnit',
            'taxes',
            { field: 'datePlanned', id: 'line_date_planned' },
            'subtotal',
          ],
          { readonlyWhen: { state: { notIn: ['draft', 'sent'] } } },
        ),
        k.group('totals', ['amountUntaxed', 'amountTax', 'amountTotal'], { label: 'Totals' }),
        k.component('approvals', 'approvals.Panel'),
        k.group('terms', ['note'], { columns: 1 }),
      ],
      readonlyWhen: { state: { in: ['done', 'cancel'] } },
      chatter: true,
    })),
  },
  search: {
    'purchase.order': search(PurchaseOrder, {
      fields: ['name', 'partner.name', 'partnerReference', 'origin'],
      filters: {
        rfqs: { label: 'RFQs', domain: { state: { in: ['draft', 'sent'] } }, group: 'stage' },
        waiting: { label: 'Waiting approval', domain: { state: 'to_approve' }, group: 'stage' },
        orders: {
          label: 'Purchase orders',
          domain: { state: { in: ['purchase', 'done'] } },
          group: 'stage',
        },
        mine: { label: 'My orders', domain: { user: { $env: 'uid' } } },
      },
      groupBy: ['state', 'partner', 'user', 'dateOrder:month'],
    }),
  },
});
