/**
 * The data layer of Surveys (RFC 0034 §2.6): a **survey** of **questions** — text, numbers, yes / no, choices with
 * points, ratings, the 0-to-10 recommendation question, dates —, each of which may wait for an earlier answer;
 * answered by anyone who has its link or only by **invitations**, each good once; named or anonymous. A
 * **response** keeps its answers, its score against what the respondent was asked, and whether it passed; the
 * survey keeps its count, its average, its NPS and its CSAT.
 *
 * The rules are in `engine.ts`; here are the models, what the public page is given, and what it may send back.
 */
import { randomBytes } from 'node:crypto';
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { emitting } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  records,
} from './.kosh/bindings.js';
import {
  type ConditionOp,
  csat,
  nps,
  type Question,
  type QuestionKind,
  type RawAnswer,
  review,
} from './engine.js';

/**
 * Fields the server maintains: written by its own code (as the system) and by Administrators only. An empty list
 * would mean *everyone* — Shutro reads no groups as no restriction.
 */
const SYSTEM = ['base.admin'] as const;

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const token = (): string => randomBytes(18).toString('base64url');
/** Where a survey is answered, for a token. */
export const surveyPath = (value: string): string => `/api/v1/public/surveys/${value}/page`;
const hundredths = (value: unknown): number =>
  value === null || value === undefined
    ? 0
    : Number(
        orm
          .toDecimal(value as never)
          .times(100)
          .toDecimalPlaces(0)
          .toString(),
      );

const KINDS = {
  text: 'A line of text',
  long_text: 'A paragraph',
  number: 'A number',
  yes_no: 'Yes or no',
  choice: 'One of several choices',
  choices: 'Several choices',
  rating: 'A rating (stars)',
  nps: 'Would you recommend us? (0 to 10)',
  date: 'A date',
} as const;

const OPS = {
  eq: 'is',
  ne: 'is not',
  gt: 'is more than',
  lt: 'is less than',
  answered: 'is answered',
} as const;

export const Survey = defineModel('survey.survey', {
  label: 'Survey',
  recName: 'name',
  order: ['id desc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['state', 'audience', 'anonymous'],
  access: { 'survey.user': READ, 'survey.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true }),
    description: f.text({
      label: 'Introduction',
      help: 'Shown above the questions: what it is for, how long it takes.',
    }),
    audience: f.selection(
      { link: 'Anyone with the link', invited: 'Invited people only' },
      {
        required: true,
        default: 'link',
        label: 'Answered by',
        help: 'Anyone with the link: the same address for everyone, answered any number of times. Invited people only: each invitation has its own address, good once.',
      },
    ),
    anonymous: f.boolean({
      default: false,
      label: 'Anonymous',
      help: 'Nothing that names the respondent is kept: no name, no email, no contact, no invitation — an invitation is only marked as answered.',
    }),
    passPercent: f.integer({
      label: 'Pass mark %',
      help: 'With points: a response at or above this share of what it could score passes; empty: no pass or fail.',
    }),
    thanks: f.text({
      label: 'After answering',
      help: 'What the respondent reads once their answers are in.',
    }),
    token: f.char({
      size: 40,
      required: true,
      default: token,
      label: 'Link key',
      groups: { write: [...SYSTEM] },
    }),
    link: f.char({
      store: true,
      label: 'Public link',
      help: 'The address of the survey on this server, for an open survey answered by anyone with the link.',
      ...compute('survey.survey', 'link', ['token'], (surveys) => {
        for (const s of surveys) s.link = surveyPath(s.token);
      }),
    }),
    questions: f.one2many('survey.question', 'survey'),
    invitations: f.one2many('survey.invitation', 'survey'),
    responseCount: f.integer({ label: 'Responses', groups: { write: [...SYSTEM] } }),
    averagePercent: f.decimal({
      scale: 1,
      label: 'Average score %',
      groups: { write: [...SYSTEM] },
      help: 'The average of the responses’ scores, each as a share of what it could score.',
    }),
    npsScore: f.integer({
      label: 'NPS',
      groups: { write: [...SYSTEM] },
      help: 'From the recommendation questions: promoters (9 and 10) less detractors (0 to 6), in percent, from −100 to 100.',
    }),
    csatScore: f.integer({
      label: 'CSAT %',
      groups: { write: [...SYSTEM] },
      help: 'From the rating questions: the share of ratings in the top two fifths of their scale.',
    }),
    state: f.state({
      states: { draft: 'Draft', open: 'Open', closed: 'Closed' },
      initial: 'draft',
      help: 'Draft while it is written; open while it takes answers; closed after.',
      transitions: {
        publish: emitting('survey.survey.opened', {
          from: ['draft'],
          to: 'open',
          guard: records('survey.survey', (surveys) =>
            unready(surveys.env as unknown as Env, surveys.ids as readonly number[]),
          ),
          message:
            'A survey opens with at least one question; a choice question has choices; a question waits only for one before it, on a value that exists.',
        }),
        close: { from: ['open'], to: 'closed' },
        reopen: { from: ['closed'], to: 'open' },
        redraft: {
          from: ['open', 'closed'],
          to: 'draft',
          guard: records('survey.survey', (surveys) =>
            answered(surveys.env as unknown as Env, surveys.ids as readonly number[]),
          ),
          message:
            'It has responses: its questions stay as they were answered. Duplicate it to change them.',
        },
      },
    }),
  },
  sqlConstraints: {
    passMark: {
      check: orm.sql`pass_percent IS NULL OR pass_percent BETWEEN 0 AND 100`,
      message: 'A pass mark is from 0 to 100.',
    },
  },
});

export const SurveyQuestion = defineModel('survey.question', {
  label: 'Question',
  recName: 'title',
  order: ['survey asc', 'sequence asc', 'id asc'],
  companyScoped: { required: true },
  access: { 'survey.user': READ, 'survey.manager': ALL },
  fields: {
    survey: f.many2one('survey.survey', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    sequence: f.integer({ required: true, default: 10 }),
    title: f.char({ required: true, label: 'Question' }),
    help: f.char({ label: 'Hint' }),
    kind: f.selection(KINDS, {
      required: true,
      default: 'text',
      label: 'Answer',
      help: 'What the answer is: text, a number, yes or no, one or several choices, a rating, the 0-to-10 recommendation question, a date.',
    }),
    required: f.boolean({ default: false }),
    scaleMax: f.integer({
      required: true,
      default: 5,
      label: 'Stars',
      help: 'The top of a rating’s scale, 2 to 10.',
    }),
    weight: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Points per step',
      help: 'A rating or a recommendation scores its value times this; 0: it does not count in the score.',
    }),
    choices: f.one2many('survey.choice', 'question'),
    showWhenQuestion: f.many2one('survey.question', {
      ondelete: 'set null',
      label: 'Only when',
      help: 'An earlier question: this one is asked only when its answer meets the condition.',
    }),
    showWhenOp: f.selection(OPS, {
      label: 'Condition',
      help: 'How the earlier answer is compared with the value.',
    }),
    showWhenValue: f.char({
      label: 'Value',
      help: 'A number, yes or no, text, or a choice by its label.',
    }),
  },
  sqlConstraints: {
    scale: { check: orm.sql`scale_max BETWEEN 2 AND 10`, message: 'A rating has 2 to 10 stars.' },
  },
  constraints: {
    draftOnly: {
      ...check(
        'survey.question',
        ['survey', 'kind', 'scaleMax', 'weight', 'showWhenQuestion', 'showWhenOp', 'showWhenValue'],
        (questions) =>
          fixedQuestions(questions.env as unknown as Env, questions.ids as readonly number[]),
      ),
      message: 'The questions of a survey are changed while it is a draft.',
    },
  },
});

export const SurveyChoice = defineModel('survey.choice', {
  label: 'Choice',
  recName: 'label',
  order: ['question asc', 'sequence asc', 'id asc'],
  companyScoped: { required: true },
  access: { 'survey.user': READ, 'survey.manager': ALL },
  fields: {
    question: f.many2one('survey.question', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    sequence: f.integer({ required: true, default: 10 }),
    label: f.char({ required: true }),
    score: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Points',
      help: 'What choosing it scores; below zero takes points away.',
    }),
  },
});

/** One person asked to answer, with an address of their own, good once. */
export const SurveyInvitation = defineModel('survey.invitation', {
  label: 'Survey invitation',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  access: {
    'survey.user': ['read', 'create', 'unlink'],
    'survey.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    survey: f.many2one('survey.survey', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    name: f.char({ required: true, label: 'Who' }),
    email: f.char({ label: 'Email' }),
    partner: f.many2one('res.partner', { ondelete: 'set null', label: 'Contact' }),
    /** The record the answers are about (a ticket, an applicant, a registration): set by the app that asks. */
    resModel: f.char({ size: 80, label: 'About (model)' }),
    resId: f.integer({ label: 'About (record)' }),
    token: f.char({
      size: 40,
      required: true,
      default: token,
      label: 'Link key',
      groups: { write: [...SYSTEM] },
    }),
    link: f.char({
      store: true,
      label: 'Their link',
      help: 'The address to send them: it opens the survey for them, once.',
      ...compute('survey.invitation', 'link', ['token'], (invitations) => {
        for (const i of invitations) i.link = surveyPath(i.token);
      }),
    }),
    status: f.selection(
      { pending: 'Not answered', answered: 'Answered' },
      {
        required: true,
        default: 'pending',
        groups: { write: [...SYSTEM] },
        help: 'Answered: the link was used, and opens nothing more.',
      },
    ),
    answeredAt: f.datetime({ label: 'Answered at', groups: { write: [...SYSTEM] } }),
    lang: f.selection(
      { en: 'English', bn: 'Bangla' },
      {
        required: true,
        default: 'en',
        label: 'Language',
        help: 'The language of the email, and of the page its link opens.',
      },
    ),
    sentAt: f.datetime({
      label: 'Emailed at',
      groups: { write: [...SYSTEM] },
      help: 'An invitation with an email address is emailed once, when its survey is open.',
    }),
    trigger: f.many2one('survey.trigger', {
      ondelete: 'set null',
      label: 'Asked by',
      groups: { write: [...SYSTEM] },
    }),
  },
});

/** What someone answered: made by the server from the public page, never through the API. */
export const SurveyResponse = defineModel('survey.response', {
  label: 'Survey response',
  order: ['id desc'],
  companyScoped: { required: true },
  access: { 'survey.user': ['read', 'export'], 'survey.manager': ['read', 'unlink', 'export'] },
  fields: {
    survey: f.many2one('survey.survey', { required: true, ondelete: 'cascade' }),
    invitation: f.many2one('survey.invitation', { ondelete: 'set null' }),
    partner: f.many2one('res.partner', { ondelete: 'set null', label: 'Contact' }),
    name: f.char({ label: 'Who' }),
    email: f.char({ label: 'Email' }),
    resModel: f.char({ size: 80, label: 'About (model)' }),
    resId: f.integer({ label: 'About (record)' }),
    submittedAt: f.datetime({ required: true, label: 'Answered at' }),
    score: f.decimal({ scale: 2, label: 'Score' }),
    maxScore: f.decimal({ scale: 2, label: 'Of' }),
    percent: f.decimal({
      scale: 1,
      label: 'Score %',
      help: 'The score as a share of what the questions this respondent was asked could give.',
    }),
    outcome: f.selection(
      { passed: 'Passed', failed: 'Did not pass' },
      {
        label: 'Outcome',
        help: 'Against the survey’s pass mark; empty when it has none, or when nothing asked could score.',
      },
    ),
    answers: f.one2many('survey.answer', 'response'),
  },
});

export const SurveyAnswer = defineModel('survey.answer', {
  label: 'Answer',
  recName: 'display',
  order: ['response desc', 'id asc'],
  companyScoped: { required: true },
  access: { 'survey.user': ['read', 'export'], 'survey.manager': ['read', 'export'] },
  fields: {
    response: f.many2one('survey.response', { required: true, ondelete: 'cascade' }),
    survey: f.many2one('survey.survey', { required: true, ondelete: 'cascade' }),
    question: f.many2one('survey.question', { required: true, ondelete: 'cascade' }),
    valueText: f.text({ label: 'Text' }),
    valueNumber: f.decimal({ scale: 2, label: 'Number' }),
    choices: f.many2many('survey.choice', { label: 'Chosen' }),
    display: f.char({ label: 'Answer' }),
    score: f.decimal({ scale: 2, label: 'Points' }),
  },
});

// ---- what a survey is, to the engine and to the page

interface Loaded {
  readonly id: number;
  readonly company: number;
  readonly name: string;
  readonly description: string | null;
  readonly thanks: string | null;
  readonly state: string;
  readonly audience: string;
  readonly anonymous: boolean;
  readonly passPercent: number | null;
  readonly token: string;
  readonly questions: readonly (Question & {
    readonly title: string;
    readonly help: string | null;
    readonly labels: ReadonlyMap<number, string>;
    /** A condition that names a value its question cannot give. */
    readonly broken: boolean;
  })[];
}

async function load(su: Env, id: number): Promise<Loaded | null> {
  const [s] = await su
    .model('survey.survey')
    .browse([id as never])
    .load({ company: true, questions: { choices: true, showWhenQuestion: true } });
  if (s === undefined) return null;
  const ordered = [...s.questions].sort(
    (a, b) => a.sequence - b.sequence || (a.id as number) - (b.id as number),
  );
  const byId = new Map(ordered.map((q) => [q.id as number, q]));
  const questions = ordered.map((q, index) => {
    const choices = [...q.choices].sort(
      (a, b) => a.sequence - b.sequence || (a.id as number) - (b.id as number),
    );
    let showWhen: Question['showWhen'] = null;
    let broken = false;
    if (q.showWhenQuestion !== null) {
      const target = byId.get(q.showWhenQuestion.id as number);
      const before = ordered.findIndex((x) => x.id === q.showWhenQuestion?.id);
      const op = (q.showWhenOp ?? 'answered') as ConditionOp;
      let value = (q.showWhenValue ?? '').trim();
      if (target === undefined || before < 0 || before >= index) broken = true;
      else if (op !== 'answered') {
        if (target.kind === 'choice' || target.kind === 'choices') {
          // A choice is named by its label; the engine compares ids.
          const named = [...target.choices].find(
            (c) => c.label.trim().toLowerCase() === value.toLowerCase(),
          );
          if (named === undefined) broken = true;
          else value = String(named.id);
        } else if (target.kind === 'yes_no') {
          value = value.toLowerCase();
          if (value !== 'yes' && value !== 'no') broken = true;
        } else if ((op === 'gt' || op === 'lt') && !Number.isFinite(Number(value))) broken = true;
        else if (value === '') broken = true;
      }
      showWhen = { question: q.showWhenQuestion.id as number, op, value };
    }
    return {
      id: q.id as number,
      kind: q.kind as QuestionKind,
      required: q.required === true,
      scaleMax: q.scaleMax,
      weight: hundredths(q.weight),
      choices: choices.map((c) => ({ id: c.id as number, score: hundredths(c.score) })),
      showWhen,
      title: q.title,
      help: q.help,
      labels: new Map(choices.map((c) => [c.id as number, c.label])),
      broken,
    };
  });
  return {
    id: s.id as number,
    company: s.company.id as number,
    name: s.name,
    description: s.description,
    thanks: s.thanks,
    state: s.state,
    audience: s.audience,
    anonymous: s.anonymous === true,
    passPercent: s.passPercent,
    token: s.token,
    questions,
  };
}

/** The surveys among `ids` that cannot open: no question, a choice question without choices, a broken condition. */
async function unready(env: Env, ids: readonly number[]): Promise<number[]> {
  return env.asSuperuser({ reason: 'a survey opened' }, async (su) => {
    const out: number[] = [];
    for (const id of ids) {
      const s = await load(su, id);
      if (
        s === null ||
        s.questions.length === 0 ||
        s.questions.some(
          (q) =>
            q.broken || ((q.kind === 'choice' || q.kind === 'choices') && q.choices.length === 0),
        )
      )
        out.push(id);
    }
    return out;
  });
}

/** The surveys among `ids` that have responses. */
async function answered(env: Env, ids: readonly number[]): Promise<number[]> {
  return env.asSuperuser({ reason: 'a survey with responses' }, async (su) => {
    const out: number[] = [];
    for (const id of ids)
      if (
        (await su.model('survey.response').search({ where: { survey: id as never }, limit: 1 }))
          .length > 0
      )
        out.push(id);
    return out;
  });
}

/** The questions among `ids` whose survey is no longer a draft. */
async function fixedQuestions(env: Env, ids: readonly number[]): Promise<number[]> {
  const rows = await env.asSuperuser({ reason: 'the questions of an open survey' }, async (su) =>
    (
      await su
        .model('survey.question')
        .browse([...ids] as never)
        .load({ survey: true })
    ).map((q) => ({ id: q.id as number, state: q.survey.state })),
  );
  return rows.filter((r) => r.state !== 'draft').map((r) => r.id);
}

/** What the public page is given: the questions as they are asked, never the points. */
export interface SurveyPage {
  readonly name: string;
  readonly description: string | null;
  readonly anonymous: boolean;
  /** Asked of whoever comes by the survey's own link, unless it is anonymous. */
  readonly askWho: boolean;
  readonly questions: readonly {
    readonly id: number;
    readonly title: string;
    readonly help: string | null;
    readonly kind: QuestionKind;
    readonly required: boolean;
    readonly scaleMax: number;
    readonly choices: readonly { readonly id: number; readonly label: string }[];
    readonly showWhen: Question['showWhen'];
  }[];
}

export type Opened =
  | { readonly ok: true; readonly survey: Loaded; readonly invitation: number | null }
  | { readonly ok: false; readonly why: 'unknown' | 'closed' | 'used' };

/** What a link key opens: a survey by its own link, or by an invitation that was not used yet. */
async function open(su: Env, key: string): Promise<Opened> {
  if (key.length < 20 || key.length > 40) return { ok: false, why: 'unknown' };
  const all = su.withFlags({ checkCompany: false }) as Env;
  const [invited] = await all
    .model('survey.invitation')
    .search({ where: { token: key } as never, limit: 1 })
    .then((found) => found.load({ survey: true }));
  if (invited !== undefined) {
    if (invited.status !== 'pending') return { ok: false, why: 'used' };
    const survey = await load(all, invited.survey.id as number);
    if (survey === null || survey.state !== 'open') return { ok: false, why: 'closed' };
    return { ok: true, survey, invitation: invited.id as number };
  }
  const [direct] = await all
    .model('survey.survey')
    .search({ where: { token: key } as never, limit: 1 });
  if (direct === undefined) return { ok: false, why: 'unknown' };
  const survey = await load(all, direct.id as number);
  if (survey === null || survey.state !== 'open') return { ok: false, why: 'closed' };
  // Invited people only: the survey's own link opens nothing.
  if (survey.audience !== 'link') return { ok: false, why: 'unknown' };
  return { ok: true, survey, invitation: null };
}

/** The page of a link key, or why there is none. */
export async function surveyPage(
  env: Env,
  key: string,
): Promise<{ readonly page: SurveyPage } | { readonly why: 'unknown' | 'closed' | 'used' }> {
  return env.asSuperuser({ reason: 'a survey shown' }, async (su) => {
    const opened = await open(su, key);
    if (!opened.ok) return { why: opened.why };
    const s = opened.survey;
    return {
      page: {
        name: s.name,
        description: s.description,
        anonymous: s.anonymous,
        askWho: !s.anonymous && opened.invitation === null,
        questions: s.questions.map((q) => ({
          id: q.id,
          title: q.title,
          help: q.help,
          kind: q.kind,
          required: q.required,
          scaleMax: q.scaleMax,
          choices: q.choices.map((c) => ({ id: c.id, label: q.labels.get(c.id) ?? '' })),
          showWhen: q.showWhen,
        })),
      },
    };
  });
}

export type Submitted =
  | { readonly ok: true; readonly response: number; readonly thanks: string | null }
  | { readonly ok: false; readonly why: 'unknown' | 'closed' | 'used' }
  | {
      readonly ok: false;
      readonly why: 'invalid';
      readonly errors: readonly {
        readonly question: number;
        readonly title: string;
        readonly problem: string;
      }[];
    };

const clip = (value: unknown, size: number): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, size) : null;

/**
 * Takes a respondent's answers (RFC 0034 §2.6): reviewed by the engine — every error with its question —, kept
 * with their score, the invitation used up, the survey's figures brought up to date; all or nothing. An anonymous
 * survey keeps nothing that names the respondent.
 */
export async function submitSurvey(
  env: Env,
  key: string,
  sent: {
    readonly answers: Readonly<Record<string, unknown>>;
    readonly name?: unknown;
    readonly email?: unknown;
  },
): Promise<Submitted> {
  return env.asSuperuser({ reason: 'a survey answered' }, async (raw) => {
    const opened = await open(raw, key);
    if (!opened.ok) return opened;
    const s = opened.survey;
    const su = raw.withFlags({ checkCompany: false }) as Env;
    const given: Record<number, RawAnswer> = {};
    for (const q of s.questions) given[q.id] = sent.answers[String(q.id)] as RawAnswer;
    const reviewed = review(s.questions, given);
    if (reviewed.errors.length > 0)
      return {
        ok: false,
        why: 'invalid',
        errors: reviewed.errors.map((e) => ({
          ...e,
          title: s.questions.find((q) => q.id === e.question)?.title ?? '',
        })),
      };
    const [invitation] =
      opened.invitation === null
        ? []
        : await su
            .model('survey.invitation')
            .browse([opened.invitation as never])
            .load({ partner: true });
    const percent =
      reviewed.maxScore <= 0 ? null : Math.round((reviewed.score * 1000) / reviewed.maxScore) / 10;
    const who = s.anonymous
      ? {}
      : {
          invitation: invitation?.id ?? null,
          partner: invitation?.partner?.id ?? null,
          name: invitation?.name ?? clip(sent.name, 120),
          email: invitation?.email ?? clip(sent.email, 200),
          resModel: invitation?.resModel ?? null,
          resId: invitation?.resId ?? null,
        };
    const made = await su.model('survey.response').create([
      {
        survey: s.id,
        company: s.company,
        submittedAt: new Date(),
        score: (reviewed.score / 100).toFixed(2),
        maxScore: (reviewed.maxScore / 100).toFixed(2),
        percent,
        outcome:
          s.passPercent === null || percent === null
            ? null
            : percent >= s.passPercent
              ? 'passed'
              : 'failed',
        ...who,
        answers: {
          create: reviewed.answers.map((a) => {
            const q = s.questions.find((x) => x.id === a.question);
            const labels = a.choices.map((c) => q?.labels.get(c) ?? '');
            return {
              survey: s.id,
              company: s.company,
              question: a.question,
              valueText: a.text,
              valueNumber: a.number,
              choices: { set: [...a.choices] },
              display: (a.text ?? (a.number === null ? labels.join(', ') : String(a.number))).slice(
                0,
                250,
              ),
              score: (a.score / 100).toFixed(2),
            };
          }),
        },
      } as never,
    ]);
    if (invitation !== undefined)
      await su
        .model('survey.invitation')
        .browse([invitation.id])
        .write({ status: 'answered', answeredAt: new Date() } as never);
    await su.flush();
    if (invitation !== undefined && !s.anonymous)
      await writeBack(su, invitation.id as number, reviewed.answers);
    await refreshStats(su, s.id);
    await su.emit('survey.response.received', { id: made.ids[0], survey: s.id });
    return { ok: true, response: made.ids[0] as number, thanks: s.thanks };
  });
}

/**
 * An answer written on the record its invitation is about (a ticket's rating), when the trigger that asked says
 * so. A record that refuses the value keeps the response: the trigger says what went wrong.
 */
async function writeBack(
  su: Env,
  invitation: number,
  answers: readonly { readonly question: number; readonly number: number | null }[],
): Promise<void> {
  const [i] = await su
    .model('survey.invitation')
    .browse([invitation as never])
    .load({ trigger: { answerQuestion: true } });
  const t = i?.trigger ?? null;
  if (i === undefined || t === null || t.answerQuestion === null) return;
  if (t.answerField === null || t.answerField === '' || i.resModel === null || i.resId === null)
    return;
  const given = answers.find((a) => a.question === (t.answerQuestion?.id as number));
  if (given === undefined || given.number === null) return;
  try {
    await (
      su.model(i.resModel as never) as unknown as {
        browse(ids: readonly number[]): {
          write(values: Record<string, unknown>): Promise<unknown>;
        };
      }
    )
      .browse([i.resId])
      .write({ [t.answerField]: given.number });
    await su.flush();
  } catch (error) {
    await su
      .model('survey.trigger')
      .browse([t.id])
      .write({
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 250),
      } as never);
  }
}

/** The count, the average score, NPS and CSAT of a survey, from its responses. */
export async function refreshStats(su: Env, survey: number): Promise<void> {
  const responses = await su
    .model('survey.response')
    .search({ where: { survey: survey as never } });
  const scored = [...responses].filter((r) => r.percent !== null).map((r) => Number(r.percent));
  const answers = await su
    .model('survey.answer')
    .search({ where: { survey: survey as never, valueNumber: { isNull: false } } as never })
    .then((found) => found.load({ question: true }));
  const recommend = [...answers]
    .filter((a) => a.question.kind === 'nps')
    .map((a) => Number(a.valueNumber));
  // Ratings on scales of their own count each on its scale: satisfied is the top two fifths.
  const rated = [...answers].filter((a) => a.question.kind === 'rating');
  const satisfied = rated.filter((a) => Number(a.valueNumber) > a.question.scaleMax * 0.6).length;
  await su
    .model('survey.survey')
    .browse([survey as never])
    .write({
      responseCount: responses.length,
      averagePercent:
        scored.length === 0
          ? null
          : Math.round((scored.reduce((sum, p) => sum + p, 0) * 10) / scored.length) / 10,
      npsScore: nps(recommend),
      csatScore: rated.length === 0 ? null : Math.round((satisfied * 100) / rated.length),
    } as never);
  await su.flush();
}

/** A question's answers, counted. */
export interface QuestionResult {
  readonly id: number;
  readonly title: string;
  readonly kind: QuestionKind;
  readonly answers: number;
  readonly average: number | null;
  readonly nps: number | null;
  readonly csat: number | null;
  readonly choices: readonly {
    readonly label: string;
    readonly count: number;
    readonly percent: number;
  }[];
}

/** The results of a survey its reader may see: every question with its count, its average and its choices. */
export async function surveyResults(env: Env, id: number): Promise<QuestionResult[] | null> {
  // The reader's own rights decide whether the survey is theirs to read.
  if (
    (await env.model('survey.survey').search({ where: { id: id as never }, limit: 1 })).length === 0
  )
    return null;
  return env.asSuperuser({ reason: 'survey results' }, async (su) => {
    const s = await load(su, id);
    if (s === null) return null;
    const answers = await su
      .model('survey.answer')
      .search({ where: { survey: id as never } as never })
      .then((found) => found.load({ choices: true }));
    return s.questions.map((q) => {
      const mine = [...answers].filter((a) => (a.question.id as number) === q.id);
      const numbers = mine.filter((a) => a.valueNumber !== null).map((a) => Number(a.valueNumber));
      const yes =
        q.kind === 'yes_no'
          ? new Map<number, string>([
              [1, 'Yes'],
              [0, 'No'],
            ])
          : null;
      const counted =
        yes !== null
          ? [...yes].map(([key, label]) => ({
              label,
              count: mine.filter((a) => a.valueText === (key === 1 ? 'yes' : 'no')).length,
            }))
          : q.choices.map((c) => ({
              label: q.labels.get(c.id) ?? '',
              count: mine.filter((a) => [...a.choices].some((x) => x.id === c.id)).length,
            }));
      return {
        id: q.id,
        title: q.title,
        kind: q.kind,
        answers: mine.length,
        average:
          numbers.length === 0
            ? null
            : Math.round((numbers.reduce((sum, n) => sum + n, 0) * 100) / numbers.length) / 100,
        nps: q.kind === 'nps' ? nps(numbers) : null,
        csat: q.kind === 'rating' ? csat(numbers, q.scaleMax) : null,
        choices: counted.map((c) => ({
          ...c,
          percent: mine.length === 0 ? 0 : Math.round((c.count * 100) / mine.length),
        })),
      };
    });
  });
}

/**
 * Asking by itself (RFC 0034 §2.6): when something happens in another app — a ticket is solved, an event ends, an
 * applicant arrives —, the people concerned are invited to a survey, once each, and an answer may be written back
 * on the record (a ticket's rating). One rule for every app: the event, where the person's name and email are, and
 * which rows count.
 */
export const SurveyTrigger = defineModel('survey.trigger', {
  label: 'Automatic invitation',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['topic', 'survey'],
  access: { 'survey.user': READ, 'survey.manager': [...ALL, 'export'] },
  fields: {
    name: f.char({ required: true }),
    survey: f.many2one('survey.survey', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    topic: f.char({
      size: 120,
      required: true,
      label: 'When',
      help: 'An event of an installed app (helpdesk.ticket.solved, event.event.ended), or a model and .created (hiring.applicant.created). The list is at /api/v1/surveys/events.',
    }),
    each: f.char({
      size: 60,
      label: 'For each of',
      help: 'A list on the record whose rows are the people to ask (registrations of an event); empty: the record itself.',
    }),
    whenField: f.char({ size: 60, label: 'Only when the field' }),
    whenValue: f.char({
      size: 120,
      label: 'is',
      help: 'Only records — or rows — whose field has this value are asked (state is attended).',
    }),
    nameField: f.char({ size: 60, required: true, default: 'name', label: 'Name in' }),
    emailField: f.char({
      size: 60,
      required: true,
      default: 'email',
      label: 'Email in',
      help: 'The field with the person’s email; when it is empty, the email of the contact below.',
    }),
    partnerField: f.char({ size: 60, label: 'Contact in' }),
    langField: f.char({
      size: 60,
      label: 'Language in',
      help: 'A field whose value starts with bn for Bangla; empty: English.',
    }),
    answerQuestion: f.many2one('survey.question', {
      ondelete: 'set null',
      label: 'Write the answer of',
      help: 'A rating, a recommendation or a number of the survey.',
    }),
    answerField: f.char({
      size: 60,
      label: 'into the field',
      help: 'A number field of the record asked about (rating on a ticket). Not on an anonymous survey.',
    }),
    lastError: f.char({ label: 'Last problem', groups: { write: [...SYSTEM] } }),
  },
  constraints: {
    holdsTogether: {
      ...check(
        'survey.trigger',
        [
          'topic',
          'each',
          'whenField',
          'nameField',
          'emailField',
          'partnerField',
          'langField',
          'answerField',
        ],
        (triggers) =>
          brokenTriggers(triggers.env as unknown as Env, triggers.ids as readonly number[]),
      ),
      message:
        'The event is not one of an installed app, or a field named here is not on its record (see /api/v1/surveys/events).',
    },
  },
});

// ---- what the installed apps offer

/** A field of a model, as the metadata describes it. */
interface Described {
  readonly kind: string;
  readonly target?: unknown;
}

/** The events a trigger may wait for and the models behind them: set when the server starts. */
export interface TriggerCatalogue {
  /** Topic to model: the apps' named events, and `<model>.created` for every model. */
  modelOf(topic: string): string | null;
  /** The fields of a model, or `null` when there is no such model. */
  fieldsOf(model: string): Readonly<Record<string, Described>> | null;
}

let catalogue: TriggerCatalogue | null = null;

/** Tells Surveys what the installed apps offer (the server does, when it starts). */
export function setTriggerCatalogue(value: TriggerCatalogue | null): void {
  catalogue = value;
}

interface TriggerPlan {
  /** The model the event is about. */
  readonly model: string;
  /** The model of the people asked: the record's, or its rows'. */
  readonly rowModel: string;
}

/** What a trigger needs to run, or what is wrong with it. */
function planOf(t: {
  readonly topic: string;
  readonly each: string | null;
  readonly whenField: string | null;
  readonly nameField: string;
  readonly emailField: string;
  readonly partnerField: string | null;
  readonly langField: string | null;
  readonly answerField: string | null;
}): TriggerPlan | string {
  if (catalogue === null) return 'The server has not listed its events yet.';
  const model = catalogue.modelOf(t.topic);
  if (model === null) return `No installed app has the event ${t.topic}.`;
  const fields = catalogue.fieldsOf(model);
  if (fields === null) return `There is no model ${model}.`;
  let rowModel = model;
  let rowFields = fields;
  if (t.each !== null && t.each !== '') {
    const list = fields[t.each];
    if (list === undefined || list.kind !== 'one2many' || typeof list.target !== 'string')
      return `${t.each} is not a list on ${model}.`;
    rowModel = list.target;
    const found = catalogue.fieldsOf(rowModel);
    if (found === null) return `There is no model ${rowModel}.`;
    rowFields = found;
  }
  for (const name of [t.whenField, t.nameField, t.emailField, t.partnerField, t.langField])
    if (name !== null && name !== '' && rowFields[name] === undefined)
      return `${rowModel} has no field ${name}.`;
  if (
    t.partnerField !== null &&
    t.partnerField !== '' &&
    rowFields[t.partnerField]?.kind !== 'many2one'
  )
    return `${t.partnerField} is not a contact on ${rowModel}.`;
  if (t.answerField !== null && t.answerField !== '') {
    const target = rowFields[t.answerField];
    if (target === undefined || !['integer', 'decimal', 'float'].includes(target.kind))
      return `${t.answerField} is not a number on ${rowModel}.`;
  }
  return { model, rowModel };
}

/** The triggers among `ids` that do not hold together (none before the server listed its events). */
async function brokenTriggers(env: Env, ids: readonly number[]): Promise<number[]> {
  if (catalogue === null) return [];
  const rows = await env.asSuperuser({ reason: 'an automatic invitation checked' }, async (su) => [
    ...(await su
      .model('survey.trigger')
      .browse([...ids] as never)
      .load([
        'topic',
        'each',
        'whenField',
        'nameField',
        'emailField',
        'partnerField',
        'langField',
        'answerField',
      ])),
  ]);
  return rows.filter((t) => typeof planOf(t) === 'string').map((t) => t.id as number);
}

/**
 * Invites someone to a survey about a record, once: a second call for the same survey and record returns the
 * invitation that exists. Returns its id.
 */
export async function inviteAbout(
  su: Env,
  to: {
    readonly survey: number;
    readonly company: number;
    readonly name: string;
    readonly email: string | null;
    readonly partner?: number | null;
    readonly lang?: 'en' | 'bn';
    readonly resModel: string;
    readonly resId: number;
    readonly trigger?: number | null;
  },
): Promise<{ readonly id: number; readonly made: boolean }> {
  const [existing] = await su.model('survey.invitation').search({
    where: { survey: to.survey as never, resModel: to.resModel, resId: to.resId } as never,
    limit: 1,
  });
  if (existing !== undefined) return { id: existing.id as number, made: false };
  const made = await su.model('survey.invitation').create([
    {
      survey: to.survey,
      company: to.company,
      name: to.name.slice(0, 120),
      email: to.email,
      partner: to.partner ?? null,
      lang: to.lang ?? 'en',
      resModel: to.resModel,
      resId: to.resId,
      trigger: to.trigger ?? null,
    } as never,
  ]);
  return { id: made.ids[0] as number, made: true };
}

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && 'id' in value) return String((value as { id: unknown }).id);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const said = String(value).trim();
  return said === '' ? null : said;
};

/**
 * What happened, to the triggers that wait for it (RFC 0034 §2.6): for every active trigger of the company on
 * this event whose survey is open, the record — or each of its rows — that meets the condition and has an email is
 * invited, once. A trigger that cannot run says why on itself. Returns the invitations made.
 */
export async function fireTriggers(su: Env, topic: string, id: number): Promise<number[]> {
  const made: number[] = [];
  const triggers = await su
    .model('survey.trigger')
    .search({ where: { topic, active: true } as never })
    .then((found) => found.load({ survey: true, company: true }));
  for (const t of triggers) {
    if (t.survey.state !== 'open') continue;
    const plan = planOf(t);
    const fail = async (problem: string): Promise<void> => {
      await su
        .model('survey.trigger')
        .browse([t.id])
        .write({ lastError: problem.slice(0, 250) } as never);
    };
    if (typeof plan === 'string') {
      await fail(plan);
      continue;
    }
    try {
      const partner = t.partnerField === null || t.partnerField === '' ? null : t.partnerField;
      const spec = partner === null ? {} : { [partner]: true };
      const loaded = await (
        su.model(plan.model as never) as unknown as {
          browse(ids: readonly number[]): {
            load(spec: unknown): Promise<Iterable<Record<string, unknown>>>;
          };
        }
      )
        .browse([id])
        .load(t.each === null || t.each === '' ? spec : { [t.each]: spec });
      const [record] = [...loaded];
      if (record === undefined) continue;
      const rows: Record<string, unknown>[] =
        t.each === null || t.each === ''
          ? [record]
          : [...(record[t.each] as Iterable<Record<string, unknown>>)];
      for (const row of rows) {
        if (
          t.whenField !== null &&
          t.whenField !== '' &&
          text(row[t.whenField]) !== (t.whenValue ?? '')
        )
          continue;
        const contact = partner === null ? null : (row[partner] as Record<string, unknown> | null);
        const email = text(row[t.emailField]) ?? text(contact?.['email']);
        if (email === null) continue;
        const lang =
          t.langField !== null &&
          t.langField !== '' &&
          (text(row[t.langField]) ?? '').startsWith('bn')
            ? 'bn'
            : 'en';
        const invited = await inviteAbout(su, {
          survey: t.survey.id as number,
          company: t.company.id as number,
          name: text(row[t.nameField]) ?? text(contact?.['name']) ?? email,
          email,
          partner: contact === null ? null : (contact['id'] as number),
          lang,
          resModel: plan.rowModel,
          resId: row['id'] as number,
          trigger: t.id as number,
        });
        if (invited.made) made.push(invited.id);
      }
      if (t.lastError !== null)
        await su
          .model('survey.trigger')
          .browse([t.id])
          .write({ lastError: null } as never);
    } catch (error) {
      await fail(error instanceof Error ? error.message : String(error));
    }
  }
  await su.flush();
  return made;
}

/** The pending invitations among these that are to be emailed now: marked as sent, and returned with their link. */
export async function takeToSend(
  su: Env,
  where: { readonly invitations?: readonly number[]; readonly survey?: number },
): Promise<
  {
    readonly to: string;
    readonly name: string;
    readonly lang: 'en' | 'bn';
    readonly survey: string;
    readonly description: string | null;
    readonly path: string;
  }[]
> {
  const found = await su
    .model('survey.invitation')
    .search({
      where: {
        status: 'pending',
        sentAt: { isNull: true },
        email: { isNull: false },
        ...(where.invitations === undefined ? {} : { id: { in: [...where.invitations] } }),
        ...(where.survey === undefined ? {} : { survey: where.survey }),
      } as never,
    })
    .then((rows) => rows.load({ survey: true }));
  const out = [];
  for (const i of found) {
    if (i.survey.state !== 'open' || i.email === null || i.email.trim() === '') continue;
    await su
      .model('survey.invitation')
      .browse([i.id])
      .write({ sentAt: new Date() } as never);
    out.push({
      to: i.email.trim(),
      name: i.name,
      lang: (i.lang === 'bn' ? 'bn' : 'en') as 'en' | 'bn',
      survey: i.survey.name,
      description: i.survey.description,
      path: `${surveyPath(i.token)}${i.lang === 'bn' ? '?lang=bn' : ''}`,
    });
  }
  await su.flush();
  return out;
}

export const surveyShutro = defineModule({
  name: 'survey',
  version: '0.1.0',
  depends: [contactsShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: 'survey.user',
      label: 'Surveys user',
      implies: ['contacts.user', 'messaging.user'],
    }),
    orm.defineGroup({
      code: 'survey.manager',
      label: 'Surveys manager',
      implies: ['survey.user'],
    }),
  ],
  models: [
    Survey,
    SurveyQuestion,
    SurveyChoice,
    SurveyInvitation,
    SurveyResponse,
    SurveyAnswer,
    SurveyTrigger,
  ],
});
