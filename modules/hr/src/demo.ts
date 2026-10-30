/**
 * Workforce's demo data (RFC 0008 §5.8): two departments, three employees — Dina heads Operations and manages Rahim
 * and Sumi — and Rahim's casual leave waiting for Dina's decision. People who are already employees are reused.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import { idByName } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';
import { weekendOf, workingDays } from './module.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['hr.manager'] } as const;
const RAHIM = { login: 'rahim', name: 'Rahim Uddin', groups: ['hr.user'] } as const;
const SUMI = { login: 'sumi', name: 'Sumi Begum', groups: ['hr.user'] } as const;

/** The first working day (by the installation's week) `from` days from now, as an ISO date. */
async function workday(ctx: DemoContext, env: Env, from: number): Promise<string> {
  const weekend = await weekendOf(env);
  for (let d = from; ; d += 1)
    if (workingDays(ctx.date(d), ctx.date(d), weekend) === 1) return ctx.date(d);
}

export async function hrDemo(ctx: DemoContext): Promise<string> {
  const rahimUser = await ctx.as(RAHIM, async (raw) => (raw as Env).userId);
  const sumiUser = await ctx.as(SUMI, async (raw) => (raw as Env).userId);
  const rahim = await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    /** The user's employee: the existing one, else a new one with these details. */
    const employee = async (
      name: string,
      user: typeof env.userId,
      details: Record<string, unknown>,
    ) => {
      const found = await env.model('hr.employee').search({ where: { user }, limit: 1 });
      if (found.ids[0] !== undefined) {
        await found.write(details as never);
        return found.ids[0];
      }
      return (await env.model('hr.employee').create([{ name, user, ...details } as never])).ids[0];
    };
    const ops = (await env.model('hr.department').create([{ name: 'Operations' }])).ids[0] ?? null;
    await env.model('hr.department').create([{ name: 'Finance' }]);
    const dina = await employee('Dina Rahman', env.userId, {
      department: ops,
      workEmail: 'dina@example.test',
    });
    const r = await employee('Rahim Uddin', rahimUser, { department: ops, manager: dina });
    await employee('Sumi Begum', sumiUser, { department: ops, manager: dina });
    if (ops !== null)
      await env
        .model('hr.department')
        .browse([ops])
        .write({ head: dina ?? null });
    return r;
  });
  // Rahim asks for a day off; Dina decides.
  await ctx.as(RAHIM, async (raw) => {
    const env = raw as Env;
    const casual = await idByName(env as never, 'hr.leave.type', 'Casual leave');
    const day = await workday(ctx, env, 30);
    const made = await env.model('hr.leave').create([
      {
        employee: rahim as never,
        type: casual as never,
        dateFrom: day,
        dateTo: day,
        days: 1,
        reason: 'Family visit',
      },
    ]);
    await env.model('hr.leave').browse(made.ids).submit();
  });
  return 'Workforce: 2 departments, 3 employees, a leave request waiting.';
}
