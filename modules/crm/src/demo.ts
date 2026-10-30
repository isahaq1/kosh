/**
 * Pipeline's demo data (RFC 0008 §5.8): Dina's deals across the stages — a new lead, a proposal with its revenue
 * and close date, a won deal and a lost one with its reason — so the board and the forecast have something to show.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import { idByName } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['crm.manager'] } as const;

export async function crmDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const stage = (name: string) => idByName(env as never, 'crm.stage', name);
    const reason = await idByName(env as never, 'crm.lost.reason', 'Too expensive');
    await env.model('crm.deal').create([
      {
        name: 'Office furniture for Meghna Bank',
        companyName: 'Meghna Bank',
        contactName: 'Farhana Ali',
        email: 'farhana@meghnabank.example',
        stage: (await stage('New')) as never,
        source: 'website',
      },
      {
        name: 'Annual supply contract, Bengal Steel',
        companyName: 'Bengal Steel',
        stage: (await stage('Proposal')) as never,
        probability: 60,
        expectedRevenue: '1250000',
        closeDate: ctx.date(20),
        priority: 'very_good',
        source: 'referral',
      },
      {
        name: 'Laptops for Padma Textiles',
        companyName: 'Padma Textiles',
        stage: (await stage('Won')) as never,
        probability: 100,
        expectedRevenue: '480000',
        closeDate: ctx.date(-5),
      },
      {
        name: 'Printers for Rupsha Ltd',
        companyName: 'Rupsha Ltd',
        stage: (await stage('Qualified')) as never,
        lost: true,
        lostReason: reason as never,
      },
    ]);
  });
  return 'Pipeline: 4 deals across the stages.';
}
