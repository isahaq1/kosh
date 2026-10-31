/**
 * @packageDocumentation
 * `@kosh/sale_stock`: the bridge between Sales and Stockroom (RFC 0021). Proposed whenever both apps are installed.
 * Confirming a sales order makes its delivery through the outbox (`sale.order.confirmed`): exactly once, after the
 * confirmation committed, confirmed so that its stock is reserved. The order shows what is delivered.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { sales } from '@kosh/sales';
import type { ModuleContext } from '@kosh/server';
import type { Worker } from '@kosh/server/orm';
import { stock } from '@kosh/stock';
import { field, stat } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { createDeliveryFor, saleStockShutro } from './module.js';

export {
  createDeliveryFor,
  LineDelivered,
  MoveSale,
  OrderDeliveries,
  PickingSale,
  saleStockShutro,
} from './module.js';

/** The subscriber that makes the deliveries of confirmed orders; tests `drain()` it, the server starts it. */
export function saleStockWorker(context: Pick<ModuleContext, 'shutro'>): Worker {
  return context.shutro.subscribe(
    'sale_stock.deliveries',
    'sale.order.confirmed',
    async (event, env) => {
      const payload = (event.payload ?? {}) as { id?: unknown };
      const id = Number(payload.id);
      if (Number.isInteger(id) && id > 0) await createDeliveryFor(env as Env, id);
    },
    { pollMs: 5000 },
  );
}

/** The demo's confirmed orders get their deliveries now (the subscriber would, once the server runs). */
async function saleStockDemo(ctx: DemoContext): Promise<string> {
  const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['sale_stock.user'] } as const;
  const made = await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const orders = await env
      .model('sale.order')
      .search({ where: { state: { in: ['sale', 'done'] } } });
    let count = 0;
    for (const id of orders.ids) if ((await createDeliveryFor(env, id)) !== null) count += 1;
    return count;
  });
  return `Sales ↔ Stockroom: ${made} deliveries for the confirmed orders.`;
}

export const saleStock: ReturnType<typeof defineModule> = defineModule({
  shutro: saleStockShutro,
  kosh: '^0.1.0',
  hooks: { demo: saleStockDemo },
  depends: [sales, stock, product],
  bridge: [sales, stock],
  accessLevels: {
    user: { label: 'Sales with deliveries', groups: ['sale_stock.user'] },
  },
  viewExtensions: [
    {
      view: 'sale.order.form',
      operations: [
        { append: 'dates', nodes: [field({ field: 'deliveryState', id: 'delivery_state' })] },
        {
          append: 'related',
          nodes: [
            stat({
              id: 'order_deliveries',
              label: 'Deliveries',
              model: 'stock.picking',
              where: { saleOrder: { $record: 'id' } },
              action: 'stockroom.action_deliveries',
            }),
          ],
        },
      ],
    },
    {
      view: 'sale.order.list',
      operations: [
        {
          insertAfter: 'state',
          nodes: [field({ field: 'deliveryState', id: 'delivery_state_list', widget: 'badge' })],
        },
      ],
    },
    {
      view: 'stock.picking.form',
      operations: [{ append: 'when', nodes: [field({ field: 'saleOrder', id: 'sale_order' })] }],
    },
  ],
  routes: (context: ModuleContext) => {
    if (process.env['KOSH_SCHEDULES'] === 'off') return;
    const worker = saleStockWorker(context);
    worker.start();
    context.app.addHook('onClose', async () => {
      await worker.stop();
    });
  },
});
