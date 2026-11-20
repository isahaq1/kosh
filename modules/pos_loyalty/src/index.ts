/**
 * @packageDocumentation
 * `@kosh/pos_loyalty` (RFC 0034 §2.6): Loyalty at the Counter. Proposed whenever both apps are installed.
 *
 * - The cashier names the customer by their **loyalty card's number** — or a phone number, an email address —,
 *   and the till says what the card holds.
 * - A paid sale with a customer **earns points**, once — also a sale rung up offline and sent later.
 * - A **refund** takes back the share of the points that the returned goods were of the sale.
 */
import { loyalty } from '@kosh/loyalty';
import { defineModule } from '@kosh/modules-sdk';
import { pos } from '@kosh/pos';
import type { ModuleContext } from '@kosh/server';
import type { Worker } from '@kosh/server/orm';
import { field } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { loyaltyOfSale, posLoyaltyShutro } from './module.js';

export { loyaltyOfSale, posLoyaltyShutro, SaleLoyalty, ShopLoyalty } from './module.js';

/** The worker that gives and takes back points as sales and refunds are paid; tests `drain()` it. */
export function posLoyaltyWorkers(context: Pick<ModuleContext, 'shutro'>): Worker[] {
  return [
    context.shutro.subscribe(
      'pos_loyalty.sale',
      'pos.order.paid',
      async (event, env) => {
        const id = Number((event.payload as { id?: unknown } | null)?.id);
        if (Number.isInteger(id)) await loyaltyOfSale(env as unknown as Env, id);
      },
      { pollMs: 5000 },
    ),
  ];
}

export interface PosLoyaltyOptions {
  /** Start the worker (default: unless `KOSH_SCHEDULES=off`). */
  readonly workers?: boolean | undefined;
}

/** Loyalty at the Counter with explicit options (tests: the worker drained by hand). */
export function posLoyaltyModule(options: PosLoyaltyOptions = {}): ReturnType<typeof defineModule> {
  return defineModule({
    shutro: posLoyaltyShutro,
    kosh: '^0.1.0',
    depends: [pos, loyalty],
    bridge: [pos, loyalty],
    // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
    i18n: { bn: () => import('./i18n/bn.js') },
    accessLevels: {
      user: { label: 'Loyalty at the Counter', groups: ['pos_loyalty.user'] },
    },
    viewExtensions: [
      {
        view: 'pos.order.form',
        operations: [
          { append: 'main', nodes: [field({ field: 'loyaltyPoints', id: 'sale_loyalty_points' })] },
        ],
      },
    ],
    routes: (context: ModuleContext) => {
      if (!(options.workers ?? process.env['KOSH_SCHEDULES'] !== 'off')) return;
      const running = posLoyaltyWorkers(context);
      for (const w of running) w.start();
      context.app.addHook('onClose', async () => {
        for (const w of running) await w.stop();
      });
    },
  });
}

export const posLoyalty: ReturnType<typeof defineModule> = posLoyaltyModule();
