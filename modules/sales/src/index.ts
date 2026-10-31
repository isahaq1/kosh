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
import { reporting } from '@kosh/reporting';
import { action, form, kanban, list, search, stat } from '@kosh/views';
import { salesDemo } from './demo.js';
import { SaleOrder, SaleOrderLine, salesShutro } from './module.js';

export { SaleOrder, SaleOrderLine, salesShutro } from './module.js';

export const sales: ReturnType<typeof defineModule> = defineModule({
  shutro: salesShutro,
  kosh: '^0.1.0',
  hooks: { demo: salesDemo },
  depends: [contacts, product, messaging, reporting],
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
  // Settings › App settings › Sales (RFC 0020): per company, changed by sales managers.
  settings: {
    sections: [
      {
        key: 'quotations',
        label: 'Quotations',
        description: 'How long new quotations stay valid, and the terms they start with.',
        keywords: 'quote validity expiry terms conditions',
        scope: 'company',
        editors: ['sales.manager'],
        fields: [
          {
            key: 'saleValidityDays',
            min: 0,
            max: 365,
            help: 'A new quotation is valid until its date plus these days; 0 leaves it open.',
          },
          {
            key: 'saleTerms',
            help: 'Filled in on new quotations; each can still be changed.',
          },
        ],
      },
    ],
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
  // The Overview page (RFC 0022 §3.2): this month against the last, the year's curve, who buys, what to chase.
  overview: {
    cards: [
      {
        id: 'sales_month',
        title: 'Sales this month',
        kind: 'kpi',
        model: 'sale.order',
        measure: 'sum:amountTotal',
        filter: { state: { in: ['sale', 'done'] } },
        comparison: { field: 'dateOrder', mode: 'previous' },
        w: 3,
      },
      {
        id: 'orders_month',
        title: 'Orders this month',
        kind: 'kpi',
        model: 'sale.order',
        measure: 'count',
        filter: { state: { in: ['sale', 'done'] } },
        comparison: { field: 'dateOrder', mode: 'previous' },
        w: 3,
      },
      {
        id: 'open_quotations',
        title: 'Open quotations',
        kind: 'kpi',
        model: 'sale.order',
        measure: 'count',
        filter: { state: { in: ['draft', 'sent'] } },
        w: 3,
      },
      {
        id: 'average_order',
        title: 'Average order',
        kind: 'kpi',
        model: 'sale.order',
        measure: 'avg:amountTotal',
        filter: { state: { in: ['sale', 'done'] } },
        w: 3,
      },
      {
        id: 'sales_by_month',
        title: 'Sales by month',
        kind: 'chart',
        model: 'sale.order',
        measure: 'sum:amountTotal',
        groupBy: 'dateOrder:month',
        filter: { state: { in: ['sale', 'done'] } },
        chart: 'bar',
        w: 6,
      },
      {
        id: 'top_customers',
        title: 'Top customers',
        kind: 'pivot',
        model: 'sale.order',
        measure: 'sum:amountTotal',
        groupBy: 'partner',
        filter: { state: { in: ['sale', 'done'] } },
        w: 6,
      },
      {
        id: 'by_salesperson',
        title: 'By salesperson',
        kind: 'chart',
        model: 'sale.order',
        measure: 'sum:amountTotal',
        groupBy: 'user',
        filter: { state: { in: ['sale', 'done'] } },
        chart: 'pie',
        w: 6,
      },
      {
        id: 'quotations_to_chase',
        title: 'Biggest open quotations',
        kind: 'list',
        model: 'sale.order',
        measure: 'sum:amountTotal',
        filter: { state: { in: ['draft', 'sent'] } },
        w: 6,
      },
    ],
  },
  viewExtensions: [
    {
      view: 'product.product.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'product_sold',
              label: 'Sold',
              model: SaleOrderLine,
              where: { product: { $record: 'id' }, 'order.state': { in: ['sale', 'done'] } },
              measure: { sum: 'quantity' },
            }),
            stat({
              id: 'product_revenue',
              label: 'Sales',
              model: SaleOrderLine,
              where: { product: { $record: 'id' }, 'order.state': { in: ['sale', 'done'] } },
              measure: { sum: 'subtotal' },
              tone: 'success',
            }),
          ],
        },
      ],
    },
    {
      view: 'res.partner.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'sale_orders',
              label: 'Sales orders',
              model: SaleOrder,
              where: { partner: { $record: 'id' }, state: { in: ['sale', 'done'] } },
              action: 'sales.action_orders',
            }),
            stat({
              id: 'sale_revenue',
              label: 'Sales',
              model: SaleOrder,
              where: { partner: { $record: 'id' }, state: { in: ['sale', 'done'] } },
              measure: { sum: 'amountTotal' },
              action: 'sales.action_orders',
              tone: 'success',
            }),
          ],
        },
      ],
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
      decorations: { success: { state: 'done' }, neutral: { state: 'cancel' } },
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
        // Invoices, deliveries, tasks: the bridges append their tiles (RFC 0022 §3.1).
        k.stats('related', []),
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
