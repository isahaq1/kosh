/**
 * @packageDocumentation
 * `@kosh/sale_crm` (RFC 0028 §3.4): the bridge between Pipeline and Sales, proposed whenever both apps are installed.
 * "New quotation" on a deal opens a quotation for its customer, by its salesperson, linked to the deal; the deal shows
 * its quotations and what was confirmed; a confirmed quotation wins the deal, and cancelling every quotation loses it.
 */
import { crm } from '@kosh/crm';
import { defineModule } from '@kosh/modules-sdk';
import { sales } from '@kosh/sales';
import type { ModuleContext } from '@kosh/server';
import type { Env, Worker } from '@kosh/server/orm';
import { field, stat } from '@kosh/views';
import { loseDealOf, saleCrmShutro, winDealOf } from './module.js';

export { DealQuotations, loseDealOf, OrderDeal, saleCrmShutro, winDealOf } from './module.js';

/** The subscribers that win and lose deals as their quotations are confirmed or cancelled (tests drain them). */
export function saleCrmWorkers(context: Pick<ModuleContext, 'shutro'>): Worker[] {
  const follow = (name: string, topic: string, fn: (env: Env, id: number) => Promise<boolean>) =>
    context.shutro.subscribe(
      name,
      topic,
      async (event, env) => {
        const id = Number((event.payload as { id?: unknown } | null)?.id);
        if (Number.isSafeInteger(id) && id > 0)
          await (env as unknown as Env).asSuperuser({ reason: `deal from ${topic}` }, (su) =>
            fn(su, id),
          );
      },
      { pollMs: 5000 },
    );
  return [
    follow('sale_crm.won', 'sale.order.confirmed', winDealOf),
    follow('sale_crm.lost', 'sale.order.cancelled', loseDealOf),
  ];
}

export const saleCrm: ReturnType<typeof defineModule> = defineModule({
  shutro: saleCrmShutro,
  kosh: '^0.1.0',
  depends: [sales, crm],
  bridge: [sales, crm],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Quotations from deals', groups: ['sale_crm.user'] },
  },
  viewExtensions: [
    {
      view: 'crm.deal.form',
      operations: [
        {
          append: 'header',
          nodes: [
            {
              kind: 'button',
              id: 'new_quotation',
              label: 'New quotation',
              primary: true,
              open: {
                model: 'sale.order',
                values: {
                  deal: { $record: 'id' },
                  partner: { $record: 'partner' },
                  user: { $record: 'salesperson' },
                },
              },
              visibleWhen: { status: 'open' },
            },
          ],
        },
      ],
    },
    // The deal's quotations, and what was confirmed (RFC 0028 §3.4).
    {
      view: 'crm.deal.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'deal_quotations',
              label: 'Quotations',
              model: 'sale.order',
              where: { deal: { $record: 'id' } },
              action: 'sales.action_orders',
            }),
            stat({
              id: 'deal_ordered',
              label: 'Ordered',
              model: 'sale.order',
              where: { deal: { $record: 'id' }, state: { in: ['sale', 'done'] } },
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
      operations: [{ append: 'dates', nodes: [field({ field: 'deal', id: 'order_deal' })] }],
    },
  ],
  routes: (context: ModuleContext) => {
    if (process.env['KOSH_SCHEDULES'] === 'off') return;
    const workers = saleCrmWorkers(context);
    for (const w of workers) w.start();
    context.app.addHook('onClose', async () => {
      for (const w of workers) await w.stop();
    });
  },
});
