/**
 * Knowledge's demo data (RFC 0008 §5.8): a company handbook for everyone with two articles inside, and a sales
 * playbook for its members.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const NAFISA = { login: 'nafisa', name: 'Nafisa Haque', groups: ['knowledge.manager'] } as const;

export async function knowledgeDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(NAFISA, async (raw) => {
    const env = raw as Env;
    const [handbook] = (
      await env.model('knowledge.article').create([
        {
          name: 'Company handbook',
          icon: '📘',
          visibility: 'company',
          body: '<p>How we work: who to ask, where things are, and what to do when.</p>',
        },
      ] as never)
    ).ids;
    if (handbook === undefined) return;
    await env.model('knowledge.article').create([
      {
        name: 'Leave and holidays',
        icon: '🌴',
        parent: handbook,
        visibility: 'company',
        sequence: 1,
        body: '<h2>Asking for leave</h2><p>Ask in <strong>Workforce › Leave</strong> at least three working days ahead. Your leave approver decides; you are told by email.</p><ul><li>Casual leave: 10 days a year</li><li>Sick leave: 14 days a year</li></ul>',
      },
      {
        name: 'Expense claims',
        icon: '🧾',
        parent: handbook,
        visibility: 'company',
        sequence: 2,
        body: '<p>Photograph every receipt in <strong>Spend</strong> the day you pay. Reports are approved by your manager and paid with the next salary.</p>',
      },
      {
        name: 'Sales playbook',
        icon: '🎯',
        visibility: 'members',
        body: '<p>Qualify in the first call: budget, decision maker, need, timing. Quote within 24 hours.</p>',
      },
    ] as never);
  });
  return 'Knowledge: a company handbook with two articles inside, and a sales playbook for its members';
}
