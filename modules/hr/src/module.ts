/**
 * The data layer of Workforce (RFC 0021): departments as a tree, positions, employees (separate from users: an
 * employee may never sign in) with their manager, contracts, and leave. Personal details and wages are visible to
 * HR managers only (field security). A leave's working days follow the person's working calendar — or the company's —
 * with its holidays and the person's own exceptions (Working time, RFC 0034 §2.4): a holiday is not charged; they are
 * checked by the server; a request may not overlap another of the same person, nor go beyond the year's days of its
 * type. Approving and refusing need the decision permission (HR managers) or go through the line manager's route.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { emitting } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { workingDays as countWorkingDays, scheduleOf, worktimeShutro } from '@kosh/worktime';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  method,
  onchange,
  type Records,
  record,
  records,
} from './.kosh/bindings.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const HR = ['hr.manager'];
const me = { $env: 'uid' } as const;

/** The weekend of each choice, as JavaScript day numbers (0: Sunday). */
export const WEEKENDS: Readonly<Record<string, readonly number[]>> = {
  fri_sat: [5, 6],
  sat_sun: [6, 0],
  fri: [5],
};

/** Working days from `from` to `to` (inclusive, ISO dates) outside the weekend. */
export function workingDays(from: string, to: string, weekend: readonly number[]): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 0;
  let days = 0;
  for (let t = start; t <= end; t += 86_400_000)
    if (!weekend.includes(new Date(t).getUTCDay())) days += 1;
  return days;
}

/**
 * The company's weekend: the days its working calendar has no hours on (Working time › Calendars), as JavaScript
 * day numbers. For what only needs to know the week (Attendance); leave counts with {@link leaveDays}.
 */
export async function weekendOf(env: Env): Promise<readonly number[]> {
  const today = new Date().toISOString().slice(0, 10);
  const schedule = await scheduleOf(env as never, { from: today, to: today });
  return [0, 1, 2, 3, 4, 5, 6].filter((day) => (schedule.week[day] ?? []).length === 0);
}

/**
 * The working days a leave of this person takes from `from` to `to` (ISO dates, both included): by their working
 * calendar — the company's when they have none —, without its holidays and without the days they do not work
 * anyway (their personal exceptions).
 */
export async function leaveDays(
  env: Env,
  employee: number | null,
  from: string,
  to: string,
): Promise<number> {
  if (to < from) return 0;
  const person =
    employee === null
      ? undefined
      : await env.asSuperuser({ reason: 'the working calendar of a leave' }, async (su) => {
          const [row] = [
            ...(await su
              .model('hr.employee')
              .search({ where: { id: employee as never }, limit: 1 })),
          ];
          return row === undefined
            ? undefined
            : { calendar: row.calendar?.id ?? null, user: row.user?.id ?? null };
        });
  const schedule = await scheduleOf(env as never, {
    from,
    to,
    calendar: (person?.calendar as number | null | undefined) ?? null,
    user: (person?.user as number | null | undefined) ?? null,
  });
  return countWorkingDays(schedule, from, to);
}

/**
 * A date as `YYYY-MM-DD`. Date-only values read from PostgreSQL are local midnights: their local parts are the date
 * (`toISOString()` would move them a day back east of UTC).
 */
const iso = (v: unknown) => {
  if (!(v instanceof Date)) return String(v ?? '');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
};

export const HrDepartment = defineModel('hr.department', {
  label: 'Department',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  access: { 'hr.user': READ, 'hr.manager': ALL },
  fields: {
    name: f.char({ required: true }),
    parent: f.many2one('hr.department', { ondelete: 'restrict', label: 'Part of' }),
    head: f.many2one('hr.employee', { ondelete: 'set null', label: 'Head' }),
    /** Who approves for the department (approval levels by "the approvers of the requester's department"). */
    approvalUsers: f.many2many('res.users', {
      relation: 'hr_department_approval_user_rel',
      label: 'Approvers',
      help: 'People who approve for this department when an approval level asks for the department’s approvers.',
    }),
  },
});

export const HrJob = defineModel('hr.job', {
  label: 'Position',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  access: { 'hr.user': READ, 'hr.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    department: f.many2one('hr.department', { ondelete: 'set null' }),
  },
});

export const HrEmployeeTag = defineModel('hr.employee.tag', {
  label: 'Employee tag',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  access: { 'hr.user': READ, 'hr.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    color: f.integer({ default: 0, label: 'Colour' }),
  },
});

/** Employment types (RFC 0032 §3.2): permanent, contractual, casual… with a code and the country they apply in. */
export const HrContractType = defineModel('hr.contract.type', {
  label: 'Employment type',
  recName: 'name',
  order: ['sequence asc', 'name asc'],
  archivable: true,
  access: { 'hr.user': READ, 'hr.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    code: f.char({ size: 20, help: 'A short code used in reports and payroll files.' }),
    country: f.char({
      size: 2,
      help: 'The country whose labour law the type follows, as its two-letter code (BD, IN); empty: any.',
    }),
    sequence: f.integer({ default: 10 }),
  },
});

export const HrEmployee = defineModel('hr.employee', {
  label: 'Employee',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['department', 'job', 'manager', 'unitHead', 'expenseApprover', 'leaveApprover'],
  access: { 'hr.user': READ, 'hr.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true }),
    jobTitle: f.char({
      label: 'Job title',
      help: 'As printed on cards and letters; the position may differ.',
    }),
    /** The person's sign-in, when they have one. */
    user: f.many2one('res.users', { ondelete: 'set null', label: 'User' }),
    department: f.many2one('hr.department', { ondelete: 'set null' }),
    job: f.many2one('hr.job', { ondelete: 'set null', label: 'Position' }),
    manager: f.many2one('hr.employee', { ondelete: 'set null' }),
    team: f.one2many('hr.employee', 'manager', { label: 'Team' }),
    unitHead: f.many2one('hr.employee', {
      ondelete: 'set null',
      label: 'Unit head',
      help: 'The head of the person’s unit (a plant, a depot, a farm), beside the line manager; approvals may ask them.',
    }),
    coach: f.many2one('hr.employee', { ondelete: 'set null' }),
    property: f.char({
      label: 'Property',
      help: 'The property or unit the person works for (a mill, a farm, a depot).',
    }),
    tags: f.many2many('hr.employee.tag', { relation: 'hr_employee_tag_rel' }),
    workEmail: f.char({ label: 'Work email' }),
    workPhone: f.char({ label: 'Work phone' }),
    mobile: f.char({ label: 'Work mobile' }),
    expenseApprover: f.many2one('res.users', {
      ondelete: 'set null',
      label: 'Expense approver',
      help: 'Approves this person’s expense reports first (else the Spend approvers).',
    }),
    leaveApprover: f.many2one('res.users', {
      ondelete: 'set null',
      label: 'Leave approver',
      help: 'Decides this person’s leave beside HR managers.',
    }),
    calendar: f.many2one('work.calendar', {
      ondelete: 'set null',
      label: 'Working calendar',
      help: 'The days and hours this person works; empty: the company’s calendar. Leave counts its working days.',
    }),
    timezone: f.char({
      label: 'Time zone',
      default: 'Asia/Dhaka',
      help: 'An IANA time zone (Asia/Dhaka, Asia/Kolkata): the person’s working hours and reminders follow it.',
    }),
    hireDate: f.date({ label: 'Joined' }),
    // Personal: HR managers only.
    birthday: f.date({ groups: HR }),
    nationalId: f.char({ label: 'National ID', groups: HR }),
    privateAddress: f.text({ label: 'Home address', groups: HR }),
    emergencyContact: f.char({ label: 'Emergency contact', groups: HR }),
  },
  constraints: {
    oneEmployeePerUser: {
      ...check('hr.employee', ['user'], async (employees) =>
        employees.env.asSuperuser({ reason: 'one employee per user' }, async (su) => {
          const failing: number[] = [];
          for (const e of employees) {
            if (e.user === null) continue;
            const twins = await su
              .withFlags({ activeTest: false })
              .model('hr.employee')
              .search({ where: { user: e.user.id, id: { ne: e.id } }, limit: 1 });
            if (twins.length > 0) failing.push(e.id);
          }
          return failing;
        }),
      ),
      message: 'This user is already another employee.',
    },
  },
});

export const HrContract = defineModel('hr.contract', {
  label: 'Contract',
  recName: 'name',
  order: ['dateStart desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'dateEnd', 'wage'],
  access: { 'hr.user': READ, 'hr.manager': ALL },
  rules: {
    own: { groups: ['hr.user'], perms: ['read'], domain: { 'employee.user': me } },
    all: { groups: ['hr.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, label: 'Reference' }),
    employee: f.many2one('hr.employee', { required: true, ondelete: 'cascade' }),
    employmentType: f.many2one('hr.contract.type', {
      ondelete: 'restrict',
      label: 'Employment type',
    }),
    kind: f.selection(
      { permanent: 'Permanent', fixed: 'Fixed term', probation: 'Probation', intern: 'Internship' },
      {
        required: true,
        default: 'permanent',
        label: 'Type',
        help: 'The kind of employment the contract is for: permanent, a fixed term, probation or an internship.',
      },
    ),
    dateStart: f.date({ required: true, label: 'Starts' }),
    dateEnd: f.date({ label: 'Ends' }),
    /** How the wage is counted (RFC 0039 §4): permanent staff by the month, casual and temporary people by the day or the hour. */
    payBasis: f.selection(
      { month: 'Per month', day: 'Per day worked', hour: 'Per hour worked' },
      {
        required: true,
        default: 'month',
        label: 'Paid',
        help: 'Whether the wage is for a month, for each day worked or for each hour worked. Payroll reads it as PAID_BY_DAY and PAID_BY_HOUR.',
      },
    ),
    wage: f.decimal({
      scale: 2,
      label: 'Wage',
      help: 'For a month, a day or an hour, as *Paid* says.',
      groups: HR,
    }),
    state: f.state({
      help: 'A contract runs once started, until it is ended or cancelled.',
      states: { draft: 'Draft', running: 'Running', ended: 'Ended', cancelled: 'Cancelled' },
      initial: 'draft',
      transitions: {
        start: { from: ['draft'], to: 'running' },
        end: { from: ['running'], to: 'ended' },
        cancel: { from: ['draft', 'running'], to: 'cancelled' },
      },
    }),
  },
  sqlConstraints: {
    endsAfterStart: {
      check: orm.sql`date_end IS NULL OR date_end >= date_start`,
      message: 'A contract ends after it starts.',
    },
  },
});

export const HrLeaveType = defineModel('hr.leave.type', {
  label: 'Leave type',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  access: { 'hr.user': READ, 'hr.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    /** Days per calendar year for each person; empty: no balance (unpaid leave). */
    daysPerYear: f.integer({ label: 'Days per year' }),
  },
});

export const HrLeave = defineModel('hr.leave', {
  label: 'Leave',
  order: ['dateFrom desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'dateFrom', 'dateTo'],
  access: { 'hr.user': ALL, 'hr.manager': ALL },
  rules: {
    // One's own requests in full; changed while still a draft.
    seeOwn: { groups: ['hr.user'], perms: ['read'], domain: { 'employee.user': me } },
    draftOwn: {
      groups: ['hr.user'],
      perms: ['write', 'create', 'unlink'],
      domain: { 'employee.user': me, state: 'draft' },
    },
    // Line managers see their team's.
    team: { groups: ['hr.user'], perms: ['read'], domain: { 'employee.manager.user': me } },
    // The employee's leave approver decides their requests.
    approver: {
      groups: ['hr.user'],
      perms: ['read', 'write'],
      domain: { 'employee.leaveApprover': me, state: { in: ['submitted', 'approved', 'refused'] } },
    },
    all: { groups: ['hr.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    employee: f.many2one('hr.employee', { required: true, ondelete: 'cascade' }),
    type: f.many2one('hr.leave.type', { required: true, ondelete: 'restrict', label: 'Type' }),
    dateFrom: f.date({ required: true, label: 'From' }),
    dateTo: f.date({ required: true, label: 'To' }),
    /** Working days, by the company's week; checked by the server. */
    days: f.integer({ required: true, default: 0, label: 'Working days' }),
    reason: f.text(),
    state: f.state({
      help: 'A request waits once submitted, and someone other than the requester approves or refuses it.',
      states: { draft: 'Draft', submitted: 'Waiting', approved: 'Approved', refused: 'Refused' },
      initial: 'draft',
      transitions: {
        submit: { from: ['draft'], to: 'submitted' },
        // Never by the person asking, HR managers included; by an HR manager or the employee's leave approver.
        approve: {
          from: ['submitted'],
          to: 'approved',
          guard: records('hr.leave', (leaves) => undecidable(leaves)),
          message:
            'Your own leave is decided by someone else; others’ by an HR manager or their leave approver.',
        },
        refuse: {
          from: ['submitted'],
          to: 'refused',
          guard: records('hr.leave', (leaves) => undecidable(leaves)),
          message:
            'Your own leave is decided by someone else; others’ by an HR manager or their leave approver.',
        },
        redraft: { from: ['submitted', 'refused'], to: 'draft' },
      },
    }),
  },
  sqlConstraints: {
    ordered: {
      check: orm.sql`date_to >= date_from`,
      message: 'A leave ends on or after it starts.',
    },
  },
  constraints: {
    // The days the form says are the working days the server counts.
    workingDays: {
      ...check('hr.leave', ['employee', 'dateFrom', 'dateTo', 'days'], async (leaves) => {
        const failing: number[] = [];
        for (const l of leaves) {
          const days = await leaveDays(
            leaves.env,
            l.employee.id as number,
            iso(l.dateFrom),
            iso(l.dateTo),
          );
          if (days === 0 || l.days !== days) failing.push(l.id);
        }
        return failing;
      }),
      message: 'The working days do not match the dates (or none falls on a working day).',
    },
    noOverlap: {
      ...check('hr.leave', ['employee', 'dateFrom', 'dateTo', 'state'], async (leaves) =>
        leaves.env.asSuperuser({ reason: 'overlapping leave' }, async (su) => {
          const failing: number[] = [];
          for (const l of leaves) {
            if (l.state === 'refused') continue;
            const clash = await su.model('hr.leave').search({
              where: {
                employee: l.employee.id,
                id: { ne: l.id },
                state: { in: ['draft', 'submitted', 'approved'] },
                dateFrom: { lte: l.dateTo },
                dateTo: { gte: l.dateFrom },
              },
              limit: 1,
            });
            if (clash.length > 0) failing.push(l.id);
          }
          return failing;
        }),
      ),
      message: 'This person already has leave on some of these days.',
    },
    // The days left of its type: what is waiting and approved, this one included (see `overBalance`).
    balance: {
      ...check('hr.leave', ['employee', 'type', 'days', 'dateFrom', 'state'], (leaves) =>
        (leaves as unknown as { overBalance(): Promise<number[]> }).overBalance(),
      ),
      message: 'Not enough days left of this leave type.',
    },
  },
  methods: {
    /**
     * Of these requests, those that ask for more days than are left. Here: a type's days per calendar year. An
     * app that keeps balances another way overrides it for its types (leave accruals: the ledger's balance on
     * the day the leave starts).
     */
    overBalance: method('hr.leave', async function (this: unknown): Promise<number[]> {
      const leaves = this as Records<'hr.leave'>;
      return leaves.env.asSuperuser({ reason: 'leave balance' }, async (su) => {
        const failing: number[] = [];
        for (const l of leaves) {
          if (l.state !== 'submitted' && l.state !== 'approved') continue;
          const [type] = (
            await su.model('hr.leave.type').browse([l.type.id]).load(['daysPerYear'])
          ).read(['daysPerYear']);
          const allowed = type?.['daysPerYear'];
          if (allowed === null || allowed === undefined) continue;
          const year = iso(l.dateFrom).slice(0, 4);
          const taken = (
            await (
              await su.model('hr.leave').search({
                where: {
                  employee: l.employee.id,
                  type: l.type.id,
                  state: { in: ['submitted', 'approved'] },
                  dateFrom: { gte: `${year}-01-01`, lte: `${year}-12-31` },
                },
              })
            ).load(['days'])
          )
            .read(['days'])
            .reduce((sum, r) => sum + Number(r['days'] ?? 0), 0);
          if (taken > Number(allowed)) failing.push(l.id);
        }
        return failing;
      });
    }),
  },
  onchange: {
    dateFrom: onchange('hr.leave', async (d, env): Promise<void> => fillDays(d, env)),
    dateTo: onchange('hr.leave', async (d, env): Promise<void> => fillDays(d, env)),
    employee: onchange('hr.leave', async (d, env): Promise<void> => fillDays(d, env)),
  },
});

const TOUR_DECIDES =
  'Your own tour is decided by someone else; others’ by an HR manager or their leave approver.';

/**
 * An official tour (RFC 0037 §3): a person sent away on the company's business for some days — where to, why, how
 * they travel, the advance they ask for — approved by their leave approver or HR, never by themselves. Attendance
 * reads approved tours: a working day on tour without a punch is *On tour*, not absent.
 */
export const HrTour = defineModel('hr.tour', {
  label: 'Tour',
  recName: 'name',
  order: ['dateFrom desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'dateFrom', 'dateTo'],
  access: { 'hr.user': ALL, 'hr.manager': ALL },
  rules: {
    seeOwn: { groups: ['hr.user'], perms: ['read'], domain: { 'employee.user': me } },
    draftOwn: {
      groups: ['hr.user'],
      perms: ['write', 'create', 'unlink'],
      domain: { 'employee.user': me, state: 'draft' },
    },
    team: { groups: ['hr.user'], perms: ['read'], domain: { 'employee.manager.user': me } },
    // Who decides writes the decision: the leave approver, else the manager (the guard says which of the two).
    approver: {
      groups: ['hr.user'],
      perms: ['read', 'write'],
      domain: {
        or: [{ 'employee.leaveApprover': me }, { 'employee.manager.user': me }],
        state: { in: ['submitted', 'approved', 'refused', 'cancelled'] },
      },
    },
    all: { groups: ['hr.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, sequence: 'hr.tour', label: 'Reference' }),
    employee: f.many2one('hr.employee', { required: true, ondelete: 'cascade' }),
    dateFrom: f.date({ required: true, label: 'From' }),
    dateTo: f.date({ required: true, label: 'To' }),
    days: f.integer({
      store: true,
      label: 'Working days',
      help: 'The working days of the person’s calendar inside the tour: what Attendance counts as on tour.',
      ...compute('hr.tour', 'days', ['employee', 'dateFrom', 'dateTo'], async (tours) => {
        for (const t of tours)
          t.days =
            t.dateFrom === null || t.dateTo === null || t.employee === null
              ? 0
              : await leaveDays(tours.env, t.employee.id as number, iso(t.dateFrom), iso(t.dateTo));
      }),
    }),
    places: f.char({ required: true, label: 'Where to', help: 'The places visited, in order.' }),
    purpose: f.text({ required: true }),
    travelBy: f.selection(
      {
        road: 'Road',
        rail: 'Rail',
        air: 'Air',
        water: 'Water',
        own: 'Own vehicle',
        company: 'Company vehicle',
      },
      {
        label: 'Travels by',
        help: 'How the person travels: it decides what the allowance covers.',
      },
    ),
    advanceAmount: f.decimal({
      scale: 2,
      label: 'Advance asked',
      help: 'Cash the person needs before leaving; with Spend, an approved tour drafts the cash advance.',
    }),
    decisionNote: f.char({
      label: 'Note of the decision',
      help: 'Why it was refused or cancelled (needed), or a word with the approval.',
    }),
    state: f.state({
      help: 'A request waits once submitted; someone other than the traveller approves or refuses it.',
      states: {
        draft: 'Draft',
        submitted: 'Waiting',
        approved: 'Approved',
        refused: 'Refused',
        cancelled: 'Cancelled',
      },
      initial: 'draft',
      transitions: {
        submit: emitting('hr.tour.submitted', { from: ['draft'], to: 'submitted' }),
        approve: emitting('hr.tour.approved', {
          from: ['submitted'],
          to: 'approved',
          guard: records('hr.tour', (tours) => undecidable(tours, 'hr.tour', 'hr.tour_decide')),
          message: TOUR_DECIDES,
        }),
        refuse: {
          from: ['submitted'],
          to: 'refused',
          guard: records('hr.tour', (tours) => undecidable(tours, 'hr.tour', 'hr.tour_decide')),
          message: TOUR_DECIDES,
        },
        // Called off after approval: by who could have approved it.
        cancel: emitting('hr.tour.cancelled', {
          from: ['approved'],
          to: 'cancelled',
          guard: records('hr.tour', (tours) => undecidable(tours, 'hr.tour', 'hr.tour_decide')),
          message: TOUR_DECIDES,
        }),
        redraft: { from: ['submitted', 'refused'], to: 'draft' },
      },
    }),
  },
  sqlConstraints: {
    ordered: {
      check: orm.sql`date_to >= date_from`,
      message: 'A tour ends on or after it starts.',
    },
    advance: {
      check: orm.sql`advance_amount IS NULL OR advance_amount >= 0`,
      message: 'An advance is not negative.',
    },
  },
  constraints: {
    said: {
      ...check('hr.tour', ['state', 'decisionNote'], async (tours) =>
        [...tours]
          .filter(
            (t) =>
              (t.state === 'refused' || t.state === 'cancelled') &&
              (t.decisionNote ?? '').trim() === '',
          )
          .map((t) => t.id),
      ),
      message: 'Say why in the note of the decision first.',
    },
    noOverlap: {
      ...check('hr.tour', ['employee', 'dateFrom', 'dateTo', 'state'], async (tours) =>
        tours.env.asSuperuser({ reason: 'overlapping tours and leave' }, async (su) => {
          const failing: number[] = [];
          for (const t of tours) {
            if (t.state === 'refused' || t.state === 'cancelled') continue;
            const during = { dateFrom: { lte: t.dateTo }, dateTo: { gte: t.dateFrom } };
            const tour = await su.model('hr.tour').search({
              where: {
                employee: t.employee.id,
                id: { ne: t.id },
                state: { in: ['draft', 'submitted', 'approved'] },
                ...during,
              },
              limit: 1,
            });
            const leave = await su.model('hr.leave').search({
              where: { employee: t.employee.id, state: 'approved', ...during },
              limit: 1,
            });
            if (tour.length > 0 || leave.length > 0) failing.push(t.id);
          }
          return failing;
        }),
      ),
      message: 'This person already has a tour or approved leave on some of these days.',
    },
  },
});

const REMOTE_DECIDES =
  'Your own home-office request is decided by someone else; others’ by an HR manager or their leave approver.';

/**
 * Home office (RFC 0039 §3): a person works from home for a day or some days — why — approved by their leave
 * approver, their manager or HR, never by themselves. Attendance reads approved requests: the day is *Home
 * office* — present, wherever the person checks in from, and without a check-in too — and Payroll counts it
 * (`REMOTE_DAYS`).
 */
export const HrRemote = defineModel('hr.remote', {
  label: 'Home office',
  recName: 'name',
  order: ['dateFrom desc', 'id desc'],
  companyScoped: { required: true },
  access: { 'hr.user': ALL, 'hr.manager': ALL },
  rules: {
    seeOwn: { groups: ['hr.user'], perms: ['read'], domain: { 'employee.user': me } },
    draftOwn: {
      groups: ['hr.user'],
      perms: ['write', 'create', 'unlink'],
      domain: { 'employee.user': me, state: 'draft' },
    },
    team: { groups: ['hr.user'], perms: ['read'], domain: { 'employee.manager.user': me } },
    approver: {
      groups: ['hr.user'],
      perms: ['read', 'write'],
      domain: {
        or: [{ 'employee.leaveApprover': me }, { 'employee.manager.user': me }],
        state: { in: ['submitted', 'approved', 'refused', 'cancelled'] },
      },
    },
    all: { groups: ['hr.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, sequence: 'hr.remote', label: 'Reference' }),
    employee: f.many2one('hr.employee', { required: true, ondelete: 'cascade' }),
    dateFrom: f.date({ required: true, label: 'From' }),
    dateTo: f.date({ required: true, label: 'To' }),
    days: f.integer({
      store: true,
      label: 'Working days',
      help: 'The working days of the person’s calendar inside the request: what Attendance counts as home office.',
      ...compute('hr.remote', 'days', ['employee', 'dateFrom', 'dateTo'], async (requests) => {
        for (const r of requests)
          r.days =
            r.dateFrom === null || r.dateTo === null || r.employee === null
              ? 0
              : await leaveDays(
                  requests.env,
                  r.employee.id as number,
                  iso(r.dateFrom),
                  iso(r.dateTo),
                );
      }),
    }),
    reason: f.text({ required: true, label: 'Why' }),
    decisionNote: f.char({
      label: 'Note of the decision',
      help: 'Why it was refused or cancelled (needed), or a word with the approval.',
    }),
    state: f.state({
      help: 'A request waits once submitted; someone other than the person approves or refuses it.',
      states: {
        draft: 'Draft',
        submitted: 'Waiting',
        approved: 'Approved',
        refused: 'Refused',
        cancelled: 'Cancelled',
      },
      initial: 'draft',
      transitions: {
        submit: emitting('hr.remote.submitted', { from: ['draft'], to: 'submitted' }),
        approve: emitting('hr.remote.approved', {
          from: ['submitted'],
          to: 'approved',
          guard: records('hr.remote', (requests) =>
            undecidable(requests, 'hr.remote', 'hr.remote_decide'),
          ),
          message: REMOTE_DECIDES,
        }),
        refuse: {
          from: ['submitted'],
          to: 'refused',
          guard: records('hr.remote', (requests) =>
            undecidable(requests, 'hr.remote', 'hr.remote_decide'),
          ),
          message: REMOTE_DECIDES,
        },
        // Called off after approval: by who could have approved it.
        cancel: emitting('hr.remote.cancelled', {
          from: ['approved'],
          to: 'cancelled',
          guard: records('hr.remote', (requests) =>
            undecidable(requests, 'hr.remote', 'hr.remote_decide'),
          ),
          message: REMOTE_DECIDES,
        }),
        redraft: { from: ['submitted', 'refused'], to: 'draft' },
      },
    }),
  },
  sqlConstraints: {
    ordered: {
      check: orm.sql`date_to >= date_from`,
      message: 'A home-office request ends on or after it starts.',
    },
  },
  constraints: {
    said: {
      ...check('hr.remote', ['state', 'decisionNote'], async (requests) =>
        [...requests]
          .filter(
            (r) =>
              (r.state === 'refused' || r.state === 'cancelled') &&
              (r.decisionNote ?? '').trim() === '',
          )
          .map((r) => r.id),
      ),
      message: 'Say why in the note of the decision first.',
    },
    noOverlap: {
      ...check('hr.remote', ['employee', 'dateFrom', 'dateTo', 'state'], async (requests) =>
        requests.env.asSuperuser(
          { reason: 'overlapping home office, tours and leave' },
          async (su) => {
            const failing: number[] = [];
            for (const r of requests) {
              if (r.state === 'refused' || r.state === 'cancelled') continue;
              const during = { dateFrom: { lte: r.dateTo }, dateTo: { gte: r.dateFrom } };
              const other = await su.model('hr.remote').search({
                where: {
                  employee: r.employee.id,
                  id: { ne: r.id },
                  state: { in: ['draft', 'submitted', 'approved'] },
                  ...during,
                },
                limit: 1,
              });
              const tour = await su.model('hr.tour').search({
                where: { employee: r.employee.id, state: 'approved', ...during },
                limit: 1,
              });
              const leave = await su.model('hr.leave').search({
                where: { employee: r.employee.id, state: 'approved', ...during },
                limit: 1,
              });
              if (other.length > 0 || tour.length > 0 || leave.length > 0) failing.push(r.id);
            }
            return failing;
          },
        ),
      ),
      message:
        'This person already has home office, a tour or approved leave on some of these days.',
    },
  },
});

/**
 * The requests among `records` the acting user may not decide: their own, and — unless they hold the permission —
 * those of people whose leave approver they are not.
 */
async function undecidable(
  records: unknown,
  model: 'hr.leave' | 'hr.tour' | 'hr.remote' = 'hr.leave',
  permission: 'hr.leave_decide' | 'hr.tour_decide' | 'hr.remote_decide' = 'hr.leave_decide',
): Promise<number[]> {
  const { env, ids } = records as { env: Env; ids: readonly number[] };
  const decides = env.su || env.access.has(permission);
  return env.asSuperuser({ reason: 'who decides leave' }, async (su) => {
    const leaves = (
      await su
        .model(model)
        .browse([...ids] as never)
        .load(['employee'])
    ).read(['id', 'employee']);
    const people = new Map(
      (
        await su
          .model('hr.employee')
          .browse(leaves.map((l) => l['employee'] as never))
          .load(['user', 'leaveApprover', 'manager'])
      )
        .read(['id', 'user', 'leaveApprover', 'manager'])
        .map((e) => [e['id'], e]),
    );
    // A tour or a home-office request without a leave approver is decided by the person's manager (leave has
    // its own route for that).
    const managers = new Map(
      model === 'hr.leave'
        ? []
        : (
            await su
              .model('hr.employee')
              .browse(
                [...people.values()]
                  .map((e) => e['manager'])
                  .filter((m) => m !== null && m !== undefined) as never,
              )
              .load(['user'])
          )
            .read(['id', 'user'])
            .map((m) => [m['id'], m['user']] as const),
    );
    return leaves
      .filter((l) => {
        const person = people.get(l['employee']);
        const decider =
          model !== 'hr.leave'
            ? (person?.['leaveApprover'] ?? managers.get(person?.['manager'] as never) ?? null)
            : person?.['leaveApprover'];
        return person?.['user'] === env.uid || (!decides && decider !== env.uid);
      })
      .map((l) => l['id'] as number);
  });
}

/** The form's working days, from the dates and the person's working calendar. */
async function fillDays(
  d: { get(key: string): unknown; set(key: string, value: unknown): void },
  env: Env,
): Promise<void> {
  const from = d.get('dateFrom');
  const to = d.get('dateTo');
  if (from === null || from === undefined) return;
  if (to === null || to === undefined || iso(to) < iso(from)) d.set('dateTo', iso(from));
  const who = d.get('employee');
  const employee =
    who === null || who === undefined
      ? null
      : Number(typeof who === 'object' ? (who as { id: unknown }).id : who);
  d.set('days', await leaveDays(env, employee, iso(from), iso(d.get('dateTo') ?? from)));
}

export const hrShutro = defineModule({
  name: 'hr',
  version: '0.2.0',
  depends: [contactsShutro, messagingShutro, worktimeShutro],
  groups: [
    orm.defineGroup({
      code: 'hr.user',
      label: 'Employee',
      implies: ['messaging.user', 'worktime.user'],
    }),
    orm.defineGroup({
      code: 'hr.manager',
      label: 'HR manager',
      // HR sets the calendars, the holidays and people's exceptions.
      implies: ['hr.user', 'contacts.user', 'worktime.manager'],
    }),
  ],
  permissions: [
    orm.definePermission({
      code: 'hr.leave_decide',
      label: 'Approve and refuse leave',
      groups: ['hr.manager'],
    }),
    orm.definePermission({
      code: 'hr.tour_decide',
      label: 'Approve, refuse and cancel tours',
      groups: ['hr.manager'],
    }),
    orm.definePermission({
      code: 'hr.remote_decide',
      label: 'Approve, refuse and cancel home office',
      groups: ['hr.manager'],
    }),
  ],
  models: [
    HrDepartment,
    HrJob,
    HrEmployeeTag,
    HrContractType,
    HrEmployee,
    HrContract,
    HrLeaveType,
    HrLeave,
    HrTour,
    HrRemote,
  ],
  sequences: [
    orm.defineSequence({ code: 'hr.tour', prefix: 'TOUR/{year}/', padding: 4, reset: 'yearly' }),
    orm.defineSequence({ code: 'hr.remote', prefix: 'HO/{year}/', padding: 4, reset: 'yearly' }),
  ],
  data: [
    record(
      'hr.leave.type',
      'leave_casual',
      { name: 'Casual leave', daysPerYear: 10 },
      { noupdate: true },
    ),
    record(
      'hr.leave.type',
      'leave_sick',
      { name: 'Sick leave', daysPerYear: 14 },
      { noupdate: true },
    ),
    record(
      'hr.leave.type',
      'leave_annual',
      { name: 'Earned leave', daysPerYear: 20 },
      { noupdate: true },
    ),
    record('hr.leave.type', 'leave_unpaid', { name: 'Unpaid leave' }, { noupdate: true }),
    record(
      'hr.contract.type',
      'type_permanent',
      { name: 'Permanent', code: 'PERM', sequence: 1 },
      { noupdate: true },
    ),
    record(
      'hr.contract.type',
      'type_contractual',
      { name: 'Contractual', code: 'CONT', sequence: 2 },
      { noupdate: true },
    ),
    record(
      'hr.contract.type',
      'type_casual',
      { name: 'Casual (daily)', code: 'CASU', sequence: 3 },
      { noupdate: true },
    ),
    record(
      'hr.contract.type',
      'type_intern',
      { name: 'Intern', code: 'INTN', sequence: 4 },
      { noupdate: true },
    ),
    record(
      'hr.contract.type',
      'type_temporary',
      { name: 'Temporary', code: 'TEMP', sequence: 5 },
      { noupdate: true },
    ),
    record(
      'hr.contract.type',
      'type_part_time',
      { name: 'Part-time', code: 'PART', sequence: 6 },
      { noupdate: true },
    ),
    record(
      'hr.contract.type',
      'type_seasonal',
      { name: 'Seasonal', code: 'SEAS', sequence: 7 },
      { noupdate: true },
    ),
    record(
      'hr.contract.type',
      'type_outsourced',
      { name: 'Outsourced', code: 'OUTS', sequence: 8 },
      { noupdate: true },
    ),
  ],
});
