/**
 * The data layer of Workforce (RFC 0021): departments as a tree, positions, employees (separate from users: an
 * employee may never sign in) with their manager, contracts, and leave. Personal details and wages are visible to
 * HR managers only (field security). A leave's working days follow the company's week (the weekend setting) and are
 * checked by the server; a request may not overlap another of the same person, nor go beyond the year's days of its
 * type. Approving and refusing need the decision permission (HR managers) or go through the line manager's route.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { installationSetting } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import {
  check,
  defineModel,
  defineModule,
  type Env,
  f,
  onchange,
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

/** The installation's weekend (App settings › Workforce). */
export async function weekendOf(env: Env): Promise<readonly number[]> {
  const choice = await installationSetting(env, 'hr.weekend', 'fri_sat');
  return WEEKENDS[String(choice)] ?? (WEEKENDS['fri_sat'] as readonly number[]);
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
    wage: f.decimal({ scale: 2, label: 'Monthly wage', groups: HR }),
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
      ...check('hr.leave', ['dateFrom', 'dateTo', 'days'], async (leaves) => {
        const weekend = await weekendOf(leaves.env);
        return [...leaves]
          .filter((l) => {
            const days = workingDays(iso(l.dateFrom), iso(l.dateTo), weekend);
            return days === 0 || l.days !== days;
          })
          .map((l) => l.id);
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
    // The year's days of its type: what is waiting and approved, this one included.
    balance: {
      ...check('hr.leave', ['employee', 'type', 'days', 'dateFrom', 'state'], async (leaves) =>
        leaves.env.asSuperuser({ reason: 'leave balance' }, async (su) => {
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
        }),
      ),
      message: 'Not enough days left of this leave type this year.',
    },
  },
  onchange: {
    dateFrom: onchange('hr.leave', async (d, env): Promise<void> => fillDays(d, env)),
    dateTo: onchange('hr.leave', async (d, env): Promise<void> => fillDays(d, env)),
  },
});

/** The leaves among `records` that the acting user asked for themself. */
async function undecidable(records: unknown): Promise<number[]> {
  const { env, ids } = records as { env: Env; ids: readonly number[] };
  const decides = env.su || env.access.has('hr.leave_decide');
  return env.asSuperuser({ reason: 'who decides leave' }, async (su) => {
    const leaves = (
      await su
        .model('hr.leave')
        .browse([...ids])
        .load(['employee'])
    ).read(['id', 'employee']);
    const people = new Map(
      (
        await su
          .model('hr.employee')
          .browse(leaves.map((l) => l['employee'] as never))
          .load(['user', 'leaveApprover'])
      )
        .read(['id', 'user', 'leaveApprover'])
        .map((e) => [e['id'], e]),
    );
    return leaves
      .filter((l) => {
        const person = people.get(l['employee']);
        return person?.['user'] === env.uid || (!decides && person?.['leaveApprover'] !== env.uid);
      })
      .map((l) => l['id'] as number);
  });
}

/** The form's working days, from the dates and the company's week. */
async function fillDays(
  d: { get(key: string): unknown; set(key: string, value: unknown): void },
  env: Env,
): Promise<void> {
  const from = d.get('dateFrom');
  const to = d.get('dateTo');
  if (from === null || from === undefined) return;
  if (to === null || to === undefined || iso(to) < iso(from)) d.set('dateTo', iso(from));
  d.set('days', workingDays(iso(from), iso(d.get('dateTo') ?? from), await weekendOf(env)));
}

export const hrShutro = defineModule({
  name: 'hr',
  version: '0.2.0',
  depends: [contactsShutro, messagingShutro],
  groups: [
    orm.defineGroup({ code: 'hr.user', label: 'Employee', implies: ['messaging.user'] }),
    orm.defineGroup({
      code: 'hr.manager',
      label: 'HR manager',
      implies: ['hr.user', 'contacts.user'],
    }),
  ],
  permissions: [
    orm.definePermission({
      code: 'hr.leave_decide',
      label: 'Approve and refuse leave',
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
  ],
});
