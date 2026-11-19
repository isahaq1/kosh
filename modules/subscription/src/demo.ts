/**
 * Subscriptions' demo data (RFC 0008 §5.8): a monthly and a yearly plan, two running subscriptions — one with a
 * line billed by usage and some usage recorded — and one that left, so the overview has revenue and churn to show.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['subscription.manager'] } as const;

export async function subscriptionDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const [monthly, yearly] = (
      await env.model('subscription.plan').create([
        { name: 'Monthly', unit: 'month', interval: 1 },
        { name: 'Yearly, 14 days to try', unit: 'year', interval: 1, trialDays: 14 },
      ])
    ).ids;
    const [support, seats, messages] = (
      await env.model('product.product').create([
        { name: 'Support plan', kind: 'service', listPrice: '5000' },
        { name: 'Software seat', kind: 'service', listPrice: '1200' },
        { name: 'SMS sent', kind: 'service', listPrice: '0.50' },
      ] as never)
    ).ids;
    const [a, b, c] = (
      await env
        .model('res.partner')
        .create([
          { name: 'Meghna Textiles' },
          { name: 'Padma Foods' },
          { name: 'Jamuna Traders' },
        ] as never)
    ).ids;
    const made = await env.model('subscription.subscription').create([
      {
        partner: a,
        plan: monthly,
        dateStart: ctx.date(-40),
        lines: {
          create: [
            { product: support, quantity: '1' },
            { product: seats, quantity: '8' },
            { product: messages, kind: 'usage', quantity: '0' },
          ],
        },
      },
      {
        partner: b,
        plan: yearly,
        dateStart: ctx.date(-5),
        lines: { create: [{ product: seats, quantity: '25', discount: '10' }] },
      },
      {
        partner: c,
        plan: monthly,
        dateStart: ctx.date(-70),
        lines: { create: [{ product: support, quantity: '1' }] },
      },
    ] as never);
    const subs = await made.load({ lines: true });
    for (const s of subs) await env.model('subscription.subscription').browse([s.id]).begin();
    const [first, , third] = [...subs];
    const metered =
      first === undefined ? undefined : [...first.lines].find((l) => l.kind === 'usage');
    if (metered !== undefined)
      await env.model('subscription.usage').create([
        { line: metered.id, date: ctx.date(-3), quantity: '1840', note: 'Campaign of the week' },
        { line: metered.id, date: ctx.date(-1), quantity: '620', note: 'Order confirmations' },
      ] as never);
    if (third !== undefined) {
      const gone = env.model('subscription.subscription').browse([third.id]);
      await gone.write({ closeReason: 'price' } as never);
      await gone.close();
    }
  });
  return '2 plans, 3 subscriptions (one closed), usage on one';
}
