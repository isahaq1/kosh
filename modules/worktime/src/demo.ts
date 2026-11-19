/**
 * Working time's demo data (RFC 0008 §5.8): a factory calendar with a Saturday shift beside the company's standard
 * week, a company day off next week, and Rahim's morning at the bank — so the lists have something to show and the
 * apps that count time have exceptions to count around.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['worktime.manager'] } as const;
const RAHIM = { login: 'rahim', name: 'Rahim Uddin', groups: ['worktime.user'] } as const;

export async function worktimeDemo(ctx: DemoContext): Promise<string> {
  const rahim = await ctx.as(RAHIM, async (raw) => (raw as Env).userId);
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    await env.model('work.calendar').create([
      {
        name: 'Factory (six days)',
        tz: 'Asia/Dhaka',
        country: 'bd',
        hoursPerDay: '8',
        hours: {
          create: (['sat', 'sun', 'mon', 'tue', 'wed', 'thu'] as const).flatMap((weekday) => [
            { weekday, fromTime: '08:00', toTime: '12:00' },
            { weekday, fromTime: '13:00', toTime: '17:00' },
          ]),
        },
      },
    ]);
    await env
      .model('work.holiday')
      .create([{ name: 'Company picnic', dateFrom: ctx.date(7), dateTo: ctx.date(7) }]);
    await env.model('work.exception').create([
      {
        user: rahim,
        dateFrom: ctx.date(2),
        dateTo: ctx.date(2),
        kind: 'working',
        fromTime: '13:00',
        toTime: '18:00',
        reason: 'At the bank in the morning',
      },
    ]);
  });
  return '1 calendar, 1 holiday, 1 personal exception';
}
