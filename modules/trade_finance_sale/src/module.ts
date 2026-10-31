/**
 * The data layer of the Trade Finance ↔ Sales bridge (RFC 0021, Trade Finance step 3): an export LC received for a sales order takes its customer, currency and amount; the order lists its LCs.
 */
import { salesShutro } from '@kosh/sales';
import { orm } from '@kosh/server/orm';
import { tradeFinanceShutro } from '@kosh/trade_finance';
import { defineModule, extendModel, f, onchange } from './.kosh/bindings.js';

export const LcSale = extendModel('trade.lc', {
  fields: {
    saleOrder: f.many2one('sale.order', { ondelete: 'set null', label: 'Sales order' }),
  },
  onchange: {
    // The order's counterparty, currency and total; the LC's direction and source document.
    saleOrder: onchange('trade.lc', async (d) => {
      const order = await d.record('saleOrder');
      if (order === null || order === undefined) return;
      d.set('direction', 'export');
      d.set('partner', order.partner.id);
      d.set('currency', order.currency.id);
      d.set('amount', order.amountTotal?.amount.toString() ?? null);
      d.set('origin', order.name);
    }),
  },
});

export const SaleLcs = extendModel('sale.order', {
  fields: {
    lcs: f.one2many('trade.lc', 'saleOrder', { label: 'Letters of credit' }),
  },
});

export const tradeFinanceSaleShutro = defineModule({
  name: 'trade_finance_sale',
  version: '0.1.0',
  depends: [tradeFinanceShutro, salesShutro],
  groups: [
    orm.defineGroup({
      code: 'trade_finance_sale.user',
      label: 'Export LCs for sales orders',
      implies: ['trade_finance.user', 'sales.user'],
    }),
  ],
  models: [],
  extensions: [LcSale, SaleLcs],
});
