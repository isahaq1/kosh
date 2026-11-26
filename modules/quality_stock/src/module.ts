/**
 * The data layer of the Quality ↔ Stockroom bridge (RFC 0038 §4.3): a transfer's checks are made when it is
 * confirmed — from the control points of its kind, its products and its contact —, and validating it is
 * **refused** while one of them is still to do or failed and not released. The refusal is the server's, in the
 * validation itself: it is not a warning a click gets past.
 */
import { productShutro } from '@kosh/product';
import { blockingChecks, checksFor, type Operation, qualityShutro } from '@kosh/quality';
import { orm } from '@kosh/server/orm';
import { stockShutro } from '@kosh/stock';
import { defineModule, type Env, extendModel, type Records } from './.kosh/bindings.js';

/** The operation of Quality a transfer's kind is; adjustments and dropships are not checked. */
const OPERATION: Readonly<Record<string, Operation | undefined>> = {
  receipt: 'receipt',
  delivery: 'delivery',
  internal: 'internal',
  production: 'production',
};

/** Makes the checks these transfers still lack (once per point, transfer and product); as the system. */
export async function ensureChecks(env: Env, ids: readonly number[]): Promise<number> {
  return env.asSuperuser({ reason: 'the quality checks of a transfer' }, async (su) => {
    let made = 0;
    for (const p of await su
      .model('stock.picking')
      .browse([...ids] as never)
      .load({ moves: { product: true }, partner: true })) {
      const operation = OPERATION[p.kind];
      if (operation === undefined || p.moves.length === 0) continue;
      made += await checksFor(su as never, {
        operation,
        company: p.company.id as number,
        partner: (p.partner?.id as number | undefined) ?? null,
        resModel: 'stock.picking',
        resId: p.id as number,
        resName: p.name,
        lines: [...p.moves].map((m) => ({ product: m.product.id as number })),
      });
    }
    return made;
  });
}

export const PickingChecked = extendModel('stock.picking', {
  overrides: {
    // Before a draft is confirmed (its lines are fixed from here on): its checks.
    routing: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const pickings = this as Records<'stock.picking'>;
      await ensureChecks(pickings.env as unknown as Env, pickings.ids as readonly number[]);
    },
    // In the validation: a transfer with a check to do or failed does not go through.
    validated: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      const pickings = this as Records<'stock.picking'>;
      const env = pickings.env as unknown as Env;
      // A backorder, or a transfer confirmed before Quality was installed, gets its checks here.
      await ensureChecks(env, pickings.ids as readonly number[]);
      await env.asSuperuser({ reason: 'quality checks before a transfer is done' }, async (su) => {
        for (const id of pickings.ids as readonly number[]) {
          const held = await blockingChecks(su as never, 'stock.picking', id);
          if (held.length === 0) continue;
          const todo = held.filter((c) => c.state === 'todo');
          const failed = held.filter((c) => c.state === 'failed');
          const say = (list: typeof held) =>
            list.map((c) => `${c.name} ${c.title}`.trim()).join(', ');
          throw new orm.ValidationError(
            'stock.picking',
            ['state'],
            [
              todo.length > 0 ? `Quality checks to do: ${say(todo)}.` : '',
              failed.length > 0 ? `Quality checks failed: ${say(failed)}.` : '',
            ]
              .filter((part) => part !== '')
              .join(' '),
            'Do the checks in Quality › Checks; a Quality manager may release a failed one, with the reason.',
          );
        }
      });
      await next();
    },
  },
});

export const qualityStockShutro = defineModule({
  name: 'quality_stock',
  version: '0.1.0',
  depends: [qualityShutro, stockShutro, productShutro],
  groups: [
    orm.defineGroup({
      code: 'quality_stock.user',
      label: 'Quality checks on transfers',
      implies: ['quality.user'],
    }),
  ],
  models: [],
  extensions: [PickingChecked],
});
