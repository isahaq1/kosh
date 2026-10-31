/**
 * @packageDocumentation
 * `@kosh/pos_stock`: the bridge between Counter and Stockroom (RFC 0021, Counter step 2). Proposed whenever both
 * apps are installed: a closed session's sold goods leave the shop's warehouse as one delivery, done at once when
 * the stock is there.
 */
import { defineModule } from '@kosh/modules-sdk';
import { pos } from '@kosh/pos';
import { stock } from '@kosh/stock';
import { field } from '@kosh/views';
import { posStockShutro } from './module.js';

export { posStockShutro, SessionDelivery, ShopWarehouse } from './module.js';

export const posStock: ReturnType<typeof defineModule> = defineModule({
  shutro: posStockShutro,
  kosh: '^0.1.0',
  depends: [pos, stock],
  bridge: [pos, stock],
  accessLevels: {
    user: { label: 'Counter sales from stock', groups: ['pos_stock.user'] },
  },
  viewExtensions: [
    {
      view: 'pos.shop.form',
      operations: [
        { append: 'main', nodes: [field({ field: 'warehouse', id: 'shop_warehouse' })] },
      ],
    },
    {
      view: 'pos.session.form',
      operations: [
        { append: 'totals', nodes: [field({ field: 'delivery', id: 'session_delivery' })] },
      ],
    },
  ],
});
