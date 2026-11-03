/**
 * Helpdesk's demo data (RFC 0008 §5.8): a Support team (Dina and Rahim, assigned in turn, Sunday to Thursday 09:00
 * to 18:00), a standard SLA and a faster one for urgent tickets, a canned reply, and three tickets from customers —
 * one answered and waiting on the customer, one urgent, one solved — with the clock refreshed.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';
import { refreshSla } from './sla.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['helpdesk.manager'] } as const;
const RAHIM = { login: 'rahim', name: 'Rahim Uddin', groups: ['helpdesk.user'] } as const;

export async function helpdeskDemo(ctx: DemoContext): Promise<string> {
  const rahim = await ctx.as(RAHIM, async (raw) => (raw as Env).userId);
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const team = (
      await env.model('helpdesk.team').create([
        {
          name: 'Support',
          members: { set: [env.userId, rahim] },
          assignment: 'round_robin',
        } as never,
      ])
    ).ids[0];
    await env.model('helpdesk.sla').create([
      { name: 'Standard', sequence: 20, team, firstReplyHours: '4', resolveHours: '24' },
      {
        name: 'Urgent',
        sequence: 10,
        team,
        priority: 'urgent',
        firstReplyHours: '1',
        resolveHours: '8',
      },
    ] as never);
    await env.model('helpdesk.canned').create([
      {
        name: 'Thanks, looking into it',
        body: 'Dear {{customer}},\n\nThank you for writing about {{ticket}}. We are looking into it and will be back to you soon.\n\n{{agent}}',
      } as never,
    ]);
    const partner = async (name: string, email: string) =>
      (await env.model('res.partner').search({ where: { name }, limit: 1 })).ids[0] ??
      (await env.model('res.partner').create([{ name, email } as never])).ids[0];
    const made = await env.model('helpdesk.ticket').create([
      {
        subject: 'Invoice INV/2026/0007 shows the wrong VAT',
        description: 'The VAT on line 2 should be 15%, not 7.5%.',
        team,
        partner: await partner('Meghna Mills', 'accounts@meghna.example'),
        priority: 'normal',
      },
      {
        subject: 'Delivery to the Gazipur warehouse did not arrive',
        description: 'The order was due yesterday; the line is stopped.',
        team,
        partner: await partner('Bengal Steel', 'stores@bengalsteel.example'),
        priority: 'urgent',
      },
      {
        subject: 'How do I download my statement?',
        team,
        partner: await partner('Padma Foods', 'office@padmafoods.example'),
        priority: 'low',
      },
    ] as never);
    await env.flush();
    const [first, , third] = made.ids;
    if (first !== undefined) await env.model('helpdesk.ticket').browse([first]).wait();
    if (third !== undefined) await env.model('helpdesk.ticket').browse([third]).solve();
    await env.asSuperuser({ reason: 'demo helpdesk clock' }, (su) => refreshSla(su));
  });
  return 'Helpdesk: the Support team, two SLA policies, a canned reply, three tickets (waiting, urgent, solved).';
}
