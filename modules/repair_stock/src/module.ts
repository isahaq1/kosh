/**
 * The data layer of the Repairs ↔ Stockroom bridge (RFC 0038 step 4): the **parts** of a repair order come from
 * stock. Starting the repair reserves them in a transfer from the main stock to the Repairs location; marking
 * the item repaired consumes them — refused while some are short —; cancelling the order releases them. Labour
 * moves nothing.
 */
import { productShutro } from '@kosh/product';
import { repairShutro } from '@kosh/repair';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import { defaultLocations, stockShutro } from '@kosh/stock';
import { defineModule, type Env, extendModel, f, type Records, record } from './.kosh/bindings.js';

const zero: Decimal = orm.toDecimal(0);
/** Fields the server maintains: written by its own code and by Administrators only. */
const SYSTEM = ['base.admin'] as const;

/** The orders' parts transfers (made when missing), reserved; as the system (technicians need no stock rights). */
async function reserveParts(orders: Records<'repair.order'>): Promise<void> {
  const env = orders.env as unknown as Env;
  await env.asSuperuser({ reason: 'repair parts' }, async (su) => {
    const repairs = (
      await su
        .model('stock.location')
        .search({ where: { usage: 'adjustment', name: 'Repairs' }, limit: 1 })
    ).ids[0];
    if (repairs === undefined) return;
    for (const o of await su
      .model('repair.order')
      .browse(orders.ids)
      .load({ lines: true, partsTransfer: true, company: true })) {
      const parts = [...o.lines].filter((l) => l.kind === 'part' && l.product !== null);
      if (parts.length === 0) continue;
      const transfer = o.partsTransfer;
      if (transfer === null || transfer.state === 'cancel') {
        const from = (await defaultLocations(su as never, 'internal', null, o.company.id)).source;
        if (from === null) continue;
        const made = await su.model('stock.picking').create([
          {
            kind: 'adjustment',
            company: o.company.id,
            source: from,
            destination: repairs,
            origin: o.name,
            moves: {
              create: parts.map((p) => ({
                product: p.product?.id,
                quantity: p.quantity,
              })),
            },
          },
        ] as never);
        await made.confirm();
        await su
          .model('repair.order')
          .browse([o.id])
          .write({ partsTransfer: made.ids[0] ?? null } as never);
        continue;
      }
      if (transfer.state === 'confirmed')
        await su.model('stock.picking').browse([transfer.id]).reserve();
    }
  });
}

/** The parts consumed: their transfer validated, refused while some are short. */
async function consumeParts(orders: Records<'repair.order'>): Promise<void> {
  await reserveParts(orders);
  const env = orders.env as unknown as Env;
  await env.asSuperuser({ reason: 'repair parts used' }, async (su) => {
    for (const o of await su
      .model('repair.order')
      .browse(orders.ids)
      .load({ partsTransfer: { moves: { product: true } } })) {
      const t = o.partsTransfer;
      if (t === null || t.state === 'done' || t.state === 'cancel') continue;
      if (t.availability !== 'full') {
        const short = [...t.moves]
          .filter((m) => (m.reserved ?? zero).lt(m.productQty ?? zero))
          .map(
            (m) =>
              `${m.product.name} (${(m.productQty ?? zero).minus(m.reserved ?? zero).toString()})`,
          );
        throw new orm.ValidationError(
          'repair.order',
          ['lines'],
          `Parts are short: ${short.join(', ')}.`,
          'Wait for them to come in, or take them off the order.',
        );
      }
      await su.model('stock.picking').browse([t.id]).validate();
    }
  });
}

/** The parts released: their transfer cancelled. */
async function releaseParts(orders: Records<'repair.order'>): Promise<void> {
  const env = orders.env as unknown as Env;
  await env.asSuperuser({ reason: 'repair parts released' }, async (su) => {
    for (const o of await su
      .model('repair.order')
      .browse(orders.ids)
      .load({ partsTransfer: true })) {
      const t = o.partsTransfer;
      if (t !== null && (t.state === 'draft' || t.state === 'confirmed'))
        await su
          .model('stock.picking')
          .browse([t.id as Id<'stock.picking'>])
          .cancel();
    }
  });
}

export const OrderParts = extendModel('repair.order', {
  fields: {
    partsTransfer: f.many2one('stock.picking', {
      ondelete: 'set null',
      label: 'Parts transfer',
      groups: { write: [...SYSTEM] },
      help: 'The transfer that takes the parts out of stock: reserved when the repair starts, done when the item is repaired.',
    }),
  },
  overrides: {
    started: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      await reserveParts(this as Records<'repair.order'>);
    },
    finishing: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      await consumeParts(this as Records<'repair.order'>);
    },
    cancelled: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      await releaseParts(this as Records<'repair.order'>);
    },
  },
});

export const repairStockShutro = defineModule({
  name: 'repair_stock',
  version: '0.1.0',
  depends: [repairShutro, stockShutro, productShutro],
  groups: [
    orm.defineGroup({
      code: 'repair_stock.user',
      label: 'Repairs with parts from stock',
      implies: ['repair.user'],
    }),
  ],
  models: [],
  extensions: [OrderParts],
  data: [
    record(
      'stock.location',
      'location_repairs',
      { name: 'Repairs', usage: 'adjustment', company: null },
      { noupdate: true },
    ),
  ],
});
