/**
 * @packageDocumentation
 * `@kosh/stock` (RFC 0021): the **Stockroom** app. Warehouses and a tree of locations; the Transfer — one document
 * for receipts, deliveries and internal moves — with one status chip (Draft, Waiting, Ready, Done, Cancelled);
 * reservations that say what they are for; units converted exactly; stock that never goes below zero. Every company
 * gets its main warehouse (`WH`, `WH/Stock`) when the app is installed or the company is created.
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { reporting } from '@kosh/reporting';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { type Id, orm } from '@kosh/server/orm';
import { action, field, form, kanban, list, search, stat } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { stockDemo } from './demo.js';
import {
  onHandIn,
  StockCount,
  StockCountLine,
  StockLocation,
  StockLot,
  StockLotLine,
  StockMove,
  StockPicking,
  StockQuant,
  StockReservation,
  StockScrap,
  StockWarehouse,
  stockShutro,
} from './module.js';

export {
  defaultLocations,
  inProductUnit,
  onHandIn,
  ProductStock,
  reserveOnConfirm,
  SCRAP_REASONS,
  StockCount,
  StockCountLine,
  StockLocation,
  StockLot,
  StockLotLine,
  StockMove,
  StockPicking,
  StockQuant,
  StockReservation,
  StockScrap,
  StockWarehouse,
  stockShutro,
} from './module.js';

/** Every company without a warehouse gets its main one, `WH`, with its stock location `WH/Stock`. */
async function mainWarehouses(env: Env): Promise<string | undefined> {
  const companies = await env.model('res.company').search({});
  let made = 0;
  for (const company of companies.ids) {
    const any = await env
      .withFlags({ activeTest: false })
      .model('stock.warehouse')
      .search({ where: { company }, limit: 1 });
    if (any.length > 0) continue;
    const warehouse = (
      await env.model('stock.warehouse').create([{ name: 'Main warehouse', code: 'WH', company }])
    ).ids[0];
    if (warehouse === undefined) continue;
    await env
      .model('stock.location')
      .create([{ name: 'Stock', usage: 'internal', warehouse, company }]);
    made += 1;
  }
  // Checked here, in this scope (the caller's flush would run the checks without its rights).
  await env.flush();
  return made === 0 ? undefined : `${made} main warehouse(s) made`;
}

/**
 * Counting from a phone: each scan adds to what is counted (one, or the quantity sent) — a lot or serial number's
 * name counts that lot, a product's barcode the product — on the count's line, made with what is expected when it
 * was not listed. As the user: their rights apply; the count must be counting.
 */
function registerCountRoutes({ app }: ModuleContext): void {
  app.post('/api/v1/stockroom/counts/:id/scan', async (request) => {
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'A count id.');
    const body = (request.body ?? {}) as { barcode?: unknown; quantity?: unknown };
    const barcode = typeof body.barcode === 'string' ? body.barcode.trim() : '';
    if (barcode === '')
      throw new HttpProblem(400, 'invalid-barcode', 'No barcode', 'Send the scanned barcode.');
    let quantity = orm.toDecimal(1);
    if (body.quantity !== undefined)
      try {
        quantity = orm.toDecimal(String(body.quantity));
      } catch {
        throw new HttpProblem(400, 'invalid-quantity', 'Invalid quantity', 'A positive number.');
      }
    if (quantity.lte(0))
      throw new HttpProblem(400, 'invalid-quantity', 'Invalid quantity', 'A positive number.');
    return request.env(
      async (raw) => {
        const env = raw as Env;
        const [count] = await (
          await env
            .model('stock.count')
            .search({ where: { id: orm.asId(id, 'stock.count') }, limit: 1 })
        ).load({ location: true });
        if (count === undefined)
          throw new HttpProblem(404, 'missing-record', 'Not found', `There is no count ${id}.`);
        if (count.state !== 'counting')
          throw new HttpProblem(409, 'not-counting', 'Not counting', 'Start the count first.');
        const [scannedLot] = await (
          await env.model('stock.lot').search({ where: { name: barcode }, limit: 1 })
        ).load({ product: true });
        const lot = scannedLot?.id ?? null;
        const [found] =
          scannedLot !== undefined
            ? [scannedLot.product]
            : await (
                await env.model('product.product').search({ where: { barcode }, limit: 1 })
              ).load(['name', 'kind']);
        if (found === undefined)
          throw new HttpProblem(
            404,
            'unknown-barcode',
            'Unknown barcode',
            `No product has the barcode ${barcode}.`,
          );
        const product = found.id as Id<'product.product'>;
        const [line] = await (
          await env.model('stock.count.line').search({
            where: { count: count.id, product, lot: lot === null ? { isNull: true } : lot },
            limit: 1,
          })
        ).load(['counted', 'expected']);
        const counted = (line?.counted ?? orm.toDecimal(0)).plus(quantity);
        if (line !== undefined) await line.write({ counted });
        else
          await env.model('stock.count.line').create([
            {
              count: count.id,
              product,
              lot,
              expected: await onHandIn(env, product, count.location.id, lot),
              counted,
            },
          ]);
        await env.flush();
        return {
          product: found.name,
          ...(scannedLot === undefined ? {} : { lot: scannedLot.name }),
          counted: counted.toString(),
        };
      },
      { write: true },
    );
  });
}

export const stock: ReturnType<typeof defineModule> = defineModule({
  shutro: stockShutro,
  kosh: '^0.1.0',
  hooks: {
    defaults: async (env) =>
      (env as Env).asSuperuser({ reason: 'main warehouses' }, (su) => mainWarehouses(su)),
    demo: stockDemo,
  },
  // Exceptions to the module standard (RFC 0023), each with its reason.
  standard: {
    waive: [
      {
        rule: 'M3',
        model: 'stock.quant',
        reason: 'Stock levels, written by moves only; a level is never archived.',
      },
    ],
  },
  depends: [product, contacts, messaging, reporting],
  app: {
    code: 'stockroom',
    label: 'Stockroom',
    icon: 'stockroom',
    sequence: 12,
    category: 'Operations',
    summary: 'Warehouses, transfers with one clear status, reservations that say what they are for',
  },
  accessLevels: {
    user: { label: 'User (transfers, stock)', groups: ['stock.user'] },
    manager: {
      label: 'Manager (warehouses, locations, everything)',
      groups: ['stock.manager'],
      implies: ['user'],
    },
  },
  routes: (context: ModuleContext) => registerCountRoutes(context),
  settings: {
    sections: [
      {
        key: 'reservations',
        label: 'Reservations',
        description: 'When transfers hold the stock they take.',
        keywords: 'reserve reservation availability transfer delivery',
        scope: 'installation',
        editors: ['stock.manager'],
        fields: [
          {
            key: 'reserveOnConfirm',
            type: 'boolean',
            label: 'Reserve when a transfer is confirmed',
            default: true,
            help: 'Off: stock is reserved only with Check availability.',
          },
        ],
      },
    ],
  },
  // The Overview (RFC 0022 step 2).
  overview: {
    cards: [
      {
        id: 'receipts_todo',
        title: 'Receipts to do',
        kind: 'kpi',
        model: 'stock.picking',
        measure: 'count',
        filter: { kind: 'receipt', status: { in: ['waiting', 'ready'] } },
        w: 3,
      },
      {
        id: 'deliveries_todo',
        title: 'Deliveries to do',
        kind: 'kpi',
        model: 'stock.picking',
        measure: 'count',
        filter: { kind: 'delivery', status: { in: ['waiting', 'ready'] } },
        w: 3,
      },
      {
        id: 'done_month',
        title: 'Transfers done this month',
        kind: 'kpi',
        model: 'stock.picking',
        measure: 'count',
        filter: { status: 'done' },
        comparison: { field: 'scheduledDate', mode: 'previous' },
        w: 3,
      },
      {
        id: 'reservations',
        title: 'Reservations',
        kind: 'kpi',
        model: 'stock.reservation',
        measure: 'count',
        w: 3,
      },
      {
        id: 'by_status',
        title: 'Transfers by status',
        kind: 'chart',
        model: 'stock.picking',
        measure: 'count',
        groupBy: 'status',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'on_hand_by_location',
        title: 'On hand by location',
        kind: 'chart',
        model: 'stock.quant',
        measure: 'sum:quantity',
        groupBy: 'location',
        filter: { quantity: { gt: 0 } },
        chart: 'bar',
        w: 6,
      },
      {
        id: 'most_stocked',
        title: 'Most stocked products',
        kind: 'pivot',
        model: 'stock.quant',
        measure: 'sum:quantity',
        groupBy: 'product',
        filter: { quantity: { gt: 0 } },
        w: 6,
      },
      {
        id: 'late',
        title: 'Scheduled transfers',
        kind: 'list',
        model: 'stock.picking',
        measure: 'count',
        filter: { status: { in: ['waiting', 'ready'] } },
        w: 6,
      },
    ],
  },
  actions: {
    'stockroom.action_transfers': action(StockPicking, {
      label: 'Transfers',
      views: ['list', 'kanban', 'form'],
      defaults: { kind: 'internal' },
      defaultFilters: ['open'],
    }),
    'stockroom.action_receipts': action(StockPicking, {
      label: 'Receipts',
      views: ['list', 'kanban', 'form'],
      defaults: { kind: 'receipt' },
      defaultFilters: ['receipts', 'open'],
    }),
    'stockroom.action_deliveries': action(StockPicking, {
      label: 'Deliveries',
      views: ['list', 'kanban', 'form'],
      defaults: { kind: 'delivery' },
      defaultFilters: ['deliveries', 'open'],
    }),
    'stockroom.action_stock': action(StockQuant, {
      label: 'Stock',
      views: ['list', 'form'],
      defaultFilters: ['in_stock'],
    }),
    'stockroom.action_reservations': action(StockReservation, {
      label: 'Reservations',
      views: ['list'],
    }),
    'stockroom.action_lots': action(StockLot, {
      label: 'Lots and serial numbers',
      views: ['list', 'form'],
      defaultFilters: ['in_stock'],
    }),
    'stockroom.action_scraps': action(StockScrap, {
      label: 'Scrap',
      views: ['list', 'form'],
    }),
    'stockroom.action_counts': action(StockCount, {
      label: 'Counts',
      views: ['list', 'form'],
      defaultFilters: ['open'],
    }),
    'stockroom.action_warehouses': action(StockWarehouse, {
      label: 'Warehouses',
      views: ['list', 'form'],
    }),
    'stockroom.action_locations': action(StockLocation, {
      label: 'Locations',
      views: ['list', 'form'],
      defaultFilters: ['internal'],
    }),
  },
  menus: [
    { id: 'stockroom.root', label: 'Stockroom', app: 'stockroom' },
    {
      id: 'stockroom.transfers',
      parent: 'stockroom.root',
      label: 'Transfers',
      action: 'stockroom.action_transfers',
      sequence: 1,
    },
    {
      id: 'stockroom.receipts',
      parent: 'stockroom.root',
      label: 'Receipts',
      action: 'stockroom.action_receipts',
      sequence: 2,
    },
    {
      id: 'stockroom.deliveries',
      parent: 'stockroom.root',
      label: 'Deliveries',
      action: 'stockroom.action_deliveries',
      sequence: 3,
    },
    {
      id: 'stockroom.stock',
      parent: 'stockroom.root',
      label: 'Stock',
      action: 'stockroom.action_stock',
      sequence: 4,
    },
    {
      id: 'stockroom.reservations',
      parent: 'stockroom.root',
      label: 'Reservations',
      action: 'stockroom.action_reservations',
      sequence: 5,
    },
    {
      id: 'stockroom.lots',
      parent: 'stockroom.root',
      label: 'Lots and serial numbers',
      action: 'stockroom.action_lots',
      sequence: 5,
    },
    {
      id: 'stockroom.counts',
      parent: 'stockroom.root',
      label: 'Counts',
      action: 'stockroom.action_counts',
      sequence: 6,
    },
    {
      id: 'stockroom.scraps',
      parent: 'stockroom.root',
      label: 'Scrap',
      action: 'stockroom.action_scraps',
      sequence: 8,
    },
    {
      id: 'stockroom.configuration',
      parent: 'stockroom.root',
      label: 'Configuration',
      sequence: 9,
    },
    {
      id: 'stockroom.warehouses',
      parent: 'stockroom.configuration',
      label: 'Warehouses',
      action: 'stockroom.action_warehouses',
      sequence: 1,
    },
    {
      id: 'stockroom.locations',
      parent: 'stockroom.configuration',
      label: 'Locations',
      action: 'stockroom.action_locations',
      sequence: 2,
    },
  ],
  views: {
    'stock.picking.list': list(StockPicking, {
      columns: [
        'name',
        'kind',
        'partner',
        'source',
        'destination',
        { field: 'scheduledDate', widget: 'daysLeft' },
        'origin',
        { field: 'status', widget: 'badge' },
      ],
      decorations: {
        success: { status: 'done' },
        warning: { status: 'waiting' },
        neutral: { status: 'cancelled' },
      },
    }),
    'stock.picking.kanban': kanban(StockPicking, {
      groupBy: 'status',
      card: {
        title: 'name',
        subtitle: 'partner',
        color: 'kind',
        footer: [{ field: 'scheduledDate', widget: 'daysLeft' }, 'origin'],
        badges: [{ field: 'kind', widget: 'badge' }],
      },
    }),
    'stock.picking.form': form(StockPicking, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('confirm', { primary: true, label: 'Confirm' }),
          k.button('reserve', { label: 'Check availability' }),
          k.button('validate', { primary: true, label: 'Validate' }),
          k.button('unreserve', { label: 'Unreserve' }),
          k.button('cancel', {
            label: 'Cancel',
            confirm: 'Cancel this transfer? Its reservations are released.',
          }),
          k.button('redraft', { label: 'Back to draft' }),
        ],
      },
      sheet: [
        k.group('main', ['kind', 'partner', 'warehouse', 'source', 'destination']),
        k.group('when', [
          'scheduledDate',
          'doneDate',
          'origin',
          'status',
          'availability',
          'backorderOf',
        ]),
        k.lines('moves', [
          'product',
          'name',
          'quantity',
          'uom',
          { field: 'reserved', id: 'move_reserved' },
          { field: 'quantityDone', id: 'move_done' },
          { field: 'restrictLot', id: 'move_restrict_lot' },
        ]),
        k.lines('lotLines', [
          { field: 'product', id: 'lot_line_product' },
          { field: 'lot', id: 'lot_line_lot' },
          { field: 'lotName', id: 'lot_line_name' },
          { field: 'quantity', id: 'lot_line_quantity' },
        ]),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'stock.quant.list': list(StockQuant, {
      columns: ['product', 'location', 'lot', 'quantity', 'reserved', 'available'],
    }),
    'stock.lot.list': list(StockLot, {
      columns: ['name', 'product', 'expiryDate', 'qtyOnHand'],
    }),
    'stock.lot.form': form(StockLot, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'product', 'expiryDate', 'qtyOnHand']),
        k.lines('quants', [
          { field: 'location', id: 'lot_quant_location' },
          { field: 'quantity', id: 'lot_quant_quantity' },
          { field: 'reserved', id: 'lot_quant_reserved' },
        ]),
        k.lines('history', [
          { field: 'picking', id: 'lot_history_picking' },
          { field: 'quantity', id: 'lot_history_quantity' },
        ]),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'stock.lot.line.list': list(StockLotLine, {
      columns: ['picking', 'product', 'lot', 'lotName', 'quantity'],
    }),
    'stock.quant.form': form(StockQuant, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['product', 'location', 'lot']),
        k.group('quantities', ['quantity', 'reserved', 'available']),
        k.lines('reservations', [{ field: 'label', id: 'reservation_label' }]),
      ],
    })),
    'stock.reservation.list': list(StockReservation, {
      columns: ['label', 'quant', 'quantity', 'move'],
    }),
    'stock.scrap.list': list(StockScrap, {
      columns: [
        'name',
        'date',
        'product',
        'quantity',
        'reason',
        { field: 'state', widget: 'badge' },
      ],
    }),
    'stock.scrap.form': form(StockScrap, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('validate', {
            primary: true,
            label: 'Scrap',
            confirm: 'Scrap it? The stock leaves for the Scrap location.',
          }),
          k.button('cancel', { label: 'Cancel' }),
        ],
      },
      sheet: [
        k.group('main', ['product', 'quantity', 'location', 'lot']),
        k.group('why', ['reason', 'date', 'picking']),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'stock.count.list': list(StockCount, {
      columns: ['name', 'location', 'date', 'user', { field: 'state', widget: 'badge' }],
    }),
    'stock.count.form': form(StockCount, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('start', { primary: true, label: 'Start counting' }),
          k.button('apply', {
            primary: true,
            label: 'Apply',
            confirm: 'Apply this count? Stock is adjusted to what was counted.',
          }),
          k.button('cancel', { label: 'Cancel' }),
          k.button('redraft', { label: 'Back to draft' }),
        ],
      },
      sheet: [
        k.group('main', ['location', 'date', 'user']),
        k.component('scan', 'stock.Scan'),
        k.lines('lines', [
          { field: 'product', id: 'count_product' },
          { field: 'lot', id: 'count_lot' },
          { field: 'expected', id: 'count_expected' },
          { field: 'counted', id: 'count_counted' },
          { field: 'difference', id: 'count_difference' },
        ]),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'stock.count.line.list': list(StockCountLine, {
      columns: ['count', 'product', 'expected', 'counted', 'difference'],
    }),
    'stock.warehouse.list': list(StockWarehouse, { columns: ['name', 'code', 'address'] }),
    'stock.warehouse.form': form(StockWarehouse, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'code', 'address']),
        k.lines('locations', [
          { field: 'name', id: 'location_name' },
          { field: 'usage', id: 'location_usage' },
          { field: 'parent', id: 'location_parent' },
        ]),
      ],
    })),
    'stock.location.list': list(StockLocation, {
      columns: ['fullName', 'usage', 'warehouse'],
    }),
    'stock.location.form': form(StockLocation, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'parent', 'warehouse', 'usage', 'fullName'])],
    })),
    'stock.move.list': list(StockMove, {
      columns: ['picking', 'product', 'quantity', 'uom', 'reserved'],
    }),
  },
  search: {
    'stock.picking': search(StockPicking, {
      fields: ['name', 'origin', 'partner.name', 'moves.product.name'],
      filters: {
        open: {
          label: 'To do',
          domain: { state: { in: ['draft', 'confirmed'] } },
          group: 'state',
        },
        ready: { label: 'Ready', domain: { status: 'ready' }, group: 'state' },
        waiting: { label: 'Waiting', domain: { status: 'waiting' }, group: 'state' },
        done: { label: 'Done', domain: { state: 'done' }, group: 'state' },
        receipts: { label: 'Receipts', domain: { kind: 'receipt' }, group: 'kind' },
        deliveries: { label: 'Deliveries', domain: { kind: 'delivery' }, group: 'kind' },
        internal: { label: 'Internal moves', domain: { kind: 'internal' }, group: 'kind' },
      },
      groupBy: ['kind', 'status', 'partner', 'scheduledDate'],
    }),
    'stock.quant': search(StockQuant, {
      fields: ['product.name', 'location.fullName'],
      filters: {
        in_stock: { label: 'In stock', domain: { quantity: { gt: 0 } } },
        reserved: { label: 'Reserved', domain: { reserved: { gt: 0 } } },
      },
      groupBy: ['product', 'location'],
    }),
    'stock.reservation': search(StockReservation, {
      fields: ['label', 'quant.product.name'],
      groupBy: ['quant'],
    }),
    'stock.warehouse': search(StockWarehouse, { fields: ['name', 'code'] }),
    'stock.count': search(StockCount, {
      fields: ['name', 'location.fullName'],
      filters: {
        open: { label: 'To do', domain: { state: { in: ['draft', 'counting'] } } },
        applied: { label: 'Applied', domain: { state: 'done' } },
      },
      groupBy: ['location', 'user'],
    }),
    'stock.scrap': search(StockScrap, {
      fields: ['name', 'product.name'],
      groupBy: ['reason', 'product', 'date'],
    }),
    'stock.count.line': search(StockCountLine, { fields: ['product.name', 'count.name'] }),
    'stock.lot': search(StockLot, {
      fields: ['name', 'product.name'],
      filters: {
        in_stock: { label: 'In stock', domain: { qtyOnHand: { gt: 0 } } },
      },
      groupBy: ['product', 'expiryDate'],
    }),
    'stock.lot.line': search(StockLotLine, {
      fields: ['lot.name', 'product.name', 'picking.name'],
    }),
    'stock.location': search(StockLocation, {
      fields: ['fullName'],
      filters: { internal: { label: 'Internal', domain: { usage: 'internal' } } },
      groupBy: ['warehouse', 'usage'],
    }),
    'stock.move': search(StockMove, { fields: ['product.name', 'picking.name'] }),
  },
  // Products show what they have in stock, where, and what is reserved.
  viewExtensions: [
    {
      view: 'product.product.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'product_on_hand',
              label: 'On hand',
              model: 'stock.quant',
              where: { product: { $record: 'id' }, 'location.usage': 'internal' },
              measure: { sum: 'quantity' },
              action: 'stockroom.action_stock',
            }),
          ],
        },
      ],
    },
    {
      view: 'product.product.form',
      operations: [
        {
          insertAfter: 'prices',
          nodes: [
            {
              kind: 'group',
              id: 'stock_quantities',
              label: 'Stock',
              children: [
                field({ field: 'tracking', id: 'stock_tracking' }),
                field({ field: 'qtyOnHand', id: 'stock_on_hand' }),
                field({ field: 'qtyReserved', id: 'stock_reserved' }),
                field({ field: 'qtyAvailable', id: 'stock_available' }),
              ],
            },
          ],
        },
      ],
    },
    {
      view: 'product.product.list',
      operations: [
        {
          insertAfter: 'listPrice',
          nodes: [field({ field: 'qtyAvailable', id: 'stock_list_available' })],
        },
      ],
    },
  ],
});
