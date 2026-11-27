/**
 * @packageDocumentation
 * `@kosh/repair_stock`: the bridge between Repairs and Stockroom (RFC 0038 step 4). Proposed whenever both apps
 * are installed. A repair order's parts are reserved when the repair starts, taken out of stock when the item is
 * repaired (not while some are short), released when the order is cancelled.
 */
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { repair } from '@kosh/repair';
import { stock } from '@kosh/stock';
import { field } from '@kosh/views';
import { repairStockShutro } from './module.js';

export { OrderParts, repairStockShutro } from './module.js';

export const repairStock: ReturnType<typeof defineModule> = defineModule({
  shutro: repairStockShutro,
  kosh: '^0.1.0',
  depends: [repair, stock, product],
  bridge: [repair, stock],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Repairs with parts from stock', groups: ['repair_stock.user'] },
  },
  viewExtensions: [
    {
      view: 'repair.order.form',
      operations: [
        { append: 'times', nodes: [field({ field: 'partsTransfer', id: 'parts_transfer' })] },
      ],
    },
  ],
});
