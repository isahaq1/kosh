/**
 * @packageDocumentation
 * `@kosh/rental`: Rental (RFC 0038, step 6) — products rented by the hour or the day, orders reserved against
 * what is free, picked up and returned, with deposits and the fee of a late return.
 *
 * - `GET /api/v1/rental/availability?product=&from=&to=`   how many of a product are free over a period
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { reporting } from '@kosh/reporting';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { action, calendar, field, form, list, search, stat } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { rentalDemo } from './demo.js';
import { freeOf, RentalLine, RentalOrder, rentalShutro } from './module.js';

export { freeOf, HOLDING, ProductRental, RentalLine, RentalOrder, rentalShutro } from './module.js';
export { type Booking, lateUnits, peakBooked, type RentUnit, unitsOf } from './period.js';

function registerRentalRoutes(context: ModuleContext): void {
  context.app.get('/api/v1/rental/availability', async (request) => {
    const q = request.query as { product?: unknown; from?: unknown; to?: unknown };
    const productId = Number(q.product);
    const from = Date.parse(String(q.from ?? ''));
    const to = Date.parse(String(q.to ?? ''));
    if (!Number.isInteger(productId) || Number.isNaN(from) || Number.isNaN(to) || to <= from)
      throw new HttpProblem(
        400,
        'invalid-query',
        'Invalid period',
        'Give product, from and to (ISO dates), with to after from.',
      );
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        // Read as the user first: only someone who may see the product learns what is free of it.
        const [p] = await env
          .model('product.product')
          .search({ where: { id: productId, rentable: true } as never, limit: 1 })
          .then((r) => r.load(['name']));
        if (p === undefined)
          throw new HttpProblem(404, 'missing-record', 'Not found', 'No such product for rent.');
        if (!env.administrator && !env.groups.has('rental.user'))
          throw new HttpProblem(403, 'access', 'Forbidden', 'This needs the Rental access.');
        const company = env.companyId as number;
        const { total, free } = await env.asSuperuser({ reason: 'rental availability' }, (su) =>
          freeOf(su, company, productId, from, to),
        );
        return { product: productId, name: p.name, total, free: Math.max(0, free) };
      },
      { write: true },
    );
  });
}

export const rental: ReturnType<typeof defineModule> = defineModule({
  shutro: rentalShutro,
  kosh: '^0.1.0',
  hooks: { demo: rentalDemo },
  depends: [contacts, product, messaging, reporting],
  app: {
    code: 'rental',
    label: 'Rental',
    icon: 'rental',
    sequence: 18,
    category: 'Operations',
    summary:
      'Products rented by the hour or the day, reserved against what is free, late fees, deposits',
  },
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'User (rental orders)', groups: ['rental.user'] },
    manager: {
      label: 'Rental manager (deletes, imports, exports)',
      groups: ['rental.manager'],
      implies: ['user'],
    },
  },
  routes: (context: ModuleContext) => registerRentalRoutes(context),
  // Exceptions to the module standard (RFC 0023), each with its reason.
  standard: {
    waive: [
      {
        rule: 'I1',
        model: 'rental.order',
        reason:
          'An order is reserved against what is free at that moment; a list of past orders would bypass the check.',
      },
    ],
  },
  events: [
    { topic: 'rental.order.reserved', model: 'rental.order', label: 'Rental reserved' },
    { topic: 'rental.order.picked_up', model: 'rental.order', label: 'Rental picked up' },
    { topic: 'rental.order.returned', model: 'rental.order', label: 'Rental returned' },
  ],
  documents: [
    {
      key: 'rental_order',
      name: 'Rental agreement',
      model: 'rental.order',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Rental agreement {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'who',
            items: [
              { label: 'Customer', bind: 'partner.name' },
              { label: 'From', bind: 'start' },
              { label: 'Until', bind: 'stop' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'Product', bind: 'product.name' },
              { label: 'Quantity', bind: 'quantity' },
              { label: 'Units', bind: 'units' },
              { label: 'Rent per unit', bind: 'priceUnit' },
              { label: 'Rent', bind: 'subtotal' },
              { label: 'Deposit', bind: 'depositTotal' },
            ],
          },
          {
            kind: 'fields',
            id: 'totals',
            items: [
              { label: 'Rent', bind: 'rentTotal' },
              { label: 'Deposit', bind: 'depositTotal' },
              { label: 'Late fee', bind: 'lateFee' },
              { label: 'To charge', bind: 'amountDue' },
            ],
          },
          {
            kind: 'text',
            id: 'sign',
            text: 'Customer: ______________   For the company: ______________',
          },
        ],
      },
    },
  ],
  overview: {
    cards: [
      {
        id: 'out_now',
        title: 'Out now',
        kind: 'kpi',
        model: 'rental.order',
        measure: 'count',
        filter: { state: 'out' },
        w: 3,
      },
      {
        id: 'reserved',
        title: 'Reserved',
        kind: 'kpi',
        model: 'rental.order',
        measure: 'count',
        filter: { state: 'reserved' },
        w: 3,
      },
      {
        id: 'rent_month',
        title: 'Rent this month',
        kind: 'kpi',
        model: 'rental.order',
        measure: 'sum:rentTotal',
        filter: { state: { in: ['out', 'returned'] } },
        comparison: { field: 'start', mode: 'previous' },
        w: 3,
      },
      {
        id: 'late_fees',
        title: 'Late fees',
        kind: 'kpi',
        model: 'rental.order',
        measure: 'sum:lateFee',
        filter: { state: 'returned' },
        w: 3,
      },
      {
        id: 'by_state',
        title: 'Orders by state',
        kind: 'chart',
        model: 'rental.order',
        measure: 'count',
        groupBy: 'state',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'rent_by_product',
        title: 'Rent by product',
        kind: 'pivot',
        model: 'rental.line',
        measure: 'sum:subtotal',
        groupBy: 'product',
        w: 6,
      },
      {
        id: 'rent_by_month',
        title: 'Rent by month',
        kind: 'chart',
        model: 'rental.order',
        measure: 'sum:rentTotal',
        groupBy: 'start:month',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'by_customer',
        title: 'Rent by customer',
        kind: 'pivot',
        model: 'rental.order',
        measure: 'sum:rentTotal',
        groupBy: 'partner',
        w: 6,
      },
    ],
  },
  actions: {
    'rental.action_orders': action(RentalOrder, {
      label: 'Rental orders',
      views: ['list', 'calendar', 'form'],
    }),
    'rental.action_lines': action(RentalLine, {
      label: 'Rented products',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'rental.root', label: 'Rental', app: 'rental' },
    {
      id: 'rental.orders',
      parent: 'rental.root',
      label: 'Rental orders',
      action: 'rental.action_orders',
      sequence: 1,
    },
    {
      id: 'rental.lines',
      parent: 'rental.root',
      label: 'Rented products',
      action: 'rental.action_lines',
      sequence: 2,
    },
  ],
  viewExtensions: [
    {
      view: 'product.product.form',
      operations: [
        {
          insertAfter: 'prices',
          nodes: [
            {
              kind: 'group',
              id: 'rental_terms',
              label: 'Rental',
              children: [
                field({ field: 'rentable', id: 'rent_rentable' }),
                field({ field: 'rentUnit', id: 'rent_unit' }),
                field({ field: 'rentPrice', id: 'rent_price' }),
                field({ field: 'rentDeposit', id: 'rent_deposit' }),
                field({ field: 'rentLateFee', id: 'rent_late_fee' }),
                field({ field: 'rentQuantity', id: 'rent_quantity' }),
              ],
            },
          ],
        },
        {
          append: 'related',
          nodes: [
            stat({
              id: 'product_rentals',
              label: 'Rentals',
              model: RentalLine,
              where: { product: { $record: 'id' } },
              action: 'rental.action_lines',
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
              id: 'partner_rentals',
              label: 'Rentals',
              model: RentalOrder,
              where: { partner: { $record: 'id' } },
              action: 'rental.action_orders',
            }),
          ],
        },
      ],
    },
  ],
  views: {
    'rental.order.list': list(RentalOrder, {
      columns: [
        'name',
        'partner',
        'start',
        'stop',
        { field: 'rentTotal', sum: true },
        { field: 'depositTotal', sum: true },
        { field: 'lateFee', sum: true },
        { field: 'state', widget: 'badge' },
      ],
      decorations: {
        info: { state: 'reserved' },
        warning: { state: 'out' },
        success: { state: 'returned' },
        neutral: { state: 'cancel' },
      },
    }),
    'rental.order.calendar': calendar(RentalOrder, {
      dateStart: 'start',
      dateStop: 'stop',
      title: 'partner',
      color: 'state',
      mode: 'week',
    }),
    'rental.order.form': form(RentalOrder, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('confirm', { primary: true, label: 'Reserve' }),
          k.button('pickup', { primary: true, label: 'Picked up' }),
          k.button('receive', { primary: true, label: 'Returned' }),
          k.button('cancel', { label: 'Cancel' }),
        ],
      },
      readonlyWhen: { state: { in: ['returned', 'cancel'] } },
      sheet: [
        k.group('main', ['name', 'partner', 'start', 'stop'], {
          description:
            'Reserving checks that every product is free for the whole period; a reserved order keeps its period.',
        }),
        k.lines('lines', [
          { field: 'product', id: 'line_product' },
          { field: 'quantity', id: 'line_quantity' },
          { field: 'unit', id: 'line_unit' },
          { field: 'units', id: 'line_units' },
          { field: 'priceUnit', id: 'line_price' },
          { field: 'subtotal', id: 'line_subtotal' },
          { field: 'depositTotal', id: 'line_deposit' },
        ]),
        k.group('totals', ['rentTotal', 'depositTotal', 'lateFee', 'amountDue'], {
          label: 'Amounts',
          description: 'Before taxes. The deposit is held, not charged.',
        }),
        k.group('times', ['pickedAt', 'returnedAt'], { label: 'When' }),
        k.group('notes', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'rental.line.list': list(RentalLine, {
      columns: ['order', 'product', 'quantity', 'unit', 'units', { field: 'subtotal', sum: true }],
    }),
    'rental.line.form': form(RentalLine, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', [
          'order',
          'product',
          'quantity',
          'unit',
          'priceUnit',
          'deposit',
          'lateFee',
        ]),
      ],
    })),
  },
  search: {
    'rental.order': search(RentalOrder, {
      fields: ['name', 'partner.name'],
      filters: {
        reserved: { label: 'Reserved', domain: { state: 'reserved' }, group: 'state' },
        out: { label: 'Picked up', domain: { state: 'out' }, group: 'state' },
        returned: { label: 'Returned', domain: { state: 'returned' }, group: 'state' },
      },
      groupBy: ['state', 'partner', 'start:month'],
    }),
    'rental.line': search(RentalLine, {
      fields: ['product.name', 'order.name'],
      groupBy: ['product', 'order'],
    }),
  },
});
