/**
 * The data layer of the Counter ↔ Stockroom bridge (RFC 0021, Counter step 2): a closed session's sold goods leave
 * the shop's warehouse as **one delivery per session**, done at once when the stock is there; when it is short the
 * delivery stays confirmed for a manager to finish from Stockroom. Returns (negative quantities) come back in it.
 */
import { posShutro } from '@kosh/pos';
import { type Id, orm } from '@kosh/server/orm';
import { defaultLocations, stockShutro } from '@kosh/stock';
import { defineModule, type Env, extendModel, f, type Records } from './.kosh/bindings.js';

const ZERO = orm.toDecimal(0);

export const ShopWarehouse = extendModel('pos.shop', {
  fields: {
    /** The warehouse the shop sells from; the company's first one otherwise. */
    warehouse: f.many2one('stock.warehouse', { ondelete: 'restrict' }),
  },
});

export const SessionDelivery = extendModel('pos.session', {
  fields: {
    delivery: f.many2one('stock.picking', { ondelete: 'set null', label: 'Stock delivery' }),
  },
  overrides: {
    closed: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const sessions = this as Records<'pos.session'>;
      const env = sessions.env as unknown as Env;
      await env.asSuperuser({ reason: 'counter session to stock' }, async (su) => {
        for (const s of await su
          .model('pos.session')
          .browse(sessions.ids)
          .load({ shop: true, company: true, orders: { lines: { product: { uom: true } } } })) {
          if (s.delivery !== null) continue;
          // What left the shelves: the paid sales' goods, by product (returns take away).
          const sold = new Map<
            number,
            {
              product: Id<'product.product'>;
              name: string;
              uom: number | null;
              quantity: ReturnType<typeof orm.toDecimal>;
            }
          >();
          for (const o of s.orders) {
            if (o.state !== 'paid') continue;
            for (const l of o.lines) {
              if (l.product.kind !== 'goods') continue;
              const slot = sold.get(l.product.id) ?? {
                product: l.product.id,
                name: l.product.name,
                uom: l.product.uom?.id ?? null,
                quantity: ZERO,
              };
              slot.quantity = slot.quantity.plus(l.quantity);
              sold.set(l.product.id, slot);
            }
          }
          const moves = [...sold.values()].filter((m) => m.quantity.gt(0));
          if (moves.length === 0) continue;
          const shopWarehouse = (
            s.shop as unknown as { warehouse?: { id: Id<'stock.warehouse'> } | null }
          ).warehouse;
          const places = await defaultLocations(
            su as never,
            'delivery',
            shopWarehouse?.id ?? null,
            s.company.id,
          );
          if (places.source === null || places.destination === null)
            throw new orm.ValidationError(
              'pos.session',
              ['state'],
              `The company of ${s.name} has no warehouse to sell from.`,
              'Add a warehouse in Stockroom › Configuration › Warehouses.',
            );
          const made = await su.model('stock.picking').create([
            {
              kind: 'delivery',
              company: s.company.id,
              warehouse: places.warehouse,
              source: places.source,
              destination: places.destination,
              origin: s.name,
              moves: {
                create: moves.map((m) => ({
                  product: m.product,
                  name: m.name,
                  quantity: m.quantity,
                  quantityDone: m.quantity,
                  uom: m.uom,
                })),
              },
            },
          ] as never);
          await su.flush();
          await made.confirm();
          await su.flush();
          await made.reserve();
          await su.flush();
          // Done at once when the stock is there; else it waits for a manager in Stockroom.
          try {
            await made.validate();
            await su.flush();
          } catch (error) {
            const name = (error as { name?: string }).name;
            // Short stock: the guard of validate refuses; the delivery stays confirmed for Stockroom.
            if (!(error instanceof orm.ValidationError || name === 'TransitionGuardError'))
              throw error;
          }
          await su
            .model('pos.session')
            .browse([s.id])
            .write({ delivery: made.ids[0] ?? null } as never);
        }
      });
    },
  },
});

export const posStockShutro = defineModule({
  name: 'pos_stock',
  version: '0.1.0',
  depends: [posShutro, stockShutro],
  groups: [
    orm.defineGroup({
      code: 'pos_stock.user',
      label: 'Counter sales from stock',
      implies: ['pos.cashier'],
    }),
  ],
  models: [],
  extensions: [ShopWarehouse, SessionDelivery],
});
