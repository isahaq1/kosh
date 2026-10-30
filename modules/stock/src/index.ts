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
import { action, field, form, kanban, list, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { stockDemo } from './demo.js';
import {
  StockLocation,
  StockMove,
  StockPicking,
  StockQuant,
  StockReservation,
  StockWarehouse,
  stockShutro,
} from './module.js';

export {
  defaultLocations,
  inProductUnit,
  ProductStock,
  reserveOnConfirm,
  StockLocation,
  StockMove,
  StockPicking,
  StockQuant,
  StockReservation,
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

export const stock: ReturnType<typeof defineModule> = defineModule({
  shutro: stockShutro,
  kosh: '^0.1.0',
  hooks: {
    defaults: async (env) =>
      (env as Env).asSuperuser({ reason: 'main warehouses' }, (su) => mainWarehouses(su)),
    demo: stockDemo,
  },
  depends: [product, contacts, messaging],
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
        'scheduledDate',
        'origin',
        { field: 'status', widget: 'badge' },
      ],
    }),
    'stock.picking.kanban': kanban(StockPicking, {
      groupBy: 'status',
      card: {
        title: 'name',
        subtitle: 'partner',
        footer: ['scheduledDate', 'origin'],
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
        k.group('when', ['scheduledDate', 'doneDate', 'origin', 'status', 'availability']),
        k.lines('moves', [
          'product',
          'name',
          'quantity',
          'uom',
          { field: 'reserved', id: 'move_reserved' },
        ]),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'stock.quant.list': list(StockQuant, {
      columns: ['product', 'location', 'quantity', 'reserved', 'available'],
    }),
    'stock.quant.form': form(StockQuant, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['product', 'location']),
        k.group('quantities', ['quantity', 'reserved', 'available']),
        k.lines('reservations', [{ field: 'label', id: 'reservation_label' }]),
      ],
    })),
    'stock.reservation.list': list(StockReservation, {
      columns: ['label', 'quant', 'quantity', 'move'],
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
          insertAfter: 'prices',
          nodes: [
            {
              kind: 'group',
              id: 'stock_quantities',
              label: 'Stock',
              children: [
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
