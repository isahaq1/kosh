/**
 * Appraisals' demo data (RFC 0008 §5.8): two kinds of skill with their levels, and an annual cycle left as a
 * draft — opening it makes an appraisal for everyone who has a manager.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const HASINA = { login: 'hasina', name: 'Hasina Akter', groups: ['hr_appraisal.manager'] } as const;

export async function hrAppraisalDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(HASINA, async (raw) => {
    const env = raw as Env;
    await env.model('hr.skill.type').create([
      {
        name: 'Languages',
        levels: {
          create: [
            { name: 'Basic', progress: 25 },
            { name: 'Working', progress: 60 },
            { name: 'Fluent', progress: 100 },
          ],
        },
        skills: { create: [{ name: 'English' }, { name: 'Bangla' }] },
      },
      {
        name: 'Office tools',
        levels: {
          create: [
            { name: 'Learning', progress: 30 },
            { name: 'Independent', progress: 70 },
            { name: 'Teaches others', progress: 100 },
          ],
        },
        skills: { create: [{ name: 'Spreadsheets' }, { name: 'Presentations' }] },
      },
    ] as never);
    const year = Number(String(ctx.date(0)).slice(0, 4));
    await env.model('hr.appraisal.cycle').create([
      {
        name: `Annual review ${year}`,
        dateFrom: `${year}-01-01`,
        dateTo: `${year}-12-31`,
        dateDue: ctx.date(30),
      },
    ] as never);
  });
  return 'Appraisals: two kinds of skill with their levels, and an annual cycle ready to open';
}
