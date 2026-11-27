/**
 * @packageDocumentation
 * `@kosh/marketing_sale` (RFC 0038 step 3): the bridge between Campaigns and Sales, proposed whenever both apps are
 * installed. A confirmed order is credited to the campaign whose link its customer followed last, in the 30 days
 * before; a campaign shows its orders and what they come to.
 */
import { marketing } from '@kosh/marketing';
import { defineModule } from '@kosh/modules-sdk';
import { sales } from '@kosh/sales';
import type { ModuleContext } from '@kosh/server';
import type { Env, Worker } from '@kosh/server/orm';
import { field, stat } from '@kosh/views';
import { creditOrder, marketingSaleShutro } from './module.js';

export { ATTRIBUTION_DAYS, creditOrder, marketingSaleShutro, OrderCampaign } from './module.js';

/** The subscriber that credits confirmed orders to campaigns (tests drain it). */
export function marketingSaleWorkers(context: Pick<ModuleContext, 'shutro'>): Worker[] {
  return [
    context.shutro.subscribe(
      'marketing_sale.credit',
      'sale.order.confirmed',
      async (event, env) => {
        const id = Number((event.payload as { id?: unknown } | null)?.id);
        if (Number.isSafeInteger(id) && id > 0)
          await (env as unknown as Env).asSuperuser(
            { reason: 'order credited to a campaign' },
            (su) => creditOrder(su as never, id),
          );
      },
      { pollMs: 5000 },
    ),
  ];
}

export const marketingSale: ReturnType<typeof defineModule> = defineModule({
  shutro: marketingSaleShutro,
  kosh: '^0.1.0',
  depends: [sales, marketing],
  bridge: [sales, marketing],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Orders credited to campaigns', groups: ['marketing_sale.user'] },
  },
  viewExtensions: [
    {
      view: 'marketing.campaign.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'campaign_orders',
              label: 'Orders',
              model: 'sale.order',
              where: { campaign: { $record: 'id' }, state: { in: ['sale', 'done'] } },
              action: 'sales.action_orders',
            }),
            stat({
              id: 'campaign_ordered',
              label: 'Ordered',
              model: 'sale.order',
              where: { campaign: { $record: 'id' }, state: { in: ['sale', 'done'] } },
              measure: { sum: 'amountTotal' },
              action: 'sales.action_orders',
              tone: 'success',
            }),
          ],
        },
      ],
    },
    {
      view: 'sale.order.form',
      operations: [
        { append: 'dates', nodes: [field({ field: 'campaign', id: 'order_campaign' })] },
      ],
    },
  ],
  routes: (context: ModuleContext) => {
    if (process.env['KOSH_SCHEDULES'] === 'off') return;
    const workers = marketingSaleWorkers(context);
    for (const w of workers) w.start();
    context.app.addHook('onClose', async () => {
      for (const w of workers) await w.stop();
    });
  },
});
