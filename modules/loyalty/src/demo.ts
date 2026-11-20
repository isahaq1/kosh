/**
 * Loyalty's demo data (RFC 0008 §5.8): a running program — a point for every hundred, two tiers, points that
 * expire after a year — and two customers with cards and points given by hand, so the overview has something to
 * show before the first order is confirmed.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['loyalty.manager'] } as const;

export async function loyaltyDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const [program] = (
      await env.model('loyalty.program').create([
        {
          name: 'Padma Rewards',
          pointValue: '1',
          expireMonths: 12,
          rules: { create: [{ name: 'A point for every 100', points: 1, amountPer: '100' }] },
          tiers: {
            create: [
              { name: 'Silver', minPoints: 500, multiplier: '1.25' },
              { name: 'Gold', minPoints: 2000, multiplier: '1.5' },
            ],
          },
        },
      ] as never)
    ).ids;
    if (program === undefined) return;
    await env.model('loyalty.program').browse([program]).launch();
    const customers = (
      await env
        .model('res.partner')
        .create([{ name: 'Rupali Stores' }, { name: 'Shapla Enterprise' }] as never)
    ).ids;
    const cards = (
      await env
        .model('loyalty.card')
        .create(customers.map((partner) => ({ program, partner })) as never)
    ).ids;
    await env.model('loyalty.entry').create([
      { card: cards[0], date: ctx.date(-40), points: 650, note: 'Points from the old card' },
      { card: cards[1], date: ctx.date(-10), points: 120, note: 'A welcome gift' },
    ] as never);
  });
  return '1 program (running), 2 cards with points';
}
