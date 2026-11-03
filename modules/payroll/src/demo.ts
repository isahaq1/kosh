/**
 * Payroll's demo data (RFC 0008 §5.8): a Standard structure (basic 60% of the wage, house rent 40% of the basic,
 * the rest as other allowances, overtime from approved attendance at the hourly basic, absence on the basic, loan
 * instalments), Rahim's and Sumi's running contracts on it, a loan for Rahim, and last month's run computed for
 * Dina to check and approve. The Bangladesh structure comes with `l10n_bd_payroll`.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const DINA = {
  login: 'dina',
  name: 'Dina Rahman',
  groups: ['payroll.manager', 'hr.manager'],
} as const;
const RAHIM = { login: 'rahim', name: 'Rahim Uddin', groups: ['payroll.user'] } as const;
const SUMI = { login: 'sumi', name: 'Sumi Begum', groups: ['payroll.user'] } as const;

export const STANDARD_RULES = [
  {
    sequence: 10,
    code: 'BASIC',
    name: 'Basic',
    category: 'basic',
    formula: 'WAGE * 0.6 * CONTRACT_DAYS / PERIOD_DAYS',
  },
  {
    sequence: 20,
    code: 'HOUSE_RENT',
    name: 'House rent',
    category: 'allowance',
    formula: 'BASIC * 0.4',
  },
  {
    sequence: 30,
    code: 'OTHER',
    name: 'Other allowances',
    category: 'allowance',
    formula: 'WAGE * CONTRACT_DAYS / PERIOD_DAYS - BASIC - HOUSE_RENT',
  },
  {
    sequence: 40,
    code: 'OVERTIME',
    name: 'Overtime',
    category: 'allowance',
    formula: 'BASIC / 208 * OVERTIME_RATE * OVERTIME_HOURS',
    condition: 'OVERTIME_HOURS > 0',
  },
  {
    sequence: 50,
    code: 'BONUS',
    name: 'Bonus',
    category: 'allowance',
    formula: 'INPUT_BONUS',
    condition: 'INPUT_BONUS > 0',
  },
  {
    sequence: 60,
    code: 'ABSENCE',
    name: 'Absence',
    category: 'deduction',
    formula: 'BASIC / 30 * ABSENT_DAYS',
    condition: 'ABSENT_DAYS > 0',
  },
  {
    sequence: 70,
    code: 'LOAN',
    name: 'Loan instalment',
    category: 'deduction',
    formula: 'LOAN',
    condition: 'LOAN > 0',
  },
] as const;

export async function payrollDemo(ctx: DemoContext): Promise<string> {
  const uid = async (user: typeof RAHIM | typeof SUMI) =>
    ctx.as(user, async (raw) => (raw as Env).userId);
  const users = { rahim: await uid(RAHIM), sumi: await uid(SUMI) };
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const structure = (
      await env
        .model('payroll.structure')
        .create([
          { name: 'Standard', rules: { create: STANDARD_RULES.map((r) => ({ ...r })) } } as never,
        ])
    ).ids[0];
    const start = ctx.date(-400);
    const people: Record<string, number> = {};
    for (const [key, name, user, wage] of [
      ['rahim', 'Rahim Uddin', users.rahim, '45000'],
      ['sumi', 'Sumi Begum', users.sumi, '60000'],
    ] as const) {
      const found = await env.model('hr.employee').search({ where: { user }, limit: 1 });
      const employee =
        found.ids[0] ?? (await env.model('hr.employee').create([{ name, user } as never])).ids[0];
      if (employee === undefined) continue;
      people[key] = employee;
      const contract = await env
        .model('hr.contract')
        .create([
          { name: `${name} — employment`, employee, dateStart: start, wage, structure } as never,
        ]);
      await env.model('hr.contract').browse(contract.ids).start();
    }
    // Last month, whole.
    const today = ctx.date(0);
    const [y, m] = today.split('-').map(Number) as [number, number];
    const first = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
    const loan = await env.model('payroll.loan').create([
      {
        employee: people['rahim'],
        amount: '12000',
        installment: '2000',
        dateStart: first,
      } as never,
    ]);
    await env.model('payroll.loan').browse(loan.ids).start();
    await env.model('payroll.input').create([
      {
        employee: people['sumi'],
        date: last,
        code: 'BONUS',
        amount: '5000',
        note: 'Project delivered',
      } as never,
    ]);
    const run = await env
      .model('payroll.run')
      .create([{ title: 'Last month’s salaries', dateFrom: first, dateTo: last } as never]);
    await env.flush();
    await env.model('payroll.run').browse(run.ids).compute();
  });
  return 'Payroll: the Standard structure, two contracts on it, a loan, a bonus, last month’s run computed to approve.';
}
