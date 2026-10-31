/**
 * The data layer of the Trade Finance ↔ Purchase bridge (RFC 0021, Trade Finance step 3): an import LC opened for a purchase order takes its vendor, currency and amount; the order lists its LCs.
 */
import { purchaseShutro } from '@kosh/purchase';
import { orm } from '@kosh/server/orm';
import { tradeFinanceShutro } from '@kosh/trade_finance';
import { defineModule, extendModel, f, onchange } from './.kosh/bindings.js';

export const LcPurchase = extendModel('trade.lc', {
  fields: {
    purchaseOrder: f.many2one('purchase.order', { ondelete: 'set null', label: 'Purchase order' }),
  },
  onchange: {
    // The order's counterparty, currency and total; the LC's direction and source document.
    purchaseOrder: onchange('trade.lc', async (d) => {
      const order = await d.record('purchaseOrder');
      if (order === null || order === undefined) return;
      d.set('direction', 'import');
      d.set('partner', order.partner.id);
      d.set('currency', order.currency.id);
      d.set('amount', order.amountTotal?.amount.toString() ?? null);
      d.set('origin', order.name);
    }),
  },
});

export const PurchaseLcs = extendModel('purchase.order', {
  fields: {
    lcs: f.one2many('trade.lc', 'purchaseOrder', { label: 'Letters of credit' }),
  },
});

export const tradeFinancePurchaseShutro = defineModule({
  name: 'trade_finance_purchase',
  version: '0.1.0',
  depends: [tradeFinanceShutro, purchaseShutro],
  groups: [
    orm.defineGroup({
      code: 'trade_finance_purchase.user',
      label: 'Import LCs from purchase orders',
      implies: ['trade_finance.user', 'purchase.user'],
    }),
  ],
  models: [],
  extensions: [LcPurchase, PurchaseLcs],
});
