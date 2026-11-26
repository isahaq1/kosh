/**
 * @packageDocumentation
 * `@kosh/quality_stock`: the bridge between Quality and Stockroom (RFC 0038 §4.3). Proposed whenever both apps are
 * installed. A transfer's checks are made when it is confirmed; it cannot be validated while a check is to do or
 * failed and not released; the transfer shows its checks.
 */
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { quality } from '@kosh/quality';
import { stock } from '@kosh/stock';
import { stat } from '@kosh/views';
import { qualityStockShutro } from './module.js';

export { ensureChecks, PickingChecked, qualityStockShutro } from './module.js';

export const qualityStock: ReturnType<typeof defineModule> = defineModule({
  shutro: qualityStockShutro,
  kosh: '^0.1.0',
  depends: [quality, stock, product],
  bridge: [quality, stock],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Quality checks on transfers', groups: ['quality_stock.user'] },
  },
  viewExtensions: [
    {
      view: 'stock.picking.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'picking_checks',
              label: 'Quality checks',
              model: 'quality.check',
              where: { resModel: 'stock.picking', resId: { $record: 'id' } },
              action: 'quality.action_checks',
            }),
            stat({
              id: 'picking_checks_open',
              label: 'Checks holding it',
              model: 'quality.check',
              where: {
                resModel: 'stock.picking',
                resId: { $record: 'id' },
                or: [{ state: 'todo' }, { state: 'failed', released: false }],
              },
              action: 'quality.action_checks',
            }),
          ],
        },
      ],
    },
  ],
});
