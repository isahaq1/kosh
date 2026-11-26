/**
 * The data layer of the Quality ↔ Production bridge (RFC 0038 §4.3): a production order's checks are made when it
 * is confirmed — from the control points on *Production* for the product it makes —, and producing it is
 * **refused** while one of them is still to do or failed and not released: nothing is consumed, nothing enters
 * stock. The order's own transfers are not checked (Stockroom's bridge leaves them alone).
 */
import { productShutro } from '@kosh/product';
import { productionShutro } from '@kosh/production';
import { blockingChecks, checksFor, qualityShutro } from '@kosh/quality';
import { orm } from '@kosh/server/orm';
import { defineModule, type Env, extendModel, type Records } from './.kosh/bindings.js';

/** Makes the checks these orders still lack (once per point and order); as the system. */
export async function ensureOrderChecks(env: Env, ids: readonly number[]): Promise<number> {
  return env.asSuperuser({ reason: 'the quality checks of a production order' }, async (su) => {
    let made = 0;
    for (const o of await su
      .model('production.order')
      .browse([...ids] as never)
      .load({ product: true })) {
      if (o.state === 'draft' || o.state === 'cancel') continue;
      made += await checksFor(su as never, {
        operation: 'production',
        company: o.company.id as number,
        partner: null,
        resModel: 'production.order',
        resId: o.id as number,
        resName: o.name,
        lines: [{ product: o.product.id as number, lot: o.batch ?? null }],
      });
    }
    return made;
  });
}

export const OrderChecked = extendModel('production.order', {
  overrides: {
    // Confirmed: what is made will be checked.
    planned: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const orders = this as Records<'production.order'>;
      await ensureOrderChecks(orders.env as unknown as Env, orders.ids as readonly number[]);
    },
    // Before anything is consumed: an order with a check to do or failed is not produced.
    producing: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      const orders = this as Records<'production.order'>;
      const env = orders.env as unknown as Env;
      // An order confirmed before Quality was installed gets its checks here.
      await ensureOrderChecks(env, orders.ids as readonly number[]);
      await env.asSuperuser(
        { reason: 'quality checks before an order is produced' },
        async (su) => {
          for (const id of orders.ids as readonly number[]) {
            const held = await blockingChecks(su as never, 'production.order', id);
            if (held.length === 0) continue;
            const todo = held.filter((c) => c.state === 'todo');
            const failed = held.filter((c) => c.state === 'failed');
            const say = (list: typeof held) =>
              list.map((c) => `${c.name} ${c.title}`.trim()).join(', ');
            throw new orm.ValidationError(
              'production.order',
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
        },
      );
      await next();
    },
  },
});

export const qualityProductionShutro = defineModule({
  name: 'quality_production',
  version: '0.1.0',
  depends: [qualityShutro, productionShutro, productShutro],
  groups: [
    orm.defineGroup({
      code: 'quality_production.user',
      label: 'Quality checks on production orders',
      implies: ['quality.user'],
    }),
  ],
  models: [],
  extensions: [OrderChecked],
});
