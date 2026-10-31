/**
 * @packageDocumentation
 * `@kosh/trade_finance_sale`: the bridge between Trade Finance and Sales (RFC 0021, Trade Finance step 3). Proposed whenever
 * both apps are installed: an export LC received for a sales order takes its customer, currency and amount; the order lists its LCs.
 */
import { defineModule } from '@kosh/modules-sdk';
import { sales } from '@kosh/sales';
import { tradeFinance } from '@kosh/trade_finance';
import { field } from '@kosh/views';
import { tradeFinanceSaleShutro } from './module.js';

export { LcSale, SaleLcs, tradeFinanceSaleShutro } from './module.js';

export const tradeFinanceSale: ReturnType<typeof defineModule> = defineModule({
  shutro: tradeFinanceSaleShutro,
  kosh: '^0.1.0',
  depends: [tradeFinance, sales],
  bridge: [tradeFinance, sales],
  accessLevels: {
    user: { label: 'Export LCs for sales orders', groups: ['trade_finance_sale.user'] },
  },
  viewExtensions: [
    {
      view: 'trade.lc.form',
      operations: [
        { append: 'parties', nodes: [field({ field: 'saleOrder', id: 'lc_saleOrder' })] },
      ],
    },
    {
      view: 'sale.order.form',
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
