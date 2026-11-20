/**
 * @packageDocumentation
 * `@kosh/survey` (RFC 0034 §2.6): the **Surveys** app, one engine for every questionnaire — customer feedback,
 * screening, an event's evaluation, a qualification form.
 *
 * - Questions of nine kinds; a question may wait for an earlier answer; choices and ratings score points.
 * - Answered by anyone with the link, or by invitations good once; named or anonymous.
 * - Responses with their score and whether they passed; NPS and CSAT; every question's answers counted.
 *
 * - `GET  /api/v1/public/surveys/:key/page`   the page a respondent fills (no sign-in; English or Bangla)
 * - `GET  /api/v1/public/surveys/:key`        the same survey as data, for a site that draws its own form
 * - `POST /api/v1/public/surveys/:key`        `{ answers: { [questionId]: … }, name?, email? }`
 * - `GET  /api/v1/surveys/:id/results`        each question with its count, average, NPS / CSAT and choices
 */
import { randomBytes } from 'node:crypto';
import { contacts } from '@kosh/contacts';
import { type Mailer, mailerFromEnv } from '@kosh/mail';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { action, form, list, pivot, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { surveyDemo } from './demo.js';
import {
  Survey,
  SurveyAnswer,
  SurveyChoice,
  SurveyInvitation,
  SurveyQuestion,
  SurveyResponse,
  SurveyTrigger,
  setTriggerCatalogue,
  submitSurvey,
  surveyPage,
  surveyResults,
  surveyShutro,
} from './module.js';
import { pageLanguage, pageSecurity, renderClosed, renderSurvey } from './page.js';
import { surveyWorkers, triggerCatalogue } from './workers.js';

export {
  type Answer,
  CONDITIONS,
  type ConditionOp,
  csat,
  maxScoreOf,
  nps,
  QUESTION_KINDS,
  type Question,
  type QuestionKind,
  type RawAnswer,
  type Review,
  review,
  visibleQuestions,
} from './engine.js';
export {
  fireTriggers,
  inviteAbout,
  type QuestionResult,
  refreshStats,
  type Submitted,
  Survey,
  SurveyAnswer,
  SurveyChoice,
  SurveyInvitation,
  type SurveyPage,
  SurveyQuestion,
  SurveyResponse,
  SurveyTrigger,
  setTriggerCatalogue,
  submitSurvey,
  surveyPage,
  surveyPath,
  surveyResults,
  surveyShutro,
  type TriggerCatalogue,
} from './module.js';
export { surveyWorkers, triggerCatalogue } from './workers.js';

const STATUS = { unknown: 404, closed: 410, used: 410 } as const;
const SAID = {
  unknown: 'This link does not open a survey.',
  closed: 'This survey is not taking answers.',
  used: 'This link was used already.',
} as const;

function registerSurveyRoutes(context: ModuleContext): void {
  const { app, shutro } = context;
  const pub = { config: { auth: false } };
  const keyOf = (params: unknown): string => String((params as { key?: unknown }).key ?? '');
  // A visitor has no rights of their own: the survey is read and answered as the system, by its key alone.
  const asSystem = <T>(reason: string, fn: (env: Env) => Promise<T>): Promise<T> =>
    shutro.bootstrap({ reason }, (env) => fn(env as unknown as Env));

  app.get('/api/v1/public/surveys/:key/page', pub, async (request, reply) => {
    const key = keyOf(request.params);
    const language = pageLanguage(
      (request.query as { lang?: unknown }).lang,
      request.headers['accept-language'],
    );
    const found = await asSystem('a survey shown', (env) => surveyPage(env, key));
    const nonce = randomBytes(16).toString('base64');
    void reply.type('text/html; charset=utf-8').headers(pageSecurity(nonce));
    if ('why' in found)
      return reply.code(STATUS[found.why]).send(renderClosed(found.why, language));
    return reply.send(
      renderSurvey(found.page, {
        post: `/api/v1/public/surveys/${encodeURIComponent(key)}`,
        language,
        nonce,
      }),
    );
  });

  app.get('/api/v1/public/surveys/:key', pub, async (request, reply) => {
    const found = await asSystem('a survey shown', (env) => surveyPage(env, keyOf(request.params)));
    if ('why' in found)
      throw new HttpProblem(STATUS[found.why], `survey-${found.why}`, 'No survey', SAID[found.why]);
    void reply.header('cache-control', 'no-store');
    return found.page;
  });

  app.post(
    '/api/v1/public/surveys/:key',
    { ...pub, bodyLimit: 256 * 1024 },
    async (request, reply) => {
      const body = request.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body))
        throw new HttpProblem(
          400,
          'invalid-body',
          'Invalid answers',
          'Send the answers as an object.',
        );
      const sent = body as { answers?: unknown; name?: unknown; email?: unknown };
      const answers = sent.answers;
      if (answers === null || typeof answers !== 'object' || Array.isArray(answers))
        throw new HttpProblem(
          400,
          'invalid-body',
          'Invalid answers',
          'Send `answers`: an object of answers by question id.',
        );
      const result = await asSystem('a survey answered', (env) =>
        submitSurvey(env, keyOf(request.params), {
          answers: answers as Record<string, unknown>,
          name: sent.name,
          email: sent.email,
        }),
      );
      if (result.ok) return reply.code(201).send({ thanks: result.thanks });
      if (result.why === 'invalid')
        return reply.code(422).send({
          type: 'https://kosh.dev/problems/survey-answers',
          title: 'Some answers need another look',
          status: 422,
          detail: result.errors.map((e) => `${e.title}: ${e.problem}`).join('; '),
          errors: result.errors,
        });
      throw new HttpProblem(
        STATUS[result.why],
        `survey-${result.why}`,
        'No survey',
        SAID[result.why],
      );
    },
  );

  const offered = triggerCatalogue(context.registry);
  setTriggerCatalogue(offered);
  app.addHook('onClose', async () => setTriggerCatalogue(null));
  app.get('/api/v1/surveys/events', async (request) =>
    request.env(async (raw) => {
      const env = raw as unknown as Env;
      if (!(env.administrator || env.groups.has('survey.user')))
        throw new HttpProblem(403, 'access', 'Surveys', 'This needs a role of Surveys.');
      return {
        events: offered.topics,
        created: 'Any model, as <model>.created (hiring.applicant.created).',
      };
    }),
  );

  app.get('/api/v1/surveys/:id/results', async (request) => {
    const id = Number((request.params as { id?: unknown }).id);
    if (!Number.isSafeInteger(id))
      throw new HttpProblem(400, 'bad-request', 'Which survey', 'Give the survey’s id.');
    return request.env(
      async (raw) => {
        const questions = await surveyResults(raw as unknown as Env, id);
        if (questions === null)
          throw new HttpProblem(404, 'missing-record', 'Not found', `There is no survey ${id}.`);
        return { questions };
      },
      { write: true },
    );
  });
}

export interface SurveyOptions {
  /** Sends the invitations (default: from the environment; none: links are copied by hand). */
  readonly mailer?: Mailer | undefined;
  /** The server's public address, for the links in emails (default: `KOSH_BASE_URL`). */
  readonly baseUrl?: string | undefined;
  /** Start the workers (default: unless `KOSH_SCHEDULES=off`). */
  readonly workers?: boolean | undefined;
}

/** Surveys with explicit options (tests: a memory mailer, workers drained by hand). */
export function surveyModule(options: SurveyOptions = {}): ReturnType<typeof defineModule> {
  const mailer = 'mailer' in options ? options.mailer : mailerFromEnv();
  const baseUrl = options.baseUrl ?? process.env['KOSH_BASE_URL'] ?? '';
  return defineModule({
    shutro: surveyShutro,
    kosh: '^0.1.0',
    hooks: { demo: surveyDemo },
    depends: [contacts, messaging, reporting],
    app: {
      code: 'surveys',
      label: 'Surveys',
      icon: 'surveys',
      sequence: 62,
      category: 'Marketing',
      summary: 'Questions with logic and scoring, answered by link or invitation, NPS and CSAT',
    },
    // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
    i18n: { bn: () => import('./i18n/bn.js') },
    accessLevels: {
      user: { label: 'User (invitations, responses and results)', groups: ['survey.user'] },
      manager: { label: 'Manager (writes surveys)', groups: ['survey.manager'] },
    },
    // Every record made is offered to the automatic invitations (and an invitation made is emailed).
    changeEvents: '*',
    routes: (context: ModuleContext) => {
      registerSurveyRoutes(context);
      if (!(options.workers ?? process.env['KOSH_SCHEDULES'] !== 'off')) return;
      const workers = surveyWorkers(
        {
          shutro: context.shutro,
          registry: context.registry,
          log: (message, error) => context.app.log.error({ err: error }, message),
        },
        { mailer, baseUrl },
      );
      for (const w of workers) w.start();
      context.app.addHook('onClose', async () => {
        for (const w of workers) await w.stop();
      });
    },
    // Exceptions to the module standard (RFC 0023), each with its reason.
    standard: {
      waive: [
        {
          rule: 'I1',
          model: 'survey.response',
          reason:
            'A response is what a respondent answered on the public page; there is nothing to import.',
        },
      ],
    },
    events: [
      { topic: 'survey.survey.opened', model: 'survey.survey', label: 'Survey opened' },
      { topic: 'survey.response.received', model: 'survey.response', label: 'Survey answered' },
    ],
    documents: [
      {
        key: 'survey_questions',
        name: 'Survey (its questions)',
        model: 'survey.survey',
        layout: {
          paper: 'A4',
          header: '{{company.name}}',
          footer: 'Page {{page}} of {{pages}}',
          blocks: [
            { kind: 'heading', id: 'title', text: '{{name}}', level: 1 },
            {
              kind: 'fields',
              id: 'what',
              items: [
                { label: 'Answered by', bind: 'audience' },
                { label: 'Responses', bind: 'responseCount' },
                { label: 'Average score %', bind: 'averagePercent' },
                { label: 'NPS', bind: 'npsScore' },
                { label: 'CSAT %', bind: 'csatScore' },
              ],
            },
            {
              kind: 'table',
              id: 'questions',
              bind: 'questions',
              columns: [
                { label: 'Question', bind: 'title' },
                { label: 'Answer', bind: 'kind' },
                { label: 'Required', bind: 'required' },
              ],
            },
          ],
        },
      },
      {
        key: 'survey_response',
        name: 'Survey response',
        model: 'survey.response',
        layout: {
          paper: 'A4',
          header: '{{company.name}}',
          footer: 'Page {{page}} of {{pages}}',
          blocks: [
            { kind: 'heading', id: 'title', text: '{{survey.name}}', level: 1 },
            {
              kind: 'fields',
              id: 'who',
              items: [
                { label: 'Who', bind: 'name' },
                { label: 'Answered at', bind: 'submittedAt' },
                { label: 'Score %', bind: 'percent' },
              ],
            },
            {
              kind: 'table',
              id: 'answers',
              bind: 'answers',
              columns: [
                { label: 'Question', bind: 'question.title' },
                { label: 'Answer', bind: 'display' },
                { label: 'Points', bind: 'score' },
              ],
            },
          ],
        },
      },
    ],
    importTemplates: [
      {
        key: 'survey',
        model: 'survey.survey',
        label: 'Surveys (with their questions)',
        columns: [
          { header: 'Name', field: 'name' },
          { header: 'Introduction', field: 'description' },
          { header: 'Answered by', field: 'audience' },
          { header: 'Anonymous', field: 'anonymous' },
          { header: 'Questions › Question', field: 'questions.title' },
          { header: 'Questions › Answer', field: 'questions.kind' },
          { header: 'Questions › Required', field: 'questions.required' },
        ],
      },
      {
        key: 'survey_invitation',
        model: 'survey.invitation',
        label: 'Survey invitations',
        columns: [
          { header: 'Survey', field: 'survey' },
          { header: 'Who', field: 'name' },
          { header: 'Email', field: 'email' },
        ],
      },
    ],
    // The Overview (RFC 0022 step 2): what is open, and what people say.
    overview: {
      cards: [
        {
          id: 'open',
          title: 'Open surveys',
          kind: 'kpi',
          model: 'survey.survey',
          measure: 'count',
          filter: { state: 'open' },
          w: 3,
        },
        {
          id: 'responses',
          title: 'Responses this month',
          kind: 'kpi',
          model: 'survey.response',
          measure: 'count',
          comparison: { field: 'submittedAt', mode: 'previous' },
          w: 3,
        },
        {
          id: 'waiting',
          title: 'Invitations not answered',
          kind: 'kpi',
          model: 'survey.invitation',
          measure: 'count',
          filter: { status: 'pending' },
          w: 3,
        },
        {
          id: 'score',
          title: 'Average score %',
          kind: 'kpi',
          model: 'survey.response',
          measure: 'avg:percent',
          w: 3,
        },
        {
          id: 'by_survey',
          title: 'Responses by survey',
          kind: 'chart',
          model: 'survey.response',
          measure: 'count',
          groupBy: 'survey',
          chart: 'bar',
          w: 6,
        },
        {
          id: 'by_month',
          title: 'Responses by month',
          kind: 'chart',
          model: 'survey.response',
          measure: 'count',
          groupBy: 'submittedAt:month',
          chart: 'line',
          w: 6,
        },
        {
          id: 'answers',
          title: 'Answers by question',
          kind: 'pivot',
          model: 'survey.answer',
          measure: 'count',
          groupBy: 'question',
          w: 12,
        },
      ],
    },
    actions: {
      'surveys.action_surveys': action(Survey, { label: 'Surveys', views: ['list', 'form'] }),
      'surveys.action_responses': action(SurveyResponse, {
        label: 'Responses',
        views: ['list', 'form', 'pivot'],
      }),
      'surveys.action_answers': action(SurveyAnswer, {
        label: 'Answers',
        views: ['pivot', 'list', 'form'],
      }),
      'surveys.action_invitations': action(SurveyInvitation, {
        label: 'Invitations',
        views: ['list', 'form'],
      }),
      'surveys.action_triggers': action(SurveyTrigger, {
        label: 'Automatic invitations',
        views: ['list', 'form'],
      }),
      'surveys.action_questions': action(SurveyQuestion, {
        label: 'Questions',
        views: ['list', 'form'],
      }),
      'surveys.action_choices': action(SurveyChoice, { label: 'Choices', views: ['list', 'form'] }),
    },
    menus: [
      { id: 'surveys.root', label: 'Surveys', app: 'surveys' },
      {
        id: 'surveys.surveys',
        parent: 'surveys.root',
        label: 'Surveys',
        action: 'surveys.action_surveys',
        sequence: 1,
      },
      {
        id: 'surveys.invitations',
        parent: 'surveys.root',
        label: 'Invitations',
        action: 'surveys.action_invitations',
        sequence: 2,
      },
      {
        id: 'surveys.responses',
        parent: 'surveys.root',
        label: 'Responses',
        action: 'surveys.action_responses',
        sequence: 3,
      },
      {
        id: 'surveys.triggers',
        parent: 'surveys.root',
        label: 'Automatic invitations',
        action: 'surveys.action_triggers',
        sequence: 5,
      },
      {
        id: 'surveys.answers',
        parent: 'surveys.root',
        label: 'Answers',
        action: 'surveys.action_answers',
        sequence: 4,
      },
    ],
    views: {
      'survey.survey.list': list(Survey, {
        columns: [
          'name',
          'audience',
          'responseCount',
          'averagePercent',
          'npsScore',
          'csatScore',
          'state',
        ],
        decorations: { neutral: { state: 'closed' }, success: { state: 'open' } },
      }),
      'survey.survey.form': form(Survey, (k) => ({
        header: {
          statusbar: 'state',
          buttons: [
            k.button('publish', { primary: true, label: 'Open' }),
            k.button('close', { label: 'Close' }),
            k.button('reopen', { label: 'Open again' }),
            k.button('redraft', { label: 'Back to draft' }),
          ],
        },
        sheet: [
          k.stats('related', [
            {
              id: 'survey_responses',
              label: 'Responses',
              model: SurveyResponse,
              where: { survey: { $record: 'id' } },
              action: 'surveys.action_responses',
            },
            {
              id: 'survey_invitations',
              label: 'Invitations',
              model: SurveyInvitation,
              where: { survey: { $record: 'id' } },
              action: 'surveys.action_invitations',
            },
          ]),
          k.group(
            'main',
            ['name', 'description', 'audience', 'anonymous', 'passPercent', 'thanks'],
            {
              description:
                'Write the questions while it is a draft, then open it: anyone with the link answers, or only the people invited — each with a link of their own, good once.',
            },
          ),
          k.lines('questions', [
            { field: 'sequence', id: 'question_sequence' },
            { field: 'title', id: 'question_title' },
            { field: 'kind', id: 'question_kind' },
            { field: 'required', id: 'question_required' },
            { field: 'scaleMax', id: 'question_scale' },
            { field: 'weight', id: 'question_weight' },
            { field: 'showWhenQuestion', id: 'question_when' },
            { field: 'showWhenOp', id: 'question_op' },
            { field: 'showWhenValue', id: 'question_value' },
          ]),
          k.group('share', ['link'], {
            label: 'Share',
            description: 'Add this to your server’s address. An invitation has a link of its own.',
          }),
          k.group('results', ['responseCount', 'averagePercent', 'npsScore', 'csatScore'], {
            label: 'Results',
          }),
        ],
        chatter: true,
      })),
      'survey.question.list': list(SurveyQuestion, {
        columns: ['survey', 'sequence', 'title', 'kind', 'required'],
      }),
      'survey.question.form': form(SurveyQuestion, (k) => ({
        header: { buttons: [] },
        sheet: [
          k.group('main', ['survey', 'sequence', 'title', 'help', 'kind', 'required']),
          k.group('scoring', ['scaleMax', 'weight'], {
            label: 'Rating and points',
            description:
              'A rating has so many stars; a rating or a recommendation scores its value times the points per step. Choices have points of their own.',
          }),
          k.lines('choices', [
            { field: 'sequence', id: 'choice_sequence' },
            { field: 'label', id: 'choice_label' },
            { field: 'score', id: 'choice_score' },
          ]),
          k.group('logic', ['showWhenQuestion', 'showWhenOp', 'showWhenValue'], {
            label: 'Asked only when',
            description:
              'An earlier question, a condition and a value — a number, yes or no, text, or a choice by its label. Empty: always asked.',
          }),
        ],
      })),
      'survey.choice.list': list(SurveyChoice, {
        columns: ['question', 'sequence', 'label', 'score'],
      }),
      'survey.choice.form': form(SurveyChoice, (k) => ({
        header: { buttons: [] },
        sheet: [k.group('main', ['question', 'sequence', 'label', 'score'])],
      })),
      'survey.invitation.list': list(SurveyInvitation, {
        columns: ['survey', 'name', 'email', 'status', 'sentAt', 'answeredAt', 'link'],
        quickAdd: ['survey', 'name', 'email'],
        decorations: { success: { status: 'answered' } },
      }),
      'survey.invitation.form': form(SurveyInvitation, (k) => ({
        header: { buttons: [] },
        sheet: [
          k.group('main', ['survey', 'name', 'email', 'lang', 'partner'], {
            description:
              'Send them their link: it opens the survey for them once. On an anonymous survey the answers are not tied to the invitation.',
          }),
          k.group('answer', ['link', 'status', 'sentAt', 'answeredAt', 'trigger'], {
            label: 'Their link',
          }),
        ],
      })),
      'survey.trigger.list': list(SurveyTrigger, {
        columns: ['name', 'topic', 'each', 'survey', 'lastError'],
        decorations: { danger: { lastError: { isNull: false } } },
      }),
      'survey.trigger.form': form(SurveyTrigger, (k) => ({
        header: { buttons: [] },
        sheet: [
          k.group('main', ['name', 'survey', 'topic', 'each', 'whenField', 'whenValue'], {
            description:
              'When this happens in another app, the people concerned are invited to the survey — once each — and emailed their link. Ticket solved: helpdesk.ticket.solved. After an event, those who came: event.event.ended, for each of registrations, only when state is attended. A new applicant: hiring.applicant.created.',
          }),
          k.group('who', ['nameField', 'emailField', 'partnerField', 'langField'], {
            label: 'Who is asked',
            description: 'The fields of the record — or of each row — that say who the person is.',
          }),
          k.group('back', ['answerQuestion', 'answerField', 'lastError'], {
            label: 'An answer on the record',
            description:
              'Optional: a rating of the survey written into a number field of the record, such as a ticket’s rating.',
          }),
        ],
        chatter: true,
      })),
      'survey.response.list': list(SurveyResponse, {
        columns: [
          'survey',
          'name',
          'email',
          'submittedAt',
          'score',
          'maxScore',
          'percent',
          'outcome',
        ],
        decorations: { danger: { outcome: 'failed' }, success: { outcome: 'passed' } },
      }),
      'survey.response.form': form(SurveyResponse, (k) => ({
        header: { buttons: [] },
        sheet: [
          k.group('main', ['survey', 'name', 'email', 'partner', 'invitation', 'submittedAt']),
          k.group('scored', ['score', 'maxScore', 'percent', 'outcome'], { label: 'Score' }),
          k.lines(
            'answers',
            [
              { field: 'question', id: 'answer_question' },
              { field: 'display', id: 'answer_display' },
              { field: 'score', id: 'answer_score', sum: true },
            ],
            { readonlyWhen: {} },
          ),
        ],
      })),
      'survey.response.pivot': pivot(SurveyResponse, {
        rows: ['survey'],
        cols: ['submittedAt:month'],
        measures: ['count', { avg: 'percent' }],
      }),
      'survey.answer.pivot': pivot(SurveyAnswer, {
        rows: ['question', 'display'],
        cols: [],
        measures: ['count'],
      }),
      'survey.answer.list': list(SurveyAnswer, {
        columns: ['survey', 'question', 'display', 'score', 'response'],
      }),
      'survey.answer.form': form(SurveyAnswer, (k) => ({
        header: { buttons: [] },
        sheet: [
          k.group('main', ['survey', 'response', 'question', 'display', 'valueText', 'score']),
        ],
      })),
    },
    search: {
      'survey.survey': search(Survey, {
        fields: ['name'],
        filters: {
          open: { label: 'Open', domain: { state: 'open' }, group: 'state' },
          draft: { label: 'Draft', domain: { state: 'draft' }, group: 'state' },
          closed: { label: 'Closed', domain: { state: 'closed' }, group: 'state' },
        },
        groupBy: ['state', 'audience'],
      }),
      'survey.question': search(SurveyQuestion, {
        fields: ['title', 'survey.name'],
        groupBy: ['survey', 'kind'],
      }),
      'survey.choice': search(SurveyChoice, { fields: ['label'], groupBy: ['question'] }),
      'survey.invitation': search(SurveyInvitation, {
        fields: ['name', 'email', 'survey.name'],
        filters: {
          pending: { label: 'Not answered', domain: { status: 'pending' }, group: 'status' },
          answered: { label: 'Answered', domain: { status: 'answered' }, group: 'status' },
        },
        groupBy: ['survey', 'status'],
      }),
      'survey.trigger': search(SurveyTrigger, {
        fields: ['name', 'topic'],
        filters: { failing: { label: 'With a problem', domain: { lastError: { isNull: false } } } },
        groupBy: ['survey', 'topic'],
      }),
      'survey.response': search(SurveyResponse, {
        fields: ['name', 'email', 'survey.name'],
        filters: {
          passed: { label: 'Passed', domain: { outcome: 'passed' }, group: 'outcome' },
          failed: { label: 'Did not pass', domain: { outcome: 'failed' }, group: 'outcome' },
        },
        groupBy: ['survey', 'submittedAt:month', 'outcome'],
      }),
      'survey.answer': search(SurveyAnswer, {
        fields: ['display', 'question.title'],
        groupBy: ['survey', 'question', 'display'],
      }),
    },
  });
}

export const survey: ReturnType<typeof defineModule> = surveyModule();
