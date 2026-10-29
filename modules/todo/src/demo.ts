/**
 * Focus's demo data (RFC 0008 §5.8): Dina's shared list for the office with Rahim, a few to-dos — one due today with
 * a checklist, one overdue and urgent — so the home page and the board have something to show.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['todo.user'] } as const;
const RAHIM = { login: 'rahim', name: 'Rahim Uddin', groups: ['todo.user'] } as const;

export async function todoDemo(ctx: DemoContext): Promise<string> {
  const rahim = await ctx.as(RAHIM, async (raw) => (raw as Env).userId);
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const office = await env
      .model('todo.list')
      .create([{ name: 'Office', color: 'green', members: { set: [rahim] } }]);
    const list = office.ids[0] ?? null;
    await env.model('todo.task').create([
      {
        name: 'Prepare the monthly VAT return',
        list,
        dueDate: ctx.date(0),
        priority: 'high',
        items: {
          create: [
            { name: 'Export the sales register', sequence: 1, done: true },
            { name: 'Check the purchase VAT', sequence: 2 },
            { name: 'File the return', sequence: 3 },
          ],
        },
      },
      {
        name: 'Renew the office internet',
        list,
        dueDate: ctx.date(-2),
        priority: 'urgent',
      },
      { name: 'Plan the team lunch', dueDate: ctx.date(5) },
    ]);
  });
  return 'Focus: a shared list and 3 to-dos.';
}
