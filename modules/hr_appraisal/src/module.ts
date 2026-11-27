/**
 * The data layer of Appraisals and skills (RFC 0038, step 5).
 *
 * **Skills**: kinds of skill (*Languages*, *Machines*) with their own levels, the skills of each kind, and what
 * each person has reached.
 *
 * **Appraisals**: a **cycle** opens one appraisal per person, reviewed by their manager. An appraisal has
 * **goals** with weights; the person writes a **self review** and scores themselves, the reviewer writes theirs,
 * scores each goal and gives the rating; the weighted score is the server's. An appraisal is **private** to the
 * person, their reviewer and HR — by record rules —; nobody writes the other side's words, and nobody reviews
 * themselves.
 */
import { hrShutro } from '@kosh/hr';
import { messagingShutro } from '@kosh/messaging';
import { emitting } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  records,
} from './.kosh/bindings.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
/** Fields the server maintains: written by its own code and by Administrators only. */
const SYSTEM = ['base.admin'] as const;
const me = { $env: 'uid' } as const;
const USER = 'hr_appraisal.user';
const HR = 'hr_appraisal.manager';
const zero: Decimal = orm.toDecimal(0);

/** HR: who holds the permission only HR has (an Administrator does too). */
const isHr = (env: Env): boolean => env.su || env.access.has('hr_appraisal.reopen');

// ------------------------------------------------------------------------------------------------- skills

export const SkillType = defineModel('hr.skill.type', {
  label: 'Kind of skill',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  access: { [USER]: READ, [HR]: [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    skills: f.one2many('hr.skill', 'type', { label: 'Skills' }),
    levels: f.one2many('hr.skill.level', 'type', { label: 'Levels' }),
  },
  sqlConstraints: {
    name: { unique: ['name'], message: 'Another kind of skill has this name.' },
  },
});

export const Skill = defineModel('hr.skill', {
  label: 'Skill',
  recName: 'name',
  order: ['name asc'],
  access: { [USER]: READ, [HR]: [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    type: f.many2one('hr.skill.type', { required: true, ondelete: 'cascade', index: true }),
  },
  sqlConstraints: {
    name: { unique: ['type', 'name'], message: 'This kind has a skill of this name already.' },
  },
});

export const SkillLevel = defineModel('hr.skill.level', {
  label: 'Skill level',
  recName: 'name',
  order: ['progress asc', 'id asc'],
  access: { [USER]: READ, [HR]: [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    type: f.many2one('hr.skill.type', { required: true, ondelete: 'cascade', index: true }),
    progress: f.integer({
      required: true,
      default: 0,
      label: 'Progress %',
      help: 'How far this level is towards mastering the skill, from 0 to 100.',
    }),
  },
  sqlConstraints: {
    range: {
      check: orm.sql`progress BETWEEN 0 AND 100`,
      message: 'Progress is between 0 and 100.',
    },
    name: { unique: ['type', 'name'], message: 'This kind has a level of this name already.' },
  },
});

export const EmployeeSkill = defineModel('hr.employee.skill', {
  label: 'Person’s skill',
  order: ['employee asc', 'id asc'],
  access: {
    [USER]: ['read', 'write', 'create', 'unlink'],
    [HR]: [...ALL, 'export', 'import'],
  },
  rules: {
    // One's own skills are read; the line manager keeps their team's; HR everybody's.
    own: { groups: [USER], perms: ['read'], domain: { 'employee.user': me } },
    team: {
      groups: [USER],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: { 'employee.manager.user': me },
    },
    all: { groups: [HR], perms: [...ALL], domain: {} },
  },
  fields: {
    employee: f.many2one('hr.employee', { required: true, ondelete: 'cascade', index: true }),
    skill: f.many2one('hr.skill', { required: true, ondelete: 'restrict', index: true }),
    level: f.many2one('hr.skill.level', { required: true, ondelete: 'restrict' }),
    progress: f.integer({
      store: true,
      label: 'Progress %',
      help: 'The level’s progress.',
      ...compute('hr.employee.skill', 'progress', ['level.progress'], (rows) => {
        for (const r of rows) r.progress = r.level?.progress ?? 0;
      }),
    }),
    note: f.char(),
  },
  sqlConstraints: {
    once: { unique: ['employee', 'skill'], message: 'This person has this skill already.' },
  },
  constraints: {
    sameKind: {
      ...check('hr.employee.skill', ['skill', 'level'], async (rows) =>
        [...(await rows.load({ skill: true, level: true }))]
          .filter((r) => r.skill.type.id !== r.level.type.id)
          .map((r) => r.id),
      ),
      message: 'Choose a level of the skill’s own kind.',
    },
  },
});

// --------------------------------------------------------------------------------------------- appraisals

export const RATINGS = {
  below: 'Below expectations',
  partly: 'Partly meets expectations',
  meets: 'Meets expectations',
  exceeds: 'Exceeds expectations',
  outstanding: 'Outstanding',
} as const;

export const AppraisalCycle = defineModel('hr.appraisal.cycle', {
  label: 'Appraisal cycle',
  recName: 'name',
  order: ['dateFrom desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'dateDue'],
  access: { [USER]: READ, [HR]: [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, label: 'Name', help: '“Annual review 2026”, “Mid-year 2027”.' }),
    dateFrom: f.date({ required: true, label: 'Period from' }),
    dateTo: f.date({ required: true, label: 'Period to' }),
    dateDue: f.date({ label: 'Reviews due by' }),
    appraisals: f.one2many('hr.appraisal', 'cycle', { label: 'Appraisals' }),
    state: f.state({
      states: { draft: 'Draft', open: 'Open', closed: 'Closed' },
      initial: 'draft',
      help: 'Opening a cycle makes an appraisal for every person who has a manager; closing it ends the round.',
      transitions: {
        // Opening makes the appraisals: one per active person with a manager, reviewed by that manager.
        launch: emitting('hr.appraisal.cycle.opened', {
          from: ['draft'],
          to: 'open',
          after: records('hr.appraisal.cycle', async (cycles): Promise<void> => {
            const env = cycles.env as unknown as Env;
            for (const id of cycles.ids) await openCycle(env, id as number);
          }),
        }),
        close: { from: ['open'], to: 'closed' },
        reopen: { from: ['closed'], to: 'open' },
      },
    }),
  },
  sqlConstraints: {
    ordered: {
      check: orm.sql`date_to >= date_from`,
      message: 'A period ends on or after its start.',
    },
  },
});

/**
 * Makes the cycle's appraisals: one for each active person of the company who has a manager and none in this
 * cycle yet. Returns how many were made.
 */
export async function openCycle(env: Env, id: number): Promise<number> {
  return env.asSuperuser({ reason: 'appraisal cycle opened' }, async (su) => {
    const [cycle] = await su
      .model('hr.appraisal.cycle')
      .browse([id] as never)
      .load({ company: true });
    if (cycle === undefined) return 0;
    const have = new Set(
      (
        await su.sql<{ employee_id: number }>`
          SELECT employee_id FROM hr_appraisal WHERE cycle_id = ${id}`
      ).map((r) => Number(r.employee_id)),
    );
    const people = await su.model('hr.employee').search({
      where: { company: cycle.company.id, manager: { isNull: false } } as never,
      order: ['id asc'],
    });
    const rows = [...(await people.load(['name']))]
      .filter((p) => !have.has(p.id as number))
      .map((p) => ({
        name: `${p.name} — ${cycle.name}`,
        employee: p.id,
        reviewer: (p.manager as { id: number } | null)?.id ?? null,
        cycle: id,
        company: cycle.company.id,
        dateDue: cycle.dateDue,
      }));
    for (let i = 0; i < rows.length; i += 500)
      await su.model('hr.appraisal').create(rows.slice(i, i + 500) as never);
    await su.flush();
    return rows.length;
  });
}

/** The appraisals among these that the acting user may not touch on the side given. */
const wrongHand = async (
  env: Env,
  appraisals: readonly number[],
  side: 'self' | 'reviewer',
): Promise<number[]> => {
  if (env.su) return [];
  const rows = await env.asSuperuser({ reason: 'whose appraisal' }, async (su) =>
    [
      ...(await su
        .model('hr.appraisal')
        .browse([...appraisals] as never)
        .load({ employee: true, reviewer: true })),
    ].map((a) => ({
      id: a.id as number,
      person: (a.employee.user as { id: number } | null)?.id ?? null,
      reviewer: (a.reviewer?.user as { id: number } | null | undefined)?.id ?? null,
    })),
  );
  return rows
    .filter((a) =>
      side === 'self'
        ? // One's own words are one's own: not the manager's, not HR's.
          a.person !== env.uid
        : // The review is the reviewer's, or HR's — and never the person's own.
          a.person === env.uid || !(a.reviewer === env.uid || isHr(env)),
    )
    .map((a) => a.id);
};

const SELF_ONLY = 'The self review is the person’s own to write.';
const REVIEWER_ONLY =
  'The review, the scores and the rating are the reviewer’s to write — or HR’s —, never the person’s own.';

export const Appraisal = defineModel('hr.appraisal', {
  label: 'Appraisal',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'reviewer', 'dateDue'],
  access: {
    [USER]: ['read', 'write', 'create'],
    [HR]: [...ALL, 'export'],
  },
  rules: {
    // Private: the person, their reviewer, HR — nobody else.
    own: { groups: [USER], perms: ['read'], domain: { 'employee.user': me } },
    ownWrite: {
      groups: [USER],
      perms: ['write'],
      domain: { 'employee.user': me, state: 'self' },
    },
    reviewer: {
      groups: [USER],
      perms: ['read', 'write', 'create'],
      domain: { 'reviewer.user': me },
    },
    all: { groups: [HR], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, label: 'Title' }),
    employee: f.many2one('hr.employee', { required: true, ondelete: 'cascade', index: true }),
    reviewer: f.many2one('hr.employee', {
      ondelete: 'set null',
      index: true,
      label: 'Reviewer',
      help: 'Who reviews: the person’s manager when the cycle opened. Without one, HR reviews.',
    }),
    cycle: f.many2one('hr.appraisal.cycle', { ondelete: 'cascade', index: true, label: 'Cycle' }),
    dateDue: f.date({ label: 'Due by' }),
    goals: f.one2many('hr.appraisal.goal', 'appraisal', { label: 'Goals' }),
    selfReview: f.text({
      label: 'Self review',
      help: 'The person’s own words: what went well, what did not, what they want next.',
    }),
    managerReview: f.text({
      label: 'Reviewer’s review',
      help: 'The reviewer’s words. The person reads them; only the reviewer or HR writes them.',
    }),
    rating: f.selection(RATINGS, {
      label: 'Rating',
      help: 'The reviewer’s overall rating, from below expectations to outstanding.',
    }),
    score: f.decimal({
      scale: 1,
      store: true,
      label: 'Score %',
      help: 'The reviewer’s scores of the goals, weighted. Empty until a goal is scored.',
      ...compute('hr.appraisal', 'score', ['goals.score', 'goals.weight'], (appraisals) => {
        for (const a of appraisals) {
          const scored = [...a.goals].filter((g) => g.score !== null);
          const weight = scored.reduce((s, g) => s.plus(g.weight ?? zero), zero);
          a.score = weight.gt(0)
            ? scored
                .reduce((s, g) => s.plus((g.score ?? zero).times(g.weight ?? zero)), zero)
                .div(weight)
                .toDecimalPlaces(1)
            : null;
        }
      }),
    }),
    doneOn: f.date({ label: 'Completed on', groups: { write: [...SYSTEM] } }),
    state: f.state({
      states: {
        draft: 'Goals',
        self: 'Self review',
        review: 'Reviewer’s review',
        done: 'Completed',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      help: 'Goals are agreed, the person reviews themselves, the reviewer reviews and rates, and it is completed.',
      transitions: {
        begin: {
          from: ['draft'],
          to: 'self',
          guard: records('hr.appraisal', async (appraisals) =>
            wrongHand(appraisals.env as unknown as Env, appraisals.ids.map(Number), 'reviewer'),
          ),
          message: 'The reviewer, or HR, asks for the self review.',
        },
        submit: emitting('hr.appraisal.submitted', {
          from: ['self'],
          to: 'review',
          guard: records('hr.appraisal', async (appraisals) => {
            const env = appraisals.env as unknown as Env;
            const notMine = new Set(await wrongHand(env, appraisals.ids.map(Number), 'self'));
            return [...(await appraisals.load(['selfReview']))]
              .filter((a) => notMine.has(a.id as number) || (a.selfReview ?? '').trim() === '')
              .map((a) => a.id);
          }),
          message: 'The person submits their own self review, once it is written.',
        }),
        complete: emitting('hr.appraisal.completed', {
          from: ['review'],
          to: 'done',
          guard: records('hr.appraisal', async (appraisals) => {
            const env = appraisals.env as unknown as Env;
            const notMine = new Set(await wrongHand(env, appraisals.ids.map(Number), 'reviewer'));
            return [...(await appraisals.load(['managerReview', 'rating']))]
              .filter(
                (a) =>
                  notMine.has(a.id as number) ||
                  (a.managerReview ?? '').trim() === '' ||
                  a.rating === null,
              )
              .map((a) => a.id);
          }),
          message:
            'The reviewer, or HR, completes it — never the person themselves —, with the review written and the rating given.',
          after: records('hr.appraisal', async (appraisals): Promise<void> => {
            const env = appraisals.env as unknown as Env;
            await env.asSuperuser({ reason: 'appraisal completed' }, async (su) => {
              await su
                .model('hr.appraisal')
                .browse(appraisals.ids)
                .write({ doneOn: su.today() } as never);
              await su.flush();
            });
          }),
        }),
        reopen: { from: ['done'], to: 'review', requires: 'hr_appraisal.reopen' },
        cancel: {
          from: ['draft', 'self', 'review'],
          to: 'cancel',
          requires: 'hr_appraisal.reopen',
        },
      },
    }),
  },
  sqlConstraints: {
    once: {
      unique: ['cycle', 'employee'],
      message: 'This person has an appraisal in this cycle already.',
    },
  },
  constraints: {
    notOneself: {
      ...check('hr.appraisal', ['employee', 'reviewer'], (appraisals) =>
        [...appraisals]
          .filter((a) => a.reviewer !== null && a.reviewer.id === a.employee.id)
          .map((a) => a.id),
      ),
      message: 'Nobody reviews themselves.',
    },
    selfWords: {
      ...check('hr.appraisal', ['selfReview'], async (appraisals) => {
        const written = [...appraisals].filter((a) => (a.selfReview ?? '') !== '').map((a) => a.id);
        return wrongHand(appraisals.env as unknown as Env, written as number[], 'self');
      }),
      message: SELF_ONLY,
    },
    reviewerWords: {
      ...check('hr.appraisal', ['managerReview', 'rating'], async (appraisals) => {
        const written = [...appraisals]
          .filter((a) => (a.managerReview ?? '') !== '' || a.rating !== null)
          .map((a) => a.id);
        return wrongHand(appraisals.env as unknown as Env, written as number[], 'reviewer');
      }),
      message: REVIEWER_ONLY,
    },
    // What was completed is what stands.
    sealed: {
      ...check(
        'hr.appraisal',
        ['selfReview', 'managerReview', 'rating', 'employee', 'reviewer'],
        async (appraisals) =>
          [...(await appraisals.load(['state', 'doneOn']))]
            .filter((a) => a.state === 'done' && a.doneOn !== null)
            .map((a) => a.id),
      ),
      message: 'A completed appraisal does not change: HR reopens it first.',
    },
  },
});

/** The goals among these whose appraisal the acting user may not touch on the side given. */
const goalsOfWrongHand = async (
  env: Env,
  goals: Iterable<{ id: number; appraisal: { id: number } }>,
  side: 'self' | 'reviewer',
): Promise<number[]> => {
  // Read now: records are views of the cache, and what follows changes what is loaded.
  const list = [...goals].map((g) => ({ id: g.id, appraisal: g.appraisal.id }));
  const wrong = new Set(await wrongHand(env, [...new Set(list.map((g) => g.appraisal))], side));
  return list.filter((g) => wrong.has(g.appraisal)).map((g) => g.id);
};

export const AppraisalGoal = defineModel('hr.appraisal.goal', {
  label: 'Appraisal goal',
  recName: 'name',
  order: ['id asc'],
  access: {
    [USER]: ['read', 'write', 'create', 'unlink'],
    [HR]: [...ALL, 'export'],
  },
  rules: {
    own: { groups: [USER], perms: ['read'], domain: { 'appraisal.employee.user': me } },
    ownWrite: {
      groups: [USER],
      perms: ['write'],
      domain: { 'appraisal.employee.user': me, 'appraisal.state': 'self' },
    },
    reviewer: {
      groups: [USER],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: { 'appraisal.reviewer.user': me },
    },
    all: { groups: [HR], perms: [...ALL], domain: {} },
  },
  fields: {
    appraisal: f.many2one('hr.appraisal', { required: true, ondelete: 'cascade', index: true }),
    name: f.char({ required: true, label: 'Goal' }),
    weight: f.decimal({
      scale: 1,
      required: true,
      default: '1',
      label: 'Weight',
      help: 'How much this goal counts in the score, against the others.',
    }),
    selfScore: f.decimal({
      scale: 1,
      label: 'Own score %',
      help: 'How far the person says they reached it, from 0 to 100.',
    }),
    score: f.decimal({
      scale: 1,
      label: 'Score %',
      help: 'How far the reviewer says it was reached, from 0 to 100.',
    }),
    comment: f.char({ label: 'Comment' }),
  },
  sqlConstraints: {
    range: {
      check: orm.sql`weight > 0 AND (self_score IS NULL OR self_score BETWEEN 0 AND 100)
        AND (score IS NULL OR score BETWEEN 0 AND 100)`,
      message: 'A weight is above zero, and a score between 0 and 100.',
    },
  },
  constraints: {
    selfScore: {
      ...check('hr.appraisal.goal', ['selfScore'], async (goals) =>
        goalsOfWrongHand(
          goals.env as unknown as Env,
          [...(await goals.load({ appraisal: true }))].filter((g) => g.selfScore !== null) as never,
          'self',
        ),
      ),
      message: 'One’s own score is one’s own to give.',
    },
    reviewerScore: {
      ...check('hr.appraisal.goal', ['score', 'name', 'weight'], async (goals) =>
        goalsOfWrongHand(
          goals.env as unknown as Env,
          [...(await goals.load({ appraisal: true }))] as never,
          'reviewer',
        ),
      ),
      message:
        'The goals, their weights and their scores are the reviewer’s to write — or HR’s —, never the person’s own.',
    },
    sealed: {
      ...check('hr.appraisal.goal', ['score', 'selfScore', 'name', 'weight'], async (goals) =>
        [...(await goals.load({ appraisal: true }))]
          .filter((g) => g.appraisal.state === 'done' && g.appraisal.doneOn !== null)
          .map((g) => g.id),
      ),
      message: 'A completed appraisal does not change: HR reopens it first.',
    },
  },
});

export const hrAppraisalShutro = defineModule({
  name: 'hr_appraisal',
  version: '0.1.0',
  depends: [hrShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: USER,
      label: 'Appraisals: one’s own and one’s team’s',
      implies: ['hr.user'],
    }),
    orm.defineGroup({ code: HR, label: 'Appraisals: HR', implies: [USER, 'hr.manager'] }),
  ],
  permissions: [
    orm.definePermission({
      code: 'hr_appraisal.reopen',
      label: 'Reopen and cancel appraisals',
      groups: [HR],
    }),
  ],
  models: [SkillType, Skill, SkillLevel, EmployeeSkill, AppraisalCycle, Appraisal, AppraisalGoal],
});
