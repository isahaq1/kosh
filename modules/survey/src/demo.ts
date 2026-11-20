/**
 * Surveys' demo data (RFC 0008 §5.8): a customer feedback survey that is open — a recommendation question whose
 * low answers ask why, a rating, a choice —, with invitations and a handful of responses, so the overview and the
 * results have something to show; and a screening questionnaire with points, still a draft.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';
import { submitSurvey } from './module.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['survey.manager'] } as const;

export async function surveyDemo(ctx: DemoContext): Promise<string> {
  const feedback = await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const made = await env.model('survey.survey').create([
      {
        name: 'How was your delivery?',
        description: 'Three questions, a minute of your time.',
        thanks: 'Thank you — we read every answer.',
        questions: {
          create: [
            {
              sequence: 10,
              title: 'Would you recommend us to a friend?',
              kind: 'nps',
              required: true,
            },
            { sequence: 30, title: 'How do you rate the delivery?', kind: 'rating', scaleMax: 5 },
            {
              sequence: 40,
              title: 'How did you hear about us?',
              kind: 'choice',
              choices: {
                create: [
                  { sequence: 10, label: 'A friend' },
                  { sequence: 20, label: 'Facebook' },
                  { sequence: 30, label: 'A shop' },
                ],
              },
            },
          ],
        },
      },
      {
        name: 'Screening: sales officer',
        description: 'A few questions before the interview.',
        audience: 'invited',
        passPercent: 60,
        questions: {
          create: [
            {
              sequence: 10,
              title: 'Years of sales experience',
              kind: 'choice',
              required: true,
              choices: {
                create: [
                  { sequence: 10, label: 'None', score: '0' },
                  { sequence: 20, label: 'One to three', score: '5' },
                  { sequence: 30, label: 'More than three', score: '10' },
                ],
              },
            },
            {
              sequence: 20,
              title: 'How comfortable are you with spreadsheets?',
              kind: 'rating',
              scaleMax: 5,
              weight: '2',
            },
            { sequence: 30, title: 'Why this job?', kind: 'long_text' },
          ],
        },
      },
    ] as never);
    const [first] = await made.load({ questions: { choices: true } });
    if (first === undefined) return null;
    const recommend = [...first.questions].find((q) => q.kind === 'nps');
    // Asked only of those who would not recommend us.
    if (recommend !== undefined)
      await env.model('survey.question').create([
        {
          survey: first.id,
          sequence: 20,
          title: 'What went wrong?',
          kind: 'long_text',
          required: true,
          showWhenQuestion: recommend.id,
          showWhenOp: 'lt',
          showWhenValue: '7',
        },
      ] as never);
    await env.model('survey.survey').browse([first.id]).publish();
    await env.model('survey.invitation').create([
      { survey: first.id, name: 'Meghna Textiles', email: 'accounts@meghna.example' },
      { survey: first.id, name: 'Padma Foods', email: 'office@padma.example' },
    ] as never);
    const loaded = await env
      .model('survey.survey')
      .browse([first.id])
      .load({ questions: { choices: true } });
    const survey = [...loaded][0];
    if (survey === undefined) return null;
    const by = (kind: string) => [...survey.questions].find((q) => q.kind === kind);
    const heard = by('choice');
    return {
      token: survey.token,
      recommend: by('nps')?.id as number,
      why: by('long_text')?.id as number,
      rating: by('rating')?.id as number,
      heard: heard?.id as number,
      choices: [...(heard?.choices ?? [])].map((c) => c.id as number),
    };
  });
  if (feedback === null) return '2 surveys';
  // Answers, as visitors would send them.
  const answers: readonly [number, number, number, string?][] = [
    [10, 5, 0],
    [9, 5, 1],
    [9, 4, 0],
    [8, 4, 2],
    [6, 3, 1, 'The parcel came two days late.'],
    [3, 2, 0, 'Nobody answered the phone.'],
  ];
  await ctx.system('demo survey responses', async (raw) => {
    for (const [recommend, rating, heard, why] of answers)
      await submitSurvey(raw as Env, feedback.token, {
        answers: {
          [feedback.recommend]: recommend,
          [feedback.rating]: rating,
          [feedback.heard]: feedback.choices[heard],
          ...(why === undefined ? {} : { [feedback.why]: why }),
        },
        name: 'A customer',
      });
  });
  return '2 surveys (one open), 2 invitations, 6 responses';
}
