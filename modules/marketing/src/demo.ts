/**
 * Campaigns' demo data (RFC 0008 §5.8): a newsletter list with a few subscribers — one who unsubscribed —, an
 * address nobody writes to, and a campaign drafted with two subjects to try.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const MITA = { login: 'mita', name: 'Mita Rahman', groups: ['marketing.manager'] } as const;

export async function marketingDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(MITA, async (raw) => {
    const env = raw as Env;
    const [newsletter] = (
      await env.model('marketing.list').create([
        {
          name: 'Newsletter',
          description: 'People who asked for our monthly news and offers.',
        },
      ])
    ).ids;
    if (newsletter === undefined) return;
    await env.model('marketing.subscriber').create([
      { list: newsletter, email: 'nadia@example.com', name: 'Nadia Karim' },
      { list: newsletter, email: 'tanvir@example.com', name: 'Tanvir Ahmed', language: 'bn' },
      { list: newsletter, email: 'sadia@example.com', name: 'Sadia Islam' },
      {
        list: newsletter,
        email: 'imran@example.com',
        name: 'Imran Hossain',
        state: 'unsubscribed',
        note: 'Asked by phone',
      },
    ]);
    await env
      .model('marketing.suppression')
      .create([{ email: 'legal@example.org', reason: 'complaint', note: 'Do not contact' }]);
    await env.model('marketing.campaign').create([
      {
        name: 'Winter offer',
        subject: '{{first_name|Hello}}, winter prices are here',
        subjectB: '15% off until Friday',
        preheader: 'Three days only, on everything in stock.',
        body: '<p>Dear {{name|customer}},</p><p>Until Friday, everything in stock is <strong>15% off</strong>.</p><p><a href="https://example.com/offers">See the offers</a></p>',
        lists: { set: [newsletter] },
      } as never,
    ]);
  });
  return 'Campaigns: a newsletter list with subscribers, a never-email address and a drafted campaign with two subjects';
}
