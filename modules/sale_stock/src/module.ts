/**
 * The data layer of the Sales ↔ Stockroom bridge (RFC 0021): a confirmed sales order gets its delivery — one
 * Stockroom transfer with a line per goods line, in the line's unit, from the company's main warehouse to the
 * customers — made once through the outbox (`sale.order.confirmed`) and confirmed, so its stock is reserved. The
 * order shows its deliveries and what is delivered; each line, its delivered quantity.
 */
import { productShutro } from '@kosh/product';
import { salesShutro } from '@kosh/sales';
import { orm } from '@kosh/server/orm';
import { defaultLocations, stockShutro } from '@kosh/stock';
import { compute, defineModule, type Env, extendModel, f, type Records } from './.kosh/bindings.js';

const zero = orm.toDecimal(0);

export const PickingSale = extendModel('stock.picking', {
  fields: { saleOrder: f.many2one('sale.order', { ondelete: 'set null', label: 'Sales order' }) },
  overrides: {
    // A backorder stays with its order.
    backorderValues: async function (
      this: unknown,
      next: () => Promise<Map<number, Record<string, unknown>>>,
    ): Promise<Map<number, Record<string, unknown>>> {
      const out = await next();
      for (const p of await (this as Records<'stock.picking'>).load({}))
        out.set(p.id, { ...out.get(p.id), saleOrder: p.saleOrder?.id ?? null });
      return out;
    },
  },
});

export const MoveSale = extendModel('stock.move', {
  fields: {
    saleLine: f.many2one('sale.order.line', { ondelete: 'set null', label: 'Order line' }),
  },
  overrides: {
    // The rest of a line stays tied to its order line.
    backorderValues: async function (
      this: unknown,
      next: () => Promise<Map<number, Record<string, unknown>>>,
    ): Promise<Map<number, Record<string, unknown>>> {
      const out = await next();
      for (const m of await (this as Records<'stock.move'>).load({}))
        out.set(m.id, { ...out.get(m.id), saleLine: m.saleLine?.id ?? null });
      return out;
    },
  },
});

export const LineDelivered = extendModel('sale.order.line', {
  fields: {
    moves: f.one2many('stock.move', 'saleLine'),
    /** Delivered by validated deliveries, in the line's unit. */
    qtyDelivered: f.decimal({
      scale: 3,
      store: true,
      label: 'Delivered',
      ...compute(
        'sale.order.line',
        'qtyDelivered',
        ['moves.quantity', 'moves.quantityDone', 'moves.picking.state'],
        (lines) => {
          for (const l of lines)
            l.qtyDelivered = [...l.moves]
              .filter((m) => m.picking.state === 'done')
              .reduce((s, m) => s.plus(m.quantityDone ?? m.quantity), zero);
        },
      ),
    }),
  },
});

export const OrderDeliveries = extendModel('sale.order', {
  fields: {
    deliveries: f.one2many('stock.picking', 'saleOrder'),
    deliveryState: f.selection(
      {
        nothing: 'Nothing to deliver',
        to_deliver: 'To deliver',
        partial: 'Partly delivered',
        delivered: 'Delivered',
      },
      {
        store: true,
        label: 'Delivery',
        ...compute(
          'sale.order',
          'deliveryState',
          ['state', 'lines.quantity', 'lines.qtyDelivered', 'lines.product.kind'],
          (orders) => {
            for (const o of orders) {
              const goods = [...o.lines].filter((l) => l.product.kind === 'goods');
              if (goods.length === 0 || (o.state !== 'sale' && o.state !== 'done')) {
                o.deliveryState = 'nothing';
                continue;
              }
              const done = goods.every((l) => (l.qtyDelivered ?? zero).gte(l.quantity));
              const some = goods.some((l) => (l.qtyDelivered ?? zero).gt(0));
              o.deliveryState = done ? 'delivered' : some ? 'partial' : 'to_deliver';
            }
          },
        ),
      },
    ),
  },
});

/**
 * Makes and confirms the delivery of a confirmed order's goods lines, once (an order with a delivery that is not
 * cancelled gets no other). Runs in an audited superuser scope: the salesperson who confirmed needs no Stockroom
 * rights for the warehouse to get its delivery. Returns the delivery, or null when there is nothing to deliver.
 */
export async function createDeliveryFor(env: Env, orderId: number): Promise<number | null> {
  return env.asSuperuser({ reason: 'delivery for a confirmed sales order' }, async (su) => {
    const [order] = await su
      .model('sale.order')
      .browse([orm.asId(orderId, 'sale.order')])
      .load({
        lines: { product: true, uom: true },
        partner: true,
        company: true,
        deliveries: true,
      });
    if (order === undefined || (order.state !== 'sale' && order.state !== 'done')) return null;
    if ([...order.deliveries].some((d) => d.state !== 'cancel')) return null;
    const goods = order.lines.filter((l) => l.product.kind === 'goods');
    if (goods.length === 0) return null;
    const places = await defaultLocations(su as never, 'delivery', null, order.company.id);
    if (places.source === null || places.destination === null)
      throw new orm.ValidationError(
        'sale.order',
        ['state'],
        `The company of ${order.name} has no warehouse to deliver from.`,
        'Add a warehouse in Stockroom › Configuration › Warehouses.',
      );
    const made = await su.model('stock.picking').create([
      {
        kind: 'delivery',
        partner: order.partner.id,
        company: order.company.id,
        warehouse: places.warehouse,
        source: places.source,
        destination: places.destination,
        origin: order.name,
        saleOrder: order.id,
        moves: {
          create: goods.map((l) => ({
            product: l.product.id,
            name: l.name,
            quantity: l.quantity,
            uom: l.uom?.id ?? null,
            saleLine: l.id,
          })),
        },
      },
    ]);
    await made.confirm();
    return made.ids[0] ?? null;
  });
}

export const saleStockShutro = defineModule({
  name: 'sale_stock',
  version: '0.1.0',
  depends: [salesShutro, stockShutro, productShutro],
  groups: [
    orm.defineGroup({
      code: 'sale_stock.user',
      label: 'Sales with deliveries',
      implies: ['sales.user', 'stock.user'],
    }),
  ],
  models: [],
  extensions: [PickingSale, MoveSale, LineDelivered, OrderDeliveries],
});
