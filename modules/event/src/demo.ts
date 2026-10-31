/**
 * Event Hub's demo data (RFC 0008 §5.8): a supplier day in a month — 3 seats, two ticket types and two sessions,
 * open for registration — with two attendees confirmed, one checked in, and a third on the waiting list.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['event.manager'] } as const;

export async function eventDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const at = (days: number, hour: number) => {
      const d = new Date(`${ctx.date(days)}T00:00:00`);
      d.setHours(hour);
      return d;
    };
    const [day] = (
      await env.model('event.event').create([
        {
          name: 'Supplier day 2026',
          dateBegin: at(30, 9),
          dateEnd: at(30, 17),
          venue: 'Radisson Blu, Dhaka',
          seatsMax: 3,
          tickets: {
            create: [
              { name: 'Standard', price: '1500' },
              { name: 'Workshop', price: '3500', seatsMax: 1 },
            ],
          },
          sessions: {
            create: [
              {
                name: 'Opening and market outlook',
                dateBegin: at(30, 9),
                dateEnd: at(30, 10),
                room: 'Hall A',
              },
              {
                name: 'Workshop: e-invoicing',
                dateBegin: at(30, 14),
                dateEnd: at(30, 16),
                room: 'Room 2',
              },
            ],
          },
        },
      ])
    ).ids;
    if (day === undefined) return;
    await env.model('event.event').browse([day]).publish();
    const [standard] = (await env.model('event.ticket').search({ where: { event: day }, limit: 1 }))
      .ids;
    const people = [
      { name: 'Nusrat Jahan', email: 'nusrat@example.test' },
      { name: 'Arif Hossain', email: 'arif@example.test' },
      { name: 'Tania Akter', email: 'tania@example.test' },
      { name: 'Kamal Uddin', email: 'kamal@example.test' },
    ];
    const made = await env
      .model('event.registration')
      .create(people.map((p) => ({ ...p, event: day, ticket: standard ?? null })));
    const [first, second, third, fourth] = made.ids;
    for (const id of [first, second, third])
      if (id !== undefined) await env.model('event.registration').browse([id]).confirm();
    if (fourth !== undefined) await env.model('event.registration').browse([fourth]).wait();
    if (first !== undefined) await env.model('event.registration').browse([first]).attend();
  });
  return 'Event Hub: a supplier day open for registration, 3 attendees (one checked in) and one waiting.';
}
