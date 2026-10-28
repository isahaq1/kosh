/**
 * @packageDocumentation
 * `@kosh/sales` (RFC 0008): the Sales app. Quotations and sales orders with discounts and taxes, totals in the
 * order's currency, a guarded workflow (quotation → sent → sales order → locked), and the chatter on every order.
 * Salespeople see their own orders; managers see all.
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { action, form, kanban, list, search } from '@kosh/views';
import { salesDemo } from './demo.js';
import { SaleOrder, SaleOrderLine, salesShutro } from './module.js';

export { SaleOrder, SaleOrderLine, salesShutro } from './module.js';

export const sales: ReturnType<typeof defineModule> = defineModule({
  shutro: salesShutro,
  kosh: '^0.1.0',
  hooks: { demo: salesDemo },
  depends: [contacts, product, messaging],
  // What webhooks may subscribe to besides record changes (RFC 0017 §5.3).
  events: [{ topic: 'sale.order.confirmed', model: 'sale.order', label: 'Sales order confirmed' }],
  app: {
    code: 'sales',
    label: 'Sales',
    icon: 'sales',
    sequence: 10,
    category: 'Sales',
    summary: 'Quotations, sales orders, discounts and taxes',
  },
  accessLevels: {
    user: { label: 'Salesperson (own orders)', groups: ['sales.user'] },
    manager: { label: 'Manager (all orders)', groups: ['sales.manager'], implies: ['user'] },
  },
  // The printed quotation (RFC 0005), installed as a template designers can change; the portal prints it too.
  documents: [
    {
      key: 'quotation',
      name: 'Quotation',
      model: 'sale.order',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: '{{state}} {{name}}', level: 1 },
          {
            kind: 'columns',
            id: 'parties',
            left: [
              {
                kind: 'fields',
                id: 'customer',
                items: [
                  { label: 'Customer', bind: 'partner.name' },
                  { label: 'Customer reference', bind: 'clientReference' },
                ],
              },
            ],
            right: [
              {
                kind: 'fields',
                id: 'dates',
                items: [
                  { label: 'Order date', bind: 'dateOrder' },
                  { label: 'Valid until', bind: 'validityDate' },
                  { label: 'Salesperson', bind: 'user.name' },
                ],
              },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'Description', bind: 'name' },
              { label: 'Quantity', bind: 'quantity', align: 'end' },
              { label: 'Unit price', bind: 'priceUnit', align: 'end' },
              { label: 'Discount %', bind: 'discount', align: 'end' },
              { label: 'Tax', bind: 'taxAmount', align: 'end' },
              { label: 'Subtotal', bind: 'subtotal', align: 'end', sum: true },
            ],
          },
          {
            kind: 'fields',
            id: 'totals',
            columns: 3,
            items: [
              { label: 'Untaxed', bind: 'amountUntaxed' },
              { label: 'Taxes', bind: 'amountTax' },
              { label: 'Total', bind: 'amountTotal' },
            ],
          },
          { kind: 'text', id: 'in_words', text: '{{amountTotal|words}}' },
          { kind: 'text', id: 'terms', text: '{{note}}' },
        ],
      },
    },
  ],
  actions: {
    'sales.action_quotations': action(SaleOrder, {
      label: 'Quotations',
      views: ['list', 'kanban', 'form'],
      defaultFilters: ['quotations'],
    }),
    'sales.action_orders': action(SaleOrder, {
      label: 'Sales orders',
      views: ['list', 'kanban', 'form'],
      defaultFilters: ['orders'],
    }),
    'sales.action_customers': {
      model: 'res.partner',
      label: 'Customers',
      views: ['list', 'form'],
      domain: { isCustomer: true },
    },
  },
  menus: [
    { id: 'sales.root', label: 'Sales', app: 'sales' },
    {
      id: 'sales.quotations',
      parent: 'sales.root',
      label: 'Quotations',
      action: 'sales.action_quotations',
      sequence: 1,
    },
    {
      id: 'sales.orders',
      parent: 'sales.root',
      label: 'Sales orders',
      action: 'sales.action_orders',
      sequence: 2,
    },
    {
      id: 'sales.customers',
      parent: 'sales.root',
      label: 'Customers',
      action: 'sales.action_customers',
      sequence: 3,
    },
  ],
  views: {
    'sale.order.list': list(SaleOrder, {
      columns: [
        'name',
        'dateOrder',
        'partner',
        'user',
        { field: 'amountTotal', sum: true },
        { field: 'state', widget: 'badge' },
      ],
      defaultOrder: ['dateOrder desc'],
    }),
    'sale.order.kanban': kanban(SaleOrder, {
      groupBy: 'state',
      card: { title: 'partner', subtitle: 'name', footer: ['amountTotal', 'dateOrder'] },
    }),
    'sale.order.form': form(SaleOrder, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('send', { label: 'Mark as sent' }),
          k.button('confirm', { primary: true, label: 'Confirm' }),
          k.button('lock', { label: 'Lock' }),
          k.button('unlock', { label: 'Unlock' }),
          k.button('cancel', { label: 'Cancel', confirm: 'Cancel this order?' }),
          k.button('redraft', { label: 'Set to quotation' }),
        ],
      },
      sheet: [
        k.group('customer', ['partner', 'clientReference', 'currency']),
        k.group('dates', ['name', 'dateOrder', 'validityDate', 'user']),
        k.lines(
          'lines',
          [
            'product',
            { field: 'name', id: 'line_name' },
            'quantity',
            'uom',
            'priceUnit',
            'discount',
            'taxes',
            'subtotal',
          ],
          { readonlyWhen: { state: { in: ['done', 'cancel'] } } },
        ),
        k.group('totals', ['amountUntaxed', 'amountTax', 'amountTotal'], { label: 'Totals' }),
        k.group('terms', ['note'], { columns: 1 }),
      ],
      readonlyWhen: { state: { in: ['done', 'cancel'] } },
      chatter: true,
    })),
    'sale.order.line.list': list(SaleOrderLine, {
      columns: ['order', 'product', 'quantity', 'priceUnit', 'subtotal'],
    }),
  },
  search: {
    'sale.order': search(SaleOrder, {
      fields: ['name', 'partner.name', 'clientReference'],
      filters: {
        quotations: {
          label: 'Quotations',
          domain: { state: { in: ['draft', 'sent'] } },
          group: 'stage',
        },
        orders: {
          label: 'Sales orders',
          domain: { state: { in: ['sale', 'done'] } },
          group: 'stage',
        },
        mine: { label: 'My orders', domain: { user: { $env: 'uid' } } },
      },
      groupBy: ['state', 'partner', 'user', 'dateOrder:month'],
    }),
  },
});
