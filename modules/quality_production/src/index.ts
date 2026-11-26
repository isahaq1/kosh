/**
 * @packageDocumentation
 * `@kosh/quality_production`: the bridge between Quality and Production (RFC 0038 §4.3). Proposed whenever both
 * apps are installed. A production order's checks are made when it is confirmed; it is not produced while a check
 * is to do or failed and not released; the order shows its checks.
 */
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { production } from '@kosh/production';
import { quality } from '@kosh/quality';
import { stat } from '@kosh/views';
import { qualityProductionShutro } from './module.js';

export { ensureOrderChecks, OrderChecked, qualityProductionShutro } from './module.js';

export const qualityProduction: ReturnType<typeof defineModule> = defineModule({
  shutro: qualityProductionShutro,
  kosh: '^0.1.0',
  depends: [quality, production, product],
  bridge: [quality, production],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Quality checks on production orders', groups: ['quality_production.user'] },
  },
  viewExtensions: [
    {
      view: 'production.order.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'order_checks',
              label: 'Quality checks',
              model: 'quality.check',
              where: { resModel: 'production.order', resId: { $record: 'id' } },
              action: 'quality.action_checks',
            }),
            stat({
              id: 'order_checks_open',
              label: 'Checks holding it',
              model: 'quality.check',
              where: {
                resModel: 'production.order',
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
