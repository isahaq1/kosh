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
import { action, calendar, field, form, kanban, list, search, stat } from '@kosh/views';
import { salesDemo } from './demo.js';
import { SaleOrder, SaleOrderLine, SaleOrderTemplate, salesShutro } from './module.js';

export { SaleOrder, SaleOrderLine, salesShutro } from './module.js';

export const sales: ReturnType<typeof defineModule> = defineModule({
  shutro: salesShutro,
  kosh: '^0.1.0',
  hooks: { demo: salesDemo },
  depends: [contacts, product, messaging, reporting],
  // What webhooks may subscribe to besides record changes (RFC 0017 §5.3).
  events: [
    { topic: 'sale.order.confirmed', model: 'sale.order', label: 'Sales order confirmed' },
    { topic: 'sale.order.cancelled', model: 'sale.order', label: 'Sales order cancelled' },
  ],
  app: {
    code: 'sales',
    label: 'Sales',
    icon: 'sales',
    sequence: 10,
    category: 'Sales',
    summary: 'Quotations, sales orders, discounts and taxes',
  },
  importTemplates: [
    {
      key: 'sale_order_template',
      model: 'sale.order.template',
      label: 'Quotation template',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Valid for (days)', field: 'validityDays' },
        { header: 'Terms and conditions', field: 'note' },
      ],
    },
    {
      key: 'sale_order',
      model: 'sale.order',
      label: 'Sales order',
      columns: [
        { header: 'Salesperson', field: 'user' },
        { header: 'Customer', field: 'partner' },
        { header: 'Currency', field: 'currency' },
        { header: 'Order date', field: 'dateOrder' },
        { header: 'Valid until', field: 'validityDate' },
        { header: 'Customer reference', field: 'clientReference' },
        { header: 'Terms and conditions', field: 'note' },
        { header: 'Lines › Product', field: 'lines.product' },
        { header: 'Lines › Description', field: 'lines.name' },
        { header: 'Lines › Quantity', field: 'lines.quantity' },
        { header: 'Lines › Unit', field: 'lines.uom' },
        { header: 'Lines › Unit price', field: 'lines.priceUnit' },
      ],
    },
  ],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
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
  // Quotations and orders sent by email with their PDF (RFC 0029 §3.3).
  mailTemplates: [
    {
      key: 'quotation',
      name: 'Quotation',
      model: 'sale.order',
      document: 'sales.quotation',
      subject: '{{company.name}}: {{name}}',
      body: 'Dear {{partner.name}},\n\nPlease find attached {{name}} of {{amountTotal}}, valid until {{validityDate}}.\n\nWe are glad to answer any question.\n\n{{company.name}}',
      translations: {
        bn_BD: {
          subject: '{{company.name}}: {{name}}',
          body: 'প্রিয় {{partner.name}},\n\n{{amountTotal}}-এর {{name}} সংযুক্ত করা হলো, {{validityDate}} পর্যন্ত বৈধ।\n\nযেকোনো প্রশ্নের উত্তর দিতে পেরে আমরা খুশি হব।\n\n{{company.name}}',
        },
      },
    },
  ],
  sendable: [{ model: 'sale.order', template: 'sales.quotation', partner: 'partner' }],
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
        id: 'margin_month',
        title: 'Margin this month',
        kind: 'kpi',
        model: 'sale.order',
        measure: 'sum:margin',
        filter: { state: { in: ['sale', 'done'] } },
        comparison: { field: 'dateOrder', mode: 'previous' },
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
    // The customer's price list on the contact (RFC 0028 §3.1).
    {
      view: 'res.partner.form',
      operations: [
        { append: 'roles', nodes: [field({ field: 'pricelist', id: 'partner_pricelist' })] },
      ],
    },
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
      views: ['list', 'kanban', 'calendar', 'form'],
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
    'sales.action_templates': action(SaleOrderTemplate, {
      label: 'Quotation templates',
      views: ['list', 'form'],
      visibleTo: ['sales.manager'],
    }),
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
    {
      id: 'sales.config',
      parent: 'sales.root',
      label: 'Configuration',
      sequence: 90,
      visibleTo: ['sales.manager'],
    },
    {
      id: 'sales.templates',
      parent: 'sales.config',
      label: 'Quotation templates',
      action: 'sales.action_templates',
      visibleTo: ['sales.manager'],
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
        { field: 'margin', sum: true },
        { field: 'marginPercent', widget: 'percentage' },
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
          k.button('fill', { label: 'Fill from template' }),
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
        k.group('customer', [
          'partner',
          'partnerInvoice',
          'partnerShipping',
          'pricelist',
          'clientReference',
          'currency',
        ]),
        k.group('dates', ['name', 'dateOrder', 'validityDate', 'user']),
        k.component('variant_grid', 'product.VariantGrid', { field: 'lines' }),
        k.lines(
          'lines',
          [
            'product',
            { field: 'name', id: 'line_name' },
            'quantity',
            'uom',
            'priceUnit',
            { field: 'priceReason', id: 'line_price_reason' },
            'discount',
            'taxes',
            'subtotal',
          ],
          { readonlyWhen: { state: { in: ['done', 'cancel'] } } },
        ),
        k.group(
          'totals',
          ['amountUntaxed', 'amountTax', 'amountTotal', 'margin', 'marginPercent'],
          {
            label: 'Totals',
          },
        ),
        k.group('terms', ['template', 'note'], { columns: 1 }),
        k.lines('options', [
          { field: 'product', id: 'option_product' },
          { field: 'name', id: 'option_name' },
          { field: 'quantity', id: 'option_quantity' },
          { field: 'priceUnit', id: 'option_price' },
          { field: 'state', id: 'option_state' },
        ]),
      ],
      readonlyWhen: { state: { in: ['done', 'cancel'] } },
      chatter: true,
    })),
    'sale.order.template.list': list(SaleOrderTemplate, {
      columns: ['name', 'validityDays', 'active'],
    }),
    'sale.order.template.form': form(SaleOrderTemplate, (k) => ({
      sheet: [
        k.group('main', ['name', 'validityDays'], {
          description:
            'A quotation filled from the template gets its lines, its optional products (offered to the customer), its validity and its terms.',
        }),
        k.lines('lines', [
          'sequence',
          'product',
          { field: 'name', id: 'template_line_name' },
          'quantity',
          'optional',
        ]),
        k.group('terms_page', ['note'], { columns: 1, label: 'Terms and conditions' }),
      ],
    })),
    // Quotations by the day they expire: what to chase this week.
    'sale.order.calendar': calendar(SaleOrder, {
      dateStart: 'validityDate',
      title: 'name',
      color: 'state',
      mode: 'month',
    }),
    'sale.order.line.list': list(SaleOrderLine, {
      columns: ['order', 'product', 'quantity', 'priceUnit', 'subtotal'],
    }),
  },
  search: {
    'sale.order.template': search(SaleOrderTemplate, { fields: ['name'] }),
    'sale.order.line': search(SaleOrderLine, {
      fields: ['name', 'product.name', 'order.name'],
      groupBy: ['product', 'order'],
    }),
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
