/**
 * Attendance's demo data (RFC 0008 §5.8): the head office as a site with its geofence, the General shift as Rahim's
 * and Sumi's usual one, and their check-ins of the last working days — one late arrival, one evening of overtime —
 * computed into days that wait for Dina's review.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import { idByName } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';
import { instantOf, recomputeDays, timeZoneOf } from './days.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['attendance.manager'] } as const;
const RAHIM = { login: 'rahim', name: 'Rahim Uddin', groups: ['attendance.user'] } as const;
const SUMI = { login: 'sumi', name: 'Sumi Begum', groups: ['attendance.user'] } as const;

export async function attendanceDemo(ctx: DemoContext): Promise<string> {
  const uid = async (user: typeof RAHIM | typeof SUMI) =>
    ctx.as(user, async (raw) => (raw as Env).userId);
  const users = { rahim: await uid(RAHIM), sumi: await uid(SUMI) };
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const general = await idByName(env as never, 'attendance.shift', 'General');
    await env.model('attendance.site').create([
      {
        name: 'Head office',
        latitude: '23.780600',
        longitude: '90.407800',
        radius: 200,
      } as never,
    ]);
    const tz = await timeZoneOf(env);
    const people: number[] = [];
    for (const [name, user] of [
      ['Rahim Uddin', users.rahim],
      ['Sumi Begum', users.sumi],
    ] as const) {
      const found = await env.model('hr.employee').search({ where: { user }, limit: 1 });
      const id =
        found.ids[0] ?? (await env.model('hr.employee').create([{ name, user } as never])).ids[0];
      if (id === undefined) continue;
      await env
        .model('hr.employee')
        .browse([id])
        .write({ attendanceShift: general } as never);
      people.push(id);
    }
    // Five weekdays back: Rahim late on the first, Sumi two hours over on the second.
    const days = [-5, -4, -3].map((d) => ctx.date(d));
    for (const [i, date] of days.entries())
      for (const [p, employee] of people.entries()) {
        const late = p === 0 && i === 0 ? 35 : 0;
        const over = p === 1 && i === 1 ? 120 : 0;
        await env.model('attendance.record').create([
          {
            employee,
            checkIn: instantOf(date, 9 * 60 - 5 + late, tz),
            checkOut: instantOf(date, 18 * 60 + 2 + over, tz),
            source: 'manual',
          } as never,
        ]);
      }
    await env.flush();
    await env.asSuperuser({ reason: 'demo attendance days' }, async (su) => {
      await recomputeDays(su, people, days[0] as string, days[days.length - 1] as string);
      await su.flush();
    });
  });
  return 'Attendance: the head office site, the General shift, three days of check-ins to review.';
}
