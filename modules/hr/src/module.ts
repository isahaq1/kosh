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

export const HrEmployee = defineModel('hr.employee', {
  label: 'Employee',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['department', 'job', 'manager'],
  access: { 'hr.user': READ, 'hr.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true }),
    /** The person's sign-in, when they have one. */
    user: f.many2one('res.users', { ondelete: 'set null', label: 'User' }),
    department: f.many2one('hr.department', { ondelete: 'set null' }),
    job: f.many2one('hr.job', { ondelete: 'set null', label: 'Position' }),
    manager: f.many2one('hr.employee', { ondelete: 'set null' }),
    team: f.one2many('hr.employee', 'manager', { label: 'Team' }),
    workEmail: f.char({ label: 'Work email' }),
    workPhone: f.char({ label: 'Work phone' }),
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
    kind: f.selection(
      { permanent: 'Permanent', fixed: 'Fixed term', probation: 'Probation', intern: 'Internship' },
      { required: true, default: 'permanent', label: 'Type' },
    ),
    dateStart: f.date({ required: true, label: 'Starts' }),
    dateEnd: f.date({ label: 'Ends' }),
    wage: f.decimal({ scale: 2, label: 'Monthly wage', groups: HR }),
    state: f.state({
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
      states: { draft: 'Draft', submitted: 'Waiting', approved: 'Approved', refused: 'Refused' },
      initial: 'draft',
      transitions: {
        submit: { from: ['draft'], to: 'submitted' },
        // Never by the person asking, HR managers included.
        approve: {
          from: ['submitted'],
          to: 'approved',
          requires: 'hr.leave_decide',
          guard: records('hr.leave', (leaves) => notOwn(leaves)),
          message: 'Someone else decides your leave.',
        },
        refuse: {
          from: ['submitted'],
          to: 'refused',
          requires: 'hr.leave_decide',
          guard: records('hr.leave', (leaves) => notOwn(leaves)),
          message: 'Someone else decides your leave.',
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
async function notOwn(records: unknown): Promise<number[]> {
  const { env, ids } = records as { env: Env; ids: readonly number[] };
  return env.asSuperuser({ reason: 'own leave' }, async (su) => {
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
          .load(['user'])
      )
        .read(['id', 'user'])
        .map((e) => [e['id'], e['user']]),
    );
    return leaves
      .filter((l) => people.get(l['employee']) === env.uid)
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
  version: '0.1.0',
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
  models: [HrDepartment, HrJob, HrEmployee, HrContract, HrLeaveType, HrLeave],
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
  ],
});
