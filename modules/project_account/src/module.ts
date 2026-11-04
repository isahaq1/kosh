/**
 * The data layer of the Projects ↔ Accounting bridge (RFC 0026 step 4): each project gets its **cost centre**
 * (`account.analytic`, coded like the project) the first time its figures are refreshed, and the costs posted on it —
 * the expense lines of bills, expenses and depreciation, debit less credit — are the project's **booked costs**,
 * besides labour from timesheets. Journal lines choose the cost centre as usual.
 */
import { accountingShutro } from '@kosh/accounting';
import { projectShutro } from '@kosh/project';
import { type Decimal, orm } from '@kosh/server/orm';
import { defineModule, type Env, extendModel, f, type Records } from './.kosh/bindings.js';

const ZERO: Decimal = orm.toDecimal(0);
const EXPENSES = ['expense', 'expense_direct_cost', 'expense_depreciation'];

export const ProjectCostCentre = extendModel('project.project', {
  fields: {
    analytic: f.many2one('account.analytic', {
      ondelete: 'restrict',
      label: 'Cost centre',
      help: 'Made with the project’s code the first time its figures are refreshed; costs booked on it are its actual costs.',
    }),
  },
  overrides: {
    moneyOf: async function (
      this: unknown,
      next: () => Promise<Map<number, { booked: string; committed: string }>>,
    ): Promise<Map<number, { booked: string; committed: string }>> {
      const out = await next();
      const projects = this as Records<'project.project'>;
      const env = projects.env as unknown as Env;
      for (const p of await projects.load({ analytic: true, company: true })) {
        let analytic = p.analytic?.id ?? null;
        if (analytic === null) {
          const made = await env.model('account.analytic').create([
            {
              code: p.code ?? `PRJ-${p.id}`,
              name: p.name,
              company: p.company.id,
            },
          ]);
          analytic = made.ids[0] as never;
          await env
            .model('project.project')
            .browse([p.id])
            .write({ analytic: analytic as never });
        }
        const lines = await env
          .model('account.move.line')
          .search({
            where: {
              posted: true,
              analytic: analytic as never,
              accountType: { in: EXPENSES },
            } as never,
          })
          .then((r) => r.load(['debit', 'credit']));
        const booked = [...lines].reduce(
          (s, l) => s.plus(l.debit.amount).minus(l.credit.amount),
          ZERO,
        );
        const before = out.get(p.id as number) ?? { booked: '0', committed: '0' };
        out.set(p.id as number, {
          booked: orm.toDecimal(before.booked).plus(booked).toFixed(2),
          committed: before.committed,
        });
      }
      return out;
    },
  },
});

export const projectAccountShutro = defineModule({
  name: 'project_account',
  version: '0.1.0',
  depends: [projectShutro, accountingShutro],
  groups: [
    orm.defineGroup({
      code: 'project_account.user',
      label: 'Projects with their costs',
      implies: ['project.user', 'account.user'],
    }),
  ],
  models: [],
  extensions: [ProjectCostCentre],
});
