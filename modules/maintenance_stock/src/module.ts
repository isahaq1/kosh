/**
 * The data layer of the Asset Care ↔ Stockroom bridge (RFC 0021, Asset Care step 2): a maintenance order lists the
 * spare parts it uses; starting it reserves them in a transfer from the main stock to the Maintenance location,
 * finishing it consumes them (refused while some are short), cancelling it releases them. Parts cost what they cost
 * in stock; with `stock_account` they leave Inventory as a stock adjustment.
 */
import { maintenanceShutro } from '@kosh/maintenance';
import { productShutro } from '@kosh/product';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import { defaultLocations, inProductUnit, stockShutro } from '@kosh/stock';
import {
  compute,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  onchange,
  type Records,
  record,
} from './.kosh/bindings.js';

const zero = orm.toDecimal(0);

export const MaintenancePart = defineModel('maintenance.request.part', {
  label: 'Spare part',
  order: ['id asc'],
  access: {
    'maintenance.user': ['read', 'write', 'create', 'unlink'],
    'maintenance.manager': ['read', 'write', 'create', 'unlink', 'export'],
  },
  fields: {
    request: f.many2one('maintenance.request', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    quantity: f.decimal({ scale: 4, required: true, default: '1' }),
    uom: f.many2one('uom.uom', { label: 'Unit' }),
    /** The quantity at the product's cost (in the product's unit). */
    cost: f.decimal({
      scale: 2,
      store: true,
      label: 'Cost',
      ...compute(
        'maintenance.request.part',
        'cost',
        [
          'quantity',
          'uom.ratio',
          'uom.category',
          'uom.name',
          'uom.rounding',
          'product.standardPrice',
          'product.uom.ratio',
          'product.uom.category',
          'product.uom.name',
          'product.uom.rounding',
        ],
        (parts) => {
          for (const p of parts)
            p.cost = inProductUnit(p.quantity, p.uom ?? null, p.product.uom ?? null)
              .times(p.product.standardPrice)
              .toDecimalPlaces(2);
        },
      ),
    }),
  },
  onchange: {
    product: onchange('maintenance.request.part', async (d) => {
      const p = await d.record('product');
      if (p?.uom) d.set('uom', p.uom.id);
    }),
  },
  sqlConstraints: {
    positive: { check: orm.sql`quantity > 0`, message: 'A part is used in a positive quantity.' },
  },
});

export const RequestParts = extendModel('maintenance.request', {
  fields: {
    parts: f.one2many('maintenance.request.part', 'request', { label: 'Spare parts' }),
    partsTransfer: f.many2one('stock.picking', { ondelete: 'set null', label: 'Parts transfer' }),
    partsCost: f.decimal({
      scale: 2,
      store: true,
      label: 'Parts cost',
      ...compute('maintenance.request', 'partsCost', ['parts.cost'], (requests) => {
        for (const r of requests)
          r.partsCost = [...r.parts].reduce((s, p) => s.plus(p.cost ?? zero), zero);
      }),
    }),
  },
  overrides: {
    started: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      await reserveParts(this as Records<'maintenance.request'>);
    },
    finishing: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      await consumeParts(this as Records<'maintenance.request'>);
    },
    cancelled: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      await releaseParts(this as Records<'maintenance.request'>);
    },
  },
});

/** The orders' parts transfers (made when missing), reserved; as the system (technicians need no stock rights). */
async function reserveParts(requests: Records<'maintenance.request'>): Promise<void> {
  const env = requests.env as unknown as Env;
  await env.asSuperuser({ reason: 'maintenance parts' }, async (su) => {
    const maintenance = (
      await su
        .model('stock.location')
        .search({ where: { usage: 'adjustment', name: 'Maintenance' }, limit: 1 })
    ).ids[0];
    if (maintenance === undefined) return;
    for (const r of await su
      .model('maintenance.request')
      .browse(requests.ids)
      .load({ parts: true, partsTransfer: true })) {
      if (r.parts.length === 0) continue;
      const transfer = r.partsTransfer;
      if (transfer === null || transfer.state === 'cancel') {
        const from = (await defaultLocations(su as never, 'internal', null, r.company.id)).source;
        if (from === null) continue;
        const made = await su.model('stock.picking').create([
          {
            kind: 'adjustment',
            company: r.company.id,
            source: from,
            destination: maintenance,
            origin: r.name,
            moves: {
              create: [...r.parts].map((p) => ({
                product: p.product.id,
                quantity: p.quantity,
                uom: p.uom?.id ?? null,
              })),
            },
          },
        ]);
        await made.confirm();
        await su
          .model('maintenance.request')
          .browse([r.id])
          .write({ partsTransfer: made.ids[0] ?? null });
        continue;
      }
      if (transfer.state === 'confirmed')
        await su.model('stock.picking').browse([transfer.id]).reserve();
    }
  });
}

/** The parts consumed: their transfer validated, refused while some are short. */
async function consumeParts(requests: Records<'maintenance.request'>): Promise<void> {
  await reserveParts(requests);
  const env = requests.env as unknown as Env;
  await env.asSuperuser({ reason: 'maintenance parts used' }, async (su) => {
    for (const r of await su
      .model('maintenance.request')
      .browse(requests.ids)
      .load({ partsTransfer: { moves: { product: true } } })) {
      const t = r.partsTransfer;
      if (t === null || t.state === 'done' || t.state === 'cancel') continue;
      if (t.availability !== 'full') {
        const short = [...t.moves]
          .filter((m) => (m.reserved ?? zero).lt(m.productQty ?? zero))
          .map(
            (m) =>
              `${m.product.name} (${(m.productQty ?? zero).minus(m.reserved ?? zero).toString()})`,
          );
        throw new orm.ValidationError(
          'maintenance.request',
          ['parts'],
          `Parts are short: ${short.join(', ')}.`,
          'Wait for them to come in, or use fewer.',
        );
      }
      await su.model('stock.picking').browse([t.id]).validate();
    }
  });
}

/** The parts released: their transfer cancelled. */
async function releaseParts(requests: Records<'maintenance.request'>): Promise<void> {
  const env = requests.env as unknown as Env;
  await env.asSuperuser({ reason: 'maintenance parts released' }, async (su) => {
    for (const r of await su
      .model('maintenance.request')
      .browse(requests.ids)
      .load({ partsTransfer: true })) {
      const t = r.partsTransfer;
      if (t !== null && (t.state === 'draft' || t.state === 'confirmed'))
        await su
          .model('stock.picking')
          .browse([t.id as Id<'stock.picking'>])
          .cancel();
    }
  });
}

export const maintenanceStockShutro = defineModule({
  name: 'maintenance_stock',
  version: '0.1.0',
  depends: [maintenanceShutro, stockShutro, productShutro],
  groups: [
    orm.defineGroup({
      code: 'maintenance_stock.user',
      label: 'Maintenance with spare parts',
      implies: ['maintenance.user', 'product.user'],
    }),
  ],
  models: [MaintenancePart],
  extensions: [RequestParts],
  data: [
    record(
      'stock.location',
      'location_maintenance',
      { name: 'Maintenance', usage: 'adjustment', company: null },
      { noupdate: true },
    ),
  ],
});

export type { Decimal };
