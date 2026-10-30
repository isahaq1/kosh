/**
 * @packageDocumentation
 * `@kosh/purchase_stock_account`: the bridge between Purchase, Stockroom and Accounting (RFC 0021 step 3). Proposed
 * whenever the three apps are installed. Receipts from purchase orders are valued at the order's price; vendor bills
 * for goods meet them in Goods received not billed; what differs goes to Price differences.
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { purchase } from '@kosh/purchase';
import { purchaseAccount } from '@kosh/purchase_account';
import { purchaseStock } from '@kosh/purchase_stock';
import { stock } from '@kosh/stock';
import { stockAccount } from '@kosh/stock_account';
import { purchaseStockAccountShutro } from './module.js';

export { BillGoods, MoveOrderCost, purchaseStockAccountShutro } from './module.js';

export const purchaseStockAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: purchaseStockAccountShutro,
  kosh: '^0.1.0',
  depends: [purchase, stock, accounting, purchaseStock, stockAccount, purchaseAccount],
  bridge: [purchase, stock, accounting],
  accessLevels: {
    user: { label: 'Purchases valued in stock', groups: ['purchase_stock_account.user'] },
  },
});
