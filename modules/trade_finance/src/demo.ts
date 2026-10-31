/**
 * Trade Finance's demo data (RFC 0008 §5.8): a bank with a USD 500,000 limit, an import LC for steel from Bengal
 * Steel — issued, with documents presented and accepted at 90 days' usance — and a draft LC being prepared.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import { idByName } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['trade_finance.manager'] } as const;

export async function tradeFinanceDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const id = (model: string, name: string) =>
      idByName(env as never, model, name) as Promise<never>;
    // US dollars, made when the installation has none yet (currencies are not users' to create).
    const usd = await env.asSuperuser({ reason: 'demo: USD' }, async (su) => {
      const found = await su.model('res.currency').search({ where: { name: 'USD' }, limit: 1 });
      return (found.ids[0] ??
        (await su.model('res.currency').create([{ name: 'USD' }])).ids[0]) as never;
    });
    const bank = (
      await env.model('res.partner').create([{ name: 'Dhaka Commerce Bank', isCompany: true }])
    ).ids[0];
    if (bank === undefined) return;
    await env.model('trade.lc.limit').create([{ bank, currency: usd, amount: '500000' }]);
    const vendor = await id('res.partner', 'Bengal Steel Ltd');
    const [lc] = (
      await env.model('trade.lc').create([
        {
          direction: 'import',
          bank,
          partner: vendor,
          currency: usd,
          amount: '120000',
          tolerance: '5',
          payment: 'usance',
          usanceDays: 90,
          incoterm: 'cfr',
          latestShipmentDate: ctx.date(20),
          expiryDate: ctx.date(35),
          expiryPlace: 'Dhaka',
          documents: 'Commercial invoice, bill of lading, packing list, certificate of origin',
        },
        {
          direction: 'import',
          bank,
          partner: vendor,
          currency: usd,
          amount: '45000',
          // The margin of the application being prepared (an issued one would post it, needing the day's USD rate).
          marginPercent: '10',
          latestShipmentDate: ctx.date(60),
          expiryDate: ctx.date(75),
        },
      ])
    ).ids;
    if (lc === undefined) return;
    const one = env.model('trade.lc').browse([lc]);
    await one.apply();
    await one.write({ bankReference: '0123-26-01-0042' });
    await one.issue();
    const [presented] = (
      await env.model('trade.lc.presentation').create([
        {
          lc,
          amount: '60000',
          documents: 'First shipment: invoice, B/L, packing list',
        },
      ])
    ).ids;
    if (presented !== undefined)
      await env.model('trade.lc.presentation').browse([presented]).accept();
  });
  return 'Trade Finance: a bank limit, an issued import LC with documents accepted, a draft LC.';
}
