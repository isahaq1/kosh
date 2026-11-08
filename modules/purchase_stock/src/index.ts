/**
 * @packageDocumentation
 * `@kosh/purchase_stock`: the bridge between Purchase and Stockroom (RFC 0021). Proposed whenever both apps are
 * installed. Confirming a purchase order makes its receipt through the outbox (`purchase.order.confirmed`): exactly
 * once, after the confirmation committed. The order shows what is received.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { purchase } from '@kosh/purchase';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import type { Worker } from '@kosh/server/orm';
import { stock } from '@kosh/stock';
import { field, stat } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { createReceiptFor, purchaseStockShutro } from './module.js';
import { vendorScorecard } from './scorecard.js';

export {
  createReceiptFor,
  LineReceived,
  MovePurchase,
  OrderReceipts,
  PickingPurchase,
  purchaseStockShutro,
  ReorderBuy,
} from './module.js';

/** The subscriber that makes the receipts of confirmed orders; tests `drain()` it, the server starts it. */
export function purchaseStockWorker(context: Pick<ModuleContext, 'shutro'>): Worker {
  return context.shutro.subscribe(
    'purchase_stock.receipts',
    'purchase.order.confirmed',
    async (event, env) => {
      const payload = (event.payload ?? {}) as { id?: unknown };
      const id = Number(payload.id);
      if (Number.isInteger(id) && id > 0) await createReceiptFor(env as Env, id);
    },
    { pollMs: 5000 },
  );
}

/** The demo's confirmed orders get their receipts now (the subscriber would, once the server runs). */
async function purchaseStockDemo(ctx: DemoContext): Promise<string> {
  const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['purchase_stock.user'] } as const;
  const made = await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const orders = await env
      .model('purchase.order')
      .search({ where: { state: { in: ['purchase', 'done'] } } });
    let count = 0;
    for (const id of orders.ids) if ((await createReceiptFor(env, id)) !== null) count += 1;
    return count;
  });
  return `Purchase ↔ Stockroom: ${made} receipts for the confirmed orders.`;
}

export const purchaseStock: ReturnType<typeof defineModule> = defineModule({
  shutro: purchaseStockShutro,
  kosh: '^0.1.0',
  hooks: { demo: purchaseStockDemo },
  depends: [purchase, stock, product],
  bridge: [purchase, stock],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Purchase with receipts', groups: ['purchase_stock.user'] },
  },
  viewExtensions: [
    // The vendor's scorecard on their contact (RFC 0030 §3.1).
    {
      view: 'res.partner.form',
      operations: [
        {
          insertAfter: 'related',
          nodes: [
            { kind: 'component', id: 'vendor_scorecard', component: 'purchase_stock.Scorecard' },
          ],
        },
      ],
    },
    {
      view: 'purchase.order.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'order_receipts',
              label: 'Receipts',
              model: 'stock.picking',
              where: { purchaseOrder: { $record: 'id' } },
              action: 'stockroom.action_receipts',
            }),
          ],
        },
      ],
    },
    {
      view: 'purchase.order.form',
      operations: [
        {
          append: 'dates',
          nodes: [
            field({ field: 'receiptState', id: 'receipt_state' }),
            field({ field: 'warehouse', id: 'order_deliver_to' }),
            field({ field: 'dropship', id: 'order_dropship' }),
          ],
        },
      ],
    },
    {
      view: 'purchase.order.list',
      operations: [
        {
          insertAfter: 'state',
          nodes: [field({ field: 'receiptState', id: 'receipt_state_list', widget: 'badge' })],
        },
      ],
    },
    {
      view: 'stock.picking.form',
      operations: [
        { append: 'when', nodes: [field({ field: 'purchaseOrder', id: 'purchase_order' })] },
      ],
    },
  ],
  routes: (context: ModuleContext) => {
    // A vendor's scorecard (RFC 0030 §3.1), as the caller.
    context.app.get('/api/v1/purchase/vendors/:id/scorecard', async (request) => {
      const id = Number((request.params as { id?: unknown }).id);
      if (!Number.isSafeInteger(id) || id <= 0)
        throw new HttpProblem(400, 'invalid-path', 'Invalid vendor', 'A vendor id.');
      return request.env((env) => vendorScorecard(env as Env, id));
    });
    if (process.env['KOSH_SCHEDULES'] === 'off') return;
    const worker = purchaseStockWorker(context);
    worker.start();
    context.app.addHook('onClose', async () => {
      await worker.stop();
    });
  },
});
