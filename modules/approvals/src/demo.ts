/**
 * Approvals' demo data (RFC 0008 §5.8): Rahim's business trip to the Sylhet farm, submitted and waiting for his
 * category's approvers, and a draft purchase request — so the inbox, My requests and the overview have something
 * to show.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const RAHIM = { login: 'rahim', name: 'Rahim Uddin', groups: ['base.user'] } as const;

export async function approvalsDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(RAHIM, async (raw) => {
    const env = raw as Env;
    const categories = await env
      .model('approval.category')
      .search({ where: { code: { in: ['TRIP', 'PR'] } } as never })
      .then((r) => r.load(['code']));
    const byCode = new Map([...categories].map((c) => [c.code, c.id]));
    const trip = byCode.get('TRIP');
    const purchase = byCode.get('PR');
    if (trip !== undefined) {
      const made = await env.model('approval.ask').create([
        {
          category: trip,
          title: 'Visit the Sylhet farm',
          description: 'Check the new sheds before the first flock arrives.',
          amount: '15000',
          dateFrom: ctx.date(7),
          dateTo: ctx.date(9),
          location: 'Sylhet',
        },
      ]);
      await env.model('approval.ask').browse(made.ids).submit();
    }
    if (purchase !== undefined)
      await env.model('approval.ask').create([
        {
          category: purchase,
          title: 'Feeders for shed 3',
          lines: {
            create: [
              { name: 'Feeder, 12 kg', quantity: '40', priceUnit: '650' },
              { name: 'Drinker, 8 l', quantity: '40', priceUnit: '420' },
            ],
          },
        },
      ]);
  });
  return 'Approvals: a business trip waiting for approval and a draft purchase request.';
}
