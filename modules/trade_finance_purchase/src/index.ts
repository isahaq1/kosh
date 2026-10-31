/**
 * @packageDocumentation
 * `@kosh/trade_finance_purchase`: the bridge between Trade Finance and Purchase (RFC 0021, Trade Finance step 3). Proposed whenever
 * both apps are installed: an import LC opened for a purchase order takes its vendor, currency and amount; the order lists its LCs.
 */
import { defineModule } from '@kosh/modules-sdk';
import { purchase } from '@kosh/purchase';
import { tradeFinance } from '@kosh/trade_finance';
import { field } from '@kosh/views';
import { tradeFinancePurchaseShutro } from './module.js';

export { LcPurchase, PurchaseLcs, tradeFinancePurchaseShutro } from './module.js';

export const tradeFinancePurchase: ReturnType<typeof defineModule> = defineModule({
  shutro: tradeFinancePurchaseShutro,
  kosh: '^0.1.0',
  depends: [tradeFinance, purchase],
  bridge: [tradeFinance, purchase],
  accessLevels: {
    user: { label: 'Import LCs from purchase orders', groups: ['trade_finance_purchase.user'] },
  },
  viewExtensions: [
    {
      view: 'trade.lc.form',
      operations: [
        { append: 'parties', nodes: [field({ field: 'purchaseOrder', id: 'lc_purchaseOrder' })] },
      ],
    },
    {
      view: 'purchase.order.form',
      operations: [
        {
          insertAfter: 'lines',
          nodes: [
            {
              kind: 'lines',
              id: 'lcs',
              field: 'lcs',
              columns: [
                field({ field: 'name', id: 'order_lc_name' }),
                field({ field: 'bankReference', id: 'order_lc_reference' }),
                field({ field: 'amount', id: 'order_lc_amount' }),
                field({ field: 'expiryDate', id: 'order_lc_expiry' }),
                field({ field: 'state', id: 'order_lc_state' }),
              ],
            },
          ],
        },
      ],
    },
  ],
});
