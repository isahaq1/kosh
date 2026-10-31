/**
 * @packageDocumentation
 * `@kosh/pos` (RFC 0021): the **Counter** app. Shops with their payment methods, cashiers' sessions with opening
 * and closing counts, sales with lines, taxes, several payments and the change — accepted once per device
 * reference — and the register, a page for a tablet or a phone. Receipts are documents. What a closed session
 * means to Stockroom and Accounting is the bridges' (`pos_stock`, `pos_account`).
 */
import { accounting } from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { reporting } from '@kosh/reporting';
import type { ModuleContext } from '@kosh/server';
import { action, form, list, search } from '@kosh/views';
import { posDemo } from './demo.js';
import { PosOrder, PosPaymentMethod, PosSession, PosShop, posShutro } from './module.js';
import { registerCounterRoutes } from './routes.js';

export {
  amountOf,
  PosOrder,
  PosOrderLine,
  PosOrderPayment,
  PosPaymentMethod,
  PosSession,
  PosShop,
  posShutro,
} from './module.js';
export { registerCounterRoutes, type SaleInput } from './routes.js';

export const pos: ReturnType<typeof defineModule> = defineModule({
  shutro: posShutro,
  kosh: '^0.1.0',
  hooks: { demo: posDemo },
  depends: [product, contacts, accounting, messaging, reporting],
  app: {
    code: 'counter',
    label: 'Counter',
    icon: 'counter',
    sequence: 43,
    category: 'Sales',
    summary: 'Point of sale: sessions, split payments, receipts, the register on a tablet',
  },
  accessLevels: {
    cashier: { label: 'Cashier (sell in own sessions)', groups: ['pos.cashier'] },
    manager: {
      label: 'Manager (shops, methods, every session)',
      groups: ['pos.manager'],
      implies: ['cashier'],
    },
  },
  events: [{ topic: 'pos.order.paid', model: 'pos.order', label: 'Sale paid at the counter' }],
  documents: [
    {
      key: 'receipt',
      name: 'Receipt',
      model: 'pos.order',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        blocks: [
          { kind: 'heading', id: 'title', text: '{{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'when',
            items: [
              { label: 'Date', bind: 'date' },
              { label: 'Session', bind: 'session.name' },
              { label: 'Customer', bind: 'partner.name' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'Item', bind: 'name' },
              { label: 'Qty', bind: 'quantity' },
              { label: 'Price', bind: 'priceUnit' },
              { label: 'Amount', bind: 'subtotal' },
            ],
          },
          {
            kind: 'fields',
            id: 'totals',
            items: [
              { label: 'Untaxed', bind: 'amountUntaxed' },
              { label: 'Taxes', bind: 'amountTax' },
              { label: 'Total', bind: 'total' },
              { label: 'Paid', bind: 'amountPaid' },
              { label: 'Change', bind: 'change' },
            ],
          },
          { kind: 'qr', id: 'qr', bind: 'name', size: 30, label: 'Sale reference' },
          { kind: 'text', id: 'footer', text: '{{session.shop.receiptFooter}}' },
        ],
      },
    },
  ],
  routes: (context: ModuleContext) => registerCounterRoutes(context),
  overview: {
    cards: [
      {
        id: 'sold_today',
        title: 'Sold this month',
        kind: 'kpi',
        model: 'pos.order',
        measure: 'sum:total',
        filter: { state: 'paid' },
        comparison: { field: 'date', mode: 'previous' },
        w: 3,
      },
      {
        id: 'sales_month',
        title: 'Sales this month',
        kind: 'kpi',
        model: 'pos.order',
        measure: 'count',
        filter: { state: 'paid' },
        comparison: { field: 'date', mode: 'previous' },
        w: 3,
      },
      {
        id: 'open_sessions',
        title: 'Open sessions',
        kind: 'kpi',
        model: 'pos.session',
        measure: 'count',
        filter: { state: 'open' },
        w: 3,
      },
      {
        id: 'average_sale',
        title: 'Average sale',
        kind: 'kpi',
        model: 'pos.order',
        measure: 'avg:total',
        filter: { state: 'paid' },
        w: 3,
      },
      {
        id: 'by_day',
        title: 'Sold by day',
        kind: 'chart',
        model: 'pos.order',
        measure: 'sum:total',
        groupBy: 'date:day',
        filter: { state: 'paid' },
        chart: 'bar',
        w: 6,
      },
      {
        id: 'by_method',
        title: 'By payment method',
        kind: 'chart',
        model: 'pos.order.payment',
        measure: 'sum:amount',
        groupBy: 'method',
        chart: 'pie',
        w: 6,
      },
      {
        id: 'top_products',
        title: 'Best sellers',
        kind: 'pivot',
        model: 'pos.order.line',
        measure: 'sum:quantity',
        groupBy: 'product',
        w: 6,
      },
      {
        id: 'differences',
        title: 'Closing differences',
        kind: 'list',
        model: 'pos.session',
        measure: 'sum:closingDifference',
        filter: { state: 'closed' },
        w: 6,
      },
    ],
  },
  actions: {
    'counter.action_register': { type: 'client', page: 'counter.Register', label: 'Register' },
    'counter.action_sessions': action(PosSession, { label: 'Sessions', views: ['list', 'form'] }),
    'counter.action_orders': action(PosOrder, {
      label: 'Sales',
      views: ['list', 'form'],
      defaultFilters: ['paid'],
    }),
    'counter.action_shops': action(PosShop, {
      label: 'Shops',
      views: ['list', 'form'],
      visibleTo: ['pos.manager'],
    }),
  },
  menus: [
    { id: 'counter.root', label: 'Counter', app: 'counter' },
    {
      id: 'counter.register',
      parent: 'counter.root',
      label: 'Register',
      action: 'counter.action_register',
      sequence: 1,
    },
    {
      id: 'counter.sessions',
      parent: 'counter.root',
      label: 'Sessions',
      action: 'counter.action_sessions',
      sequence: 2,
    },
    {
      id: 'counter.orders',
      parent: 'counter.root',
      label: 'Sales',
      action: 'counter.action_orders',
      sequence: 3,
    },
    {
      id: 'counter.shops',
      parent: 'counter.root',
      label: 'Shops',
      action: 'counter.action_shops',
      sequence: 9,
      visibleTo: ['pos.manager'],
    },
  ],
  views: {
    'pos.session.list': list(PosSession, {
      columns: [
        'name',
        'shop',
        'cashier',
        'openedAt',
        'closedAt',
        'orderCount',
        { field: 'total', sum: true },
        'expectedCash',
        'closingCash',
        'closingDifference',
        { field: 'state', widget: 'badge' },
      ],
      decorations: {
        success: { state: 'closed', closingDifference: '0' },
        warning: { state: 'open' },
      },
    }),
    'pos.session.form': form(PosSession, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [k.button('close', { primary: true, label: 'Close the session' })],
      },
      sheet: [
        k.group('main', ['name', 'shop', 'cashier', 'openedAt', 'closedAt']),
        k.group(
          'cash',
          ['openingCash', 'expectedCash', 'closingCash', 'closingDifference', 'differenceReason'],
          {
            label: 'Cash',
            description: 'Count the drawer before closing; a difference needs a reason.',
          },
        ),
        k.group('totals', ['orderCount', 'total'], { label: 'Totals' }),
      ],
      chatter: true,
    })),
    'pos.order.list': list(PosOrder, {
      columns: [
        'name',
        'date',
        'session',
        'partner',
        { field: 'total', sum: true },
        { field: 'amountTax', sum: true },
        'change',
        { field: 'state', widget: 'badge' },
      ],
      decorations: { neutral: { state: 'void' } },
    }),
    'pos.order.form': form(PosOrder, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('pay', { primary: true, label: 'Mark paid' }),
          k.button('void', { label: 'Void' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'session', 'date', 'partner', 'refundOf', 'note']),
        k.lines('lines', [
          'product',
          { field: 'name', id: 'line_name' },
          'quantity',
          'priceUnit',
          'discount',
          'taxes',
          'subtotal',
          'taxAmount',
        ]),
        k.lines('payments', ['method', { field: 'amount', id: 'payment_amount' }, 'reference']),
        k.group('totals', ['amountUntaxed', 'amountTax', 'total', 'amountPaid', 'change'], {
          label: 'Totals',
        }),
      ],
      chatter: true,
    })),
    'pos.shop.list': list(PosShop, { columns: ['name', 'pricesIncludeTax', 'salesJournal'] }),
    'pos.shop.form': form(PosShop, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'pricesIncludeTax', 'salesJournal', 'receiptFooter']),
        k.lines('methods', [{ field: 'name', id: 'method_name' }, 'kind', 'journal', 'sequence']),
      ],
    })),
    'pos.payment.method.list': list(PosPaymentMethod, {
      columns: ['name', 'shop', 'kind', 'journal'],
    }),
  },
  search: {
    'pos.session': search(PosSession, {
      fields: ['name', 'shop.name', 'cashier.name'],
      filters: {
        open: { label: 'Open', domain: { state: 'open' }, group: 'state' },
        closed: { label: 'Closed', domain: { state: 'closed' }, group: 'state' },
      },
      groupBy: ['shop', 'cashier', 'state', 'openedAt:day'],
    }),
    'pos.order': search(PosOrder, {
      fields: ['name', 'partner.name', 'note'],
      filters: {
        paid: { label: 'Paid', domain: { state: 'paid' }, group: 'state' },
        voided: { label: 'Voided', domain: { state: 'void' }, group: 'state' },
      },
      groupBy: ['session', 'partner', 'date:day'],
    }),
    'pos.shop': search(PosShop, { fields: ['name'] }),
  },
});
