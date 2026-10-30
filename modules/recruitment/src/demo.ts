/**
 * Hiring's demo data (RFC 0008 §5.8): Dina's opening for an accountant with three applicants across the stages, and
 * a scorecard for the one in interview.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import { idByName } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['hiring.manager'] } as const;

export async function recruitmentDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const stage = (name: string) => idByName(env as never, 'hiring.stage', name) as Promise<never>;
    const opening = (
      await env.model('hiring.opening').create([{ name: 'Accountant', headcount: 2 }])
    ).ids[0];
    if (opening === undefined) return;
    const applicants = await env.model('hiring.applicant').create([
      {
        name: 'Nusrat Jahan',
        email: 'nusrat@example.test',
        opening,
        stage: await stage('Interview'),
        source: 'linkedin',
      },
      {
        name: 'Arif Hossain',
        email: 'arif@example.test',
        opening,
        stage: await stage('Screening'),
        source: 'referral',
      },
      {
        name: 'Tania Akter',
        email: 'tania@example.test',
        opening,
        stage: await stage('New'),
        source: 'website',
      },
    ]);
    const first = applicants.ids[0];
    if (first !== undefined)
      await env.model('hiring.scorecard').create([
        {
          applicant: first,
          score: 4,
          recommendation: 'yes',
          notes: 'Strong on VAT and reconciliations.',
        },
      ]);
  });
  return 'Hiring: an opening with 3 applicants.';
}
