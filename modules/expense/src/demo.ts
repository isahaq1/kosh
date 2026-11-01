/**
 * Spend's demo data (RFC 0008 §5.8): Rahim's report of a field visit — two days' allowance, the drive and a lunch —
 * waiting for approval, and Sumi's cash advance for a supplier trip, waiting too. Dina approves (Spend manager).
 * Workforce's demo made the employees; people without one get theirs here.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import { idByName } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['expense.manager'] } as const;
const RAHIM = { login: 'rahim', name: 'Rahim Uddin', groups: ['expense.user'] } as const;
const SUMI = { login: 'sumi', name: 'Sumi Begum', groups: ['expense.user'] } as const;

export async function expenseDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(DINA, async () => undefined);
  // Each person's employee: Workforce's, else a new one.
  const employeeOf = async (user: typeof RAHIM | typeof SUMI) => {
    const uid = await ctx.as(user, async (raw) => (raw as Env).userId);
    return ctx.system('demo employees for Spend', async (raw) => {
      const env = raw as Env;
      const found = await env.model('hr.employee').search({ where: { user: uid }, limit: 1 });
      return (
        found.ids[0] ??
        (await env.model('hr.employee').create([{ name: user.name, user: uid } as never])).ids[0]
      );
    });
  };
  const rahim = await employeeOf(RAHIM);
  const sumi = await employeeOf(SUMI);

  await ctx.as(RAHIM, async (raw) => {
    const env = raw as Env;
    const category = (name: string) => idByName(env as never, 'expense.category', name);
    const sheet = await env
      .model('expense.sheet')
      .create([{ employee: rahim, title: 'Field visit to Chattogram' } as never]);
    await env.model('expense.expense').create([
      {
        name: 'Daily allowance, Chattogram',
        employee: rahim,
        date: ctx.date(-6),
        category: await category('Daily allowance'),
        quantity: '2',
        amount: '1600',
        sheet: sheet.ids[0],
      },
      {
        name: 'Drive Dhaka – Chattogram and back',
        employee: rahim,
        date: ctx.date(-6),
        category: await category('Own vehicle'),
        quantity: '520',
        amount: '13000',
        sheet: sheet.ids[0],
      },
      {
        name: 'Lunch with the supplier',
        employee: rahim,
        date: ctx.date(-5),
        category: await category('Meals'),
        amount: '280',
        sheet: sheet.ids[0],
      },
    ] as never);
    await env.flush();
    await env.model('expense.sheet').browse(sheet.ids).submit();
  });

  await ctx.as(SUMI, async (raw) => {
    const env = raw as Env;
    const made = await env.model('expense.advance').create([
      {
        employee: sumi,
        purpose: 'Supplier visits in Narayanganj',
        date: ctx.date(3),
        amount: '10000',
      } as never,
    ]);
    await env.model('expense.advance').browse(made.ids).submit();
  });
  return 'Spend: a report of a field visit and a cash advance, both waiting for approval.';
}
