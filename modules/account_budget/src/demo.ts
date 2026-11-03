/**
 * Budgets' demo data (RFC 0008 §5.8): two cost centres and this year's budget — the operations team's purchases (a
 * warning beyond them), office expenses (report only) — approved, with its figures from the books.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['account.manager'] } as const;

export async function budgetDemo(ctx: DemoContext): Promise<string> {
  return ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const office = (
      await env.model('account.account').search({ where: { code: '6300' }, limit: 1 })
    ).ids[0];
    if (office === undefined) return 'Budgets: no chart of accounts, nothing made.';
    const centre = async (code: string, name: string) =>
      (await env.model('account.analytic').search({ where: { code }, limit: 1 })).ids[0] ??
      (await env.model('account.analytic').create([{ code, name } as never])).ids[0];
    const ops = await centre('OPS', 'Operations');
    await centre('SALES', 'Sales team');
    const year = ctx.date(0).slice(0, 4);
    const made = await env.model('account.budget').create([
      {
        name: `Budget ${year}`,
        dateFrom: `${year}-01-01`,
        dateTo: `${year}-12-31`,
        lines: {
          create: [
            { name: 'Operations purchases', analytic: ops, planned: '1500000', control: 'warn' },
            { name: 'Office expenses', account: office, planned: '300000', control: 'none' },
          ],
        },
      } as never,
    ]);
    await env.flush();
    await env.model('account.budget').browse(made.ids).approve();
    return `Budgets: the ${year} budget with two lines, approved.`;
  });
}
