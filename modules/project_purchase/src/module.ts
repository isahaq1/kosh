/**
 * The data layer of the Projects ↔ Purchase bridge (RFC 0026 step 4): the untaxed lines of confirmed purchase orders
 * on a project's cost centre that are not billed yet are its **committed costs**; once billed and posted they are
 * booked instead (`project_account`), so nothing counts twice.
 */
import { projectShutro } from '@kosh/project';
import { projectAccountShutro } from '@kosh/project_account';
import { purchaseAccountShutro } from '@kosh/purchase_account';
import { type Decimal, orm } from '@kosh/server/orm';
import { defineModule, type Env, extendModel, type Records } from './.kosh/bindings.js';

const ZERO: Decimal = orm.toDecimal(0);

export const ProjectCommitted = extendModel('project.project', {
  overrides: {
    moneyOf: async function (
      this: unknown,
      next: () => Promise<Map<number, { booked: string; committed: string }>>,
    ): Promise<Map<number, { booked: string; committed: string }>> {
      // After project_account's: the cost centres exist.
      const out = await next();
      const projects = this as Records<'project.project'>;
      const env = projects.env as unknown as Env;
      for (const p of await projects.load({ analytic: true })) {
        if (p.analytic === null) continue;
        const lines = await env
          .model('purchase.order.line')
          .search({
            where: {
              analytic: p.analytic.id,
              'order.state': { in: ['purchase', 'done'] },
              'order.billState': { ne: 'billed' },
            } as never,
          })
          .then((r) => r.load(['subtotal']));
        const committed = [...lines].reduce((s, l) => s.plus(l.subtotal?.amount ?? ZERO), ZERO);
        const before = out.get(p.id as number) ?? { booked: '0', committed: '0' };
        out.set(p.id as number, {
          booked: before.booked,
          committed: orm.toDecimal(before.committed).plus(committed).toFixed(2),
        });
      }
      return out;
    },
  },
});

export const projectPurchaseShutro = defineModule({
  name: 'project_purchase',
  version: '0.1.0',
  depends: [projectShutro, projectAccountShutro, purchaseAccountShutro],
  groups: [
    orm.defineGroup({
      code: 'project_purchase.user',
      label: 'Projects with their purchases',
      implies: ['project_account.user', 'purchase.user'],
    }),
  ],
  models: [],
  extensions: [ProjectCommitted],
});
