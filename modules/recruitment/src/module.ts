/**
 * The data layer of Hiring (RFC 0021): openings for Workforce positions with their headcount, applicants moving
 * through stages, and interviewers' scorecards — each interviewer sees only their own, so no opinion steers the next;
 * the applicant's average rating shows to everyone. One email applies once per opening. Expected salaries are for
 * hiring managers only.
 */
import { hrShutro } from '@kosh/hr';
import { orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  record,
} from './.kosh/bindings.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const me = { $env: 'uid' } as const;

export const HiringStage = defineModel('hiring.stage', {
  label: 'Hiring stage',
  recName: 'name',
  order: ['sequence asc', 'id asc'],
  access: { 'hiring.user': READ, 'hiring.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    sequence: f.integer({ required: true, default: 10 }),
    fold: f.boolean({ default: false, label: 'Folded on the board' }),
    /** Applicants here were hired: the stage the hire step moves them to. */
    hired: f.boolean({ default: false }),
  },
});

export const HiringOpening = defineModel('hiring.opening', {
  label: 'Opening',
  recName: 'name',
  order: ['state asc', 'name asc'],
  companyScoped: { required: true },
  tracking: ['state', 'headcount', 'manager'],
  access: { 'hiring.user': READ, 'hiring.manager': ALL },
  fields: {
    name: f.char({ required: true, label: 'Opening' }),
    job: f.many2one('hr.job', { ondelete: 'set null', label: 'Position' }),
    department: f.many2one('hr.department', { ondelete: 'set null' }),
    manager: f.many2one('res.users', {
      default: (env: Env) => env.userId,
      label: 'Hiring manager',
    }),
    headcount: f.integer({ required: true, default: 1, label: 'To hire' }),
    hiredCount: f.integer({
      store: true,
      label: 'Hired',
      ...compute('hiring.opening', 'hiredCount', ['applicants.employee'], (openings) => {
        for (const o of openings)
          o.hiredCount = o.applicants.filter((a) => a.employee !== null).length;
      }),
    }),
    applicants: f.one2many('hiring.applicant', 'opening'),
    description: f.text(),
    state: f.state({
      states: { open: 'Open', closed: 'Closed' },
      initial: 'open',
      transitions: {
        close: { from: ['open'], to: 'closed' },
        reopen: { from: ['closed'], to: 'open' },
      },
    }),
  },
  sqlConstraints: {
    headcountPositive: {
      check: orm.sql`headcount > 0`,
      message: 'An opening hires at least one person.',
    },
  },
});

export const HiringApplicant = defineModel('hiring.applicant', {
  label: 'Applicant',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['stage', 'refused', 'employee'],
  access: {
    'hiring.user': ['read', 'write', 'create'],
    'hiring.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    name: f.char({ required: true, label: 'Candidate' }),
    email: f.char({ required: true }),
    phone: f.char(),
    opening: f.many2one('hiring.opening', { required: true, ondelete: 'cascade' }),
    stage: f.many2one('hiring.stage', { ondelete: 'restrict' }),
    source: f.selection(
      {
        website: 'Website',
        referral: 'Referral',
        job_board: 'Job board',
        linkedin: 'LinkedIn',
        agency: 'Agency',
        other: 'Other',
      },
      {},
    ),
    expectedSalary: f.decimal({ scale: 2, label: 'Expected salary', groups: ['hiring.manager'] }),
    refused: f.boolean({ default: false }),
    refuseReason: f.char({ label: 'Refused because' }),
    scorecards: f.one2many('hiring.scorecard', 'applicant'),
    /** The average score of the scorecards, out of 5 (null before the first). */
    rating: f.decimal({
      scale: 1,
      store: true,
      label: 'Rating',
      ...compute('hiring.applicant', 'rating', ['scorecards.score'], (applicants) => {
        for (const a of applicants) {
          const scores = [...a.scorecards].map((s) => s.score);
          a.rating =
            scores.length === 0
              ? null
              : orm
                  .toDecimal(scores.reduce((x, y) => x + y, 0))
                  .div(scores.length)
                  .toDecimalPlaces(1);
        }
      }),
    }),
    /** The Workforce employee once hired: set only by the hire step (see `hiredByTheHireStep`). */
    employee: f.many2one('hr.employee', { ondelete: 'set null' }),
    status: f.selection(
      { active: 'In progress', hired: 'Hired', refused: 'Refused' },
      {
        store: true,
        ...compute('hiring.applicant', 'status', ['employee', 'refused'], (applicants) => {
          for (const a of applicants)
            a.status = a.employee !== null ? 'hired' : a.refused ? 'refused' : 'active';
        }),
      },
    ),
    notes: f.text(),
  },
  constraints: {
    // One email applies once per opening (applications of another opening are separate).
    oneApplication: {
      ...check('hiring.applicant', ['email', 'opening'], async (applicants) =>
        applicants.env.asSuperuser({ reason: 'duplicate applications' }, async (su) => {
          const failing: number[] = [];
          for (const a of applicants) {
            const twins = await su.model('hiring.applicant').search({
              where: { opening: a.opening.id, email: { ilike: a.email.trim() }, id: { ne: a.id } },
              limit: 1,
            });
            if (twins.length > 0) failing.push(a.id);
          }
          return failing;
        }),
      ),
      message: 'This person already applied to this opening.',
    },
    // Hired only through `POST /api/v1/hiring/applicants/:id/hire`, which runs in an audited superuser scope.
    hiredByTheHireStep: {
      ...check('hiring.applicant', ['employee'], async (applicants) =>
        applicants.env.su
          ? []
          : [...applicants].filter((a) => a.employee !== null).map((a) => a.id),
      ),
      message: 'Applicants are hired with Hire, which makes their employee.',
    },
    refusedWithReason: {
      ...check('hiring.applicant', ['refused', 'refuseReason'], async (applicants) =>
        [...applicants]
          .filter((a) => a.refused && (a.refuseReason ?? '').trim() === '')
          .map((a) => a.id),
      ),
      message: 'A refused applicant says why.',
    },
  },
});

export const HiringScorecard = defineModel('hiring.scorecard', {
  label: 'Scorecard',
  order: ['id desc'],
  access: { 'hiring.user': ALL, 'hiring.manager': ALL },
  rules: {
    // Independent opinions: an interviewer sees and changes only their own.
    own: { groups: ['hiring.user'], perms: [...ALL], domain: { interviewer: me } },
    all: { groups: ['hiring.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    applicant: f.many2one('hiring.applicant', { required: true, ondelete: 'cascade' }),
    interviewer: f.many2one('res.users', { required: true, default: (env: Env) => env.userId }),
    score: f.integer({ required: true, default: 3, label: 'Score (1–5)' }),
    recommendation: f.selection(
      { strong_yes: 'Strong yes', yes: 'Yes', no: 'No', strong_no: 'Strong no' },
      { required: true, default: 'yes' },
    ),
    notes: f.text(),
  },
  sqlConstraints: {
    scoreRange: { check: orm.sql`score BETWEEN 1 AND 5`, message: 'A score is from 1 to 5.' },
  },
});

export const recruitmentShutro = defineModule({
  name: 'recruitment',
  version: '0.1.0',
  depends: [hrShutro],
  groups: [
    orm.defineGroup({ code: 'hiring.user', label: 'Interviewer', implies: ['hr.user'] }),
    orm.defineGroup({ code: 'hiring.manager', label: 'Hiring manager', implies: ['hiring.user'] }),
  ],
  models: [HiringStage, HiringOpening, HiringApplicant, HiringScorecard],
  data: [
    record('hiring.stage', 'stage_new', { name: 'New', sequence: 1 }, { noupdate: true }),
    record(
      'hiring.stage',
      'stage_screening',
      { name: 'Screening', sequence: 2 },
      { noupdate: true },
    ),
    record(
      'hiring.stage',
      'stage_interview',
      { name: 'Interview', sequence: 3 },
      { noupdate: true },
    ),
    record('hiring.stage', 'stage_offer', { name: 'Offer', sequence: 4 }, { noupdate: true }),
    record(
      'hiring.stage',
      'stage_hired',
      { name: 'Hired', sequence: 5, hired: true, fold: true },
      { noupdate: true },
    ),
  ],
});
