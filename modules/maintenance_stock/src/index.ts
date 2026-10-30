/**
 * @packageDocumentation
 * `@kosh/maintenance_stock`: the bridge between Asset Care and Stockroom (RFC 0021, Asset Care step 2). Proposed
 * whenever both apps are installed. Maintenance orders list their spare parts: reserved when the order starts,
 * consumed when it is finished (not while some are short), released when it is cancelled.
 */

import { maintenance } from '@kosh/maintenance';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { stock } from '@kosh/stock';
import { field } from '@kosh/views';
import { maintenanceStockShutro } from './module.js';

export { MaintenancePart, maintenanceStockShutro, RequestParts } from './module.js';

export const maintenanceStock: ReturnType<typeof defineModule> = defineModule({
  shutro: maintenanceStockShutro,
  kosh: '^0.1.0',
  depends: [maintenance, stock, product],
  bridge: [maintenance, stock],
  accessLevels: {
    user: { label: 'Maintenance with spare parts', groups: ['maintenance_stock.user'] },
  },
  viewExtensions: [
    {
      view: 'maintenance.request.form',
      operations: [
        {
          insertAfter: 'tasks',
          nodes: [
            {
              kind: 'lines',
              id: 'parts',
              field: 'parts',
              columns: [
                field({ field: 'product', id: 'part_product' }),
                field({ field: 'quantity', id: 'part_quantity' }),
                field({ field: 'uom', id: 'part_uom' }),
                field({ field: 'cost', id: 'part_cost' }),
              ],
            },
          ],
        },
        {
          append: 'times',
          nodes: [
            field({ field: 'partsCost', id: 'parts_cost' }),
            field({ field: 'partsTransfer', id: 'parts_transfer' }),
          ],
        },
      ],
    },
  ],
});
