/**
 * Agenda's demo data (RFC 0008 §5.8): two rooms, a weekly review in the board room with Rahim invited (he has
 * accepted), and Dina's private dentist appointment, which others see only as busy.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['calendar.manager'] } as const;
const RAHIM = { login: 'rahim', name: 'Rahim Uddin', groups: ['calendar.user'] } as const;

export async function calendarDemo(ctx: DemoContext): Promise<string> {
  const rahim = await ctx.as(RAHIM, async (raw) => (raw as Env).userId);
  const at = (days: number, hour: number) =>
    new Date(`${ctx.date(days)}T${String(hour).padStart(2, '0')}:00:00Z`);
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const rooms = await env.model('calendar.room').create([
      { name: 'Board room', capacity: 12, location: 'Floor 3' },
      { name: 'Huddle room', capacity: 4, location: 'Floor 2' },
    ]);
    await env.model('calendar.event').create([
      {
        name: 'Weekly review',
        start: at(1, 4),
        stop: at(1, 5),
        room: rooms.ids[0] ?? null,
        attendees: { create: [{ user: rahim, response: 'accepted' }] },
      },
      { name: 'Dentist', start: at(2, 8), stop: at(2, 9), privacy: 'private' },
    ]);
  });
  return 'Agenda: 2 rooms, 2 events.';
}
