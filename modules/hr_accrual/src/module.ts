/**
 * The data layer of leave accruals (RFC 0034 §2.5): an **accrual plan** says how a leave type's days are earned —
 * a formula in Payroll's formula language, evaluated for each month —, with probation, a cap, the carry-over into a
 * new year and the expiry of what was carried. What a person earns, loses and is given goes to a **ledger**; their
 * **balance** is the ledger less the leave they took, kept per person and plan with the year's figures and what the
 * year's end will look like. A leave of a type with a plan is checked against the balance **on the day it starts**,
 * future accruals included.
 *
 * The arithmetic is in `accrual.ts`; here are the models, the monthly run and the projection.
 */
import { attendanceShutro } from '@kosh/attendance';
import { hrShutro, leaveDays } from '@kosh/hr';
import {
  evaluate,
  FormulaError,
  parse,
  payrollShutro,
  type SettlementLineInput,
  variablesOf,
} from '@kosh/payroll';
import { emitting } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import {
  check,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  type Records,
  records,
} from './.kosh/bindings.js';
import {
  type AccrualRules,
  type AccrualState,
  type CompLot,
  type CompUse,
  dayAfter,
  expireLots,
  type MonthInput,
  type Movement,
  monthEnd,
  monthsBetween,
  nextMonth,
  serviceMonthsAt,
  stepMonth,
} from './accrual.js';

/**
 * Fields the server maintains: written by its own code (as the system) and by Administrators only. An empty list
 * would mean *everyone* — Shutro reads no groups as no restriction.
 */
const SYSTEM = ['base.admin'] as const;

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const me = { $env: 'uid' } as const;
const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
/** Days as hundredths, and back. */
const cents = (value: Decimal | number | string | null | undefined): number =>
  value === null || value === undefined
    ? 0
    : Number(orm.toDecimal(value).times(100).toDecimalPlaces(0).toString());
const days = (hundredths: number): string => (hundredths / 100).toFixed(2);

/** What a plan's formula may read, for each month. */
export const ACCRUAL_VARIABLES = {
  SERVICE_MONTHS: 'Full months of service at the month’s end',
  SERVICE_YEARS: 'Full years of service at the month’s end',
  WORKED_DAYS:
    'Approved attendance days present or on tour in the month (the working days, for a month to come)',
  WORKING_DAYS: 'Working days of the month by the person’s calendar',
  MONTH: 'The month’s number, 1 to 12',
  BALANCE: 'The balance before the month’s accrual, in days',
} as const;

/** What the value of a day paid out may read. */
export const ENCASH_VARIABLES = {
  WAGE: 'The monthly wage of the person’s running contract',
  DAYS: 'The days paid out',
  BALANCE: 'The balance on the day, before the days are paid out',
  SERVICE_YEARS: 'Full years of service on the day',
} as const;

/** The first problem of a formula, or `null`: it parses, and reads only what a plan knows. */
export function formulaProblem(
  text: string,
  known: Readonly<Record<string, string>> = ACCRUAL_VARIABLES,
): string | null {
  try {
    const unknown = variablesOf(parse(text)).filter((v) => !(v in known));
    return unknown.length === 0 ? null : `Unknown: ${unknown.join(', ')}.`;
  } catch (error) {
    if (error instanceof FormulaError) return error.message;
    throw error;
  }
}

export const AccrualPlan = defineModel('hr.accrual.plan', {
  label: 'Accrual plan',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: [
    'formula',
    'cap',
    'carryOver',
    'carryExpiryMonth',
    'probationMonths',
    'encashable',
    'encashFormula',
    'compDays',
    'compMinHours',
    'compExpiryDays',
  ],
  access: { 'hr.user': READ, 'hr.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true }),
    type: f.many2one('hr.leave.type', {
      required: true,
      ondelete: 'restrict',
      label: 'Leave type',
      help: 'With a plan, the type’s days come from the plan and no longer from its days per year.',
    }),
    dateStart: f.date({
      required: true,
      default: (env: Env) => `${iso(env.today()).slice(0, 4)}-01-01`,
      label: 'Accrues from',
      help: 'The first month that accrues; earlier balances are given as adjustments.',
    }),
    formula: f.char({
      size: 500,
      required: true,
      default: '0',
      label: 'Days a month',
      help: 'In Payroll’s formula language, for each month: 10 / 12 — WORKED_DAYS / 18 — if(SERVICE_YEARS >= 5, 2, 1.5). It may read SERVICE_MONTHS, SERVICE_YEARS, WORKED_DAYS, WORKING_DAYS, MONTH and BALANCE.',
    }),
    probationMonths: f.integer({
      required: true,
      default: 0,
      label: 'Probation (months)',
      help: 'Nothing accrues before this many full months of service.',
    }),
    cap: f.decimal({
      scale: 2,
      label: 'Never above (days)',
      help: 'The balance stops accruing here; empty: no cap.',
    }),
    carryOver: f.decimal({
      scale: 2,
      label: 'Carried into a new year (days)',
      help: 'What is above it on 1 January is lost; empty: everything is carried, 0: nothing.',
    }),
    carryExpiryMonth: f.integer({
      label: 'Carried days expire after month',
      help: 'Carried days not used by the end of this month of the new year are lost (3: on 31 March); empty: never.',
    }),
    note: f.text({ label: 'Note', help: 'Where the rule comes from, and what to check.' }),
    compDays: f.decimal({
      scale: 2,
      label: 'Days for a day off worked',
      help: 'What a person earns for an approved attendance day worked on a weekend or a holiday (1: a day for a day); empty: nothing.',
    }),
    compMinHours: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Hours worked at least',
      help: 'A day off worked for fewer hours earns nothing.',
    }),
    compExpiryDays: f.integer({
      label: 'Earned days are lost after (days)',
      help: 'A day earned this way and not taken within so many days is lost, the oldest used first; empty: never.',
    }),
    encashable: f.boolean({
      default: false,
      label: 'Days may be paid out',
      help: 'People ask to be paid for days they did not take; HR approves, Payroll pays.',
    }),
    encashKeep: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Days that stay',
      help: 'The balance never goes below this by a payout.',
    }),
    encashFormula: f.char({
      size: 500,
      required: true,
      default: 'WAGE / 30',
      label: 'A day is worth',
      help: 'In Payroll’s formula language: WAGE / 30 — WAGE * 0.6 / 26. It may read WAGE, DAYS, BALANCE and SERVICE_YEARS.',
    }),
    encashCode: f.char({
      size: 40,
      required: true,
      default: 'LEAVE_ENCASH',
      label: 'Payroll input',
      help: 'The amount goes to Payroll as this input; the salary structure pays it with a rule that reads INPUT_ and this code.',
    }),
  },
  sqlConstraints: {
    sane: {
      check: orm.sql`probation_months >= 0 AND (cap IS NULL OR cap >= 0) AND (carry_over IS NULL OR carry_over >= 0)
        AND (carry_expiry_month IS NULL OR carry_expiry_month BETWEEN 1 AND 12)`,
      message:
        'Probation, the cap and the carry-over are not negative, and the expiry month is 1 to 12.',
    },
    compSane: {
      check: orm.sql`(comp_days IS NULL OR comp_days >= 0) AND comp_min_hours >= 0
        AND (comp_expiry_days IS NULL OR comp_expiry_days > 0)`,
      message:
        'The days for a day off worked and the hours are not negative; days are lost after at least one day.',
    },
  },
  constraints: {
    formulaReads: {
      ...check('hr.accrual.plan', ['formula'], (plans) =>
        plans.filter((p) => formulaProblem(p.formula) !== null),
      ),
      message:
        'The formula does not read: use numbers, + - * /, min, max, round, if(…), and SERVICE_MONTHS, SERVICE_YEARS, WORKED_DAYS, WORKING_DAYS, MONTH, BALANCE.',
    },
    encashReads: {
      ...check('hr.accrual.plan', ['encashFormula', 'encashCode'], (plans) =>
        plans.filter(
          (p) =>
            formulaProblem(p.encashFormula, ENCASH_VARIABLES) !== null ||
            !/^[A-Z][A-Z0-9_]*$/.test(p.encashCode),
        ),
      ),
      message:
        'The value of a day does not read (it may use WAGE, DAYS, BALANCE and SERVICE_YEARS), or the payroll input is not a code in capitals.',
    },
    onePerType: {
      ...check('hr.accrual.plan', ['type', 'active', 'company'], (plans) =>
        twins(plans.env as unknown as Env, plans.ids as readonly number[]),
      ),
      message: 'This leave type already has an active accrual plan.',
    },
  },
});

/** The active plans among `ids` whose leave type another active plan of the company has. */
async function twins(env: Env, ids: readonly number[]): Promise<number[]> {
  return env.asSuperuser({ reason: 'one plan per leave type' }, async (su) => {
    const out: number[] = [];
    const rows = (
      await su
        .model('hr.accrual.plan')
        .browse([...ids] as never)
        .load(['type', 'company', 'active'])
    ).read(['id', 'type', 'company', 'active']);
    for (const row of rows) {
      if (row['active'] !== true) continue;
      const others = await su.model('hr.accrual.plan').search({
        where: {
          type: row['type'] as never,
          company: row['company'] as never,
          active: true,
          id: { ne: row['id'] as never },
        } as never,
        limit: 1,
      });
      if (others.length > 0) out.push(Number(row['id']));
    }
    return out;
  });
}

const ENTRY_KINDS = {
  accrual: 'Accrued',
  lapse: 'Lost at the year’s start',
  expiry: 'Carried days expired',
  adjustment: 'Adjustment',
  encashment: 'Paid out',
  compensatory: 'Earned on a day off',
  comp_expiry: 'Earned days lost',
} as const;

/** The ledger: every day earned, lost, given or paid out. Never changed: a mistake is another line. */
export const AccrualEntry = defineModel('hr.accrual.entry', {
  label: 'Leave ledger line',
  order: ['date desc', 'id desc'],
  companyScoped: { required: true },
  access: { 'hr.user': READ, 'hr.manager': ['read', 'create', 'export', 'import'] },
  rules: {
    own: { groups: ['hr.user'], perms: ['read'], domain: { 'employee.user': me } },
    team: { groups: ['hr.user'], perms: ['read'], domain: { 'employee.manager.user': me } },
    all: { groups: ['hr.manager'], perms: ['read', 'create'], domain: {} },
  },
  fields: {
    employee: f.many2one('hr.employee', { required: true, ondelete: 'cascade' }),
    plan: f.many2one('hr.accrual.plan', {
      required: true,
      ondelete: 'restrict',
      checkCompany: true,
    }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    kind: f.selection(ENTRY_KINDS, {
      required: true,
      default: 'adjustment',
      groups: { write: [...SYSTEM] },
      help: 'Accrued, lost and expired lines are the server’s; a line added by hand is an adjustment.',
    }),
    days: f.decimal({
      scale: 2,
      required: true,
      label: 'Days',
      help: 'Above zero: earned or given; below: lost, taken back or paid out.',
    }),
    period: f.char({ size: 7, label: 'Period', groups: { write: [...SYSTEM] } }),
    note: f.char({ label: 'Why' }),
    /** The attendance day a compensatory day was earned on — and of the line that loses it. */
    source: f.many2one('attendance.day', {
      ondelete: 'set null',
      index: true,
      label: 'Attendance day',
      help: 'The day off that was worked: it earns once, and what is left of it is lost once.',
      groups: { write: [...SYSTEM] },
    }),
  },
  sqlConstraints: {
    notZero: {
      check: orm.sql`days <> 0`,
      message: 'A ledger line moves at least a hundredth of a day.',
    },
    // An attendance day earns once and loses what is left of it once, whatever runs twice.
    oncePerDay: {
      unique: ['source', 'kind'],
      message: 'This attendance day already has this line in the ledger.',
    },
  },
});

/** Where a person stands in a plan: today, this year, and at the year's end. */
export const AccrualBalance = defineModel('hr.accrual.balance', {
  label: 'Leave balance',
  order: ['employee asc', 'plan asc'],
  companyScoped: { required: true },
  access: { 'hr.user': READ, 'hr.manager': ['read', 'export'] },
  rules: {
    own: { groups: ['hr.user'], perms: ['read'], domain: { 'employee.user': me } },
    team: { groups: ['hr.user'], perms: ['read'], domain: { 'employee.manager.user': me } },
    all: { groups: ['hr.manager'], perms: ['read'], domain: {} },
  },
  fields: {
    employee: f.many2one('hr.employee', { required: true, ondelete: 'cascade' }),
    plan: f.many2one('hr.accrual.plan', { required: true, ondelete: 'cascade' }),
    type: f.many2one('hr.leave.type', { ondelete: 'cascade', label: 'Leave type' }),
    accruedThrough: f.char({ size: 7, label: 'Accrued through' }),
    carried: f.decimal({ scale: 2, label: 'Carried, still to use' }),
    balance: f.decimal({
      scale: 2,
      label: 'Balance',
      help: 'Earned, given and lost so far, less the approved leave that has started.',
    }),
    available: f.decimal({
      scale: 2,
      label: 'Available',
      help: 'The balance less leave waiting for approval and approved leave still to come.',
    }),
    accruedYear: f.decimal({ scale: 2, label: 'Accrued this year' }),
    takenYear: f.decimal({ scale: 2, label: 'Taken this year' }),
    yearEnd: f.decimal({
      scale: 2,
      label: 'On 31 December',
      help: 'The balance projected to the year’s end: the months to come by the plan, the leave already asked for.',
    }),
    expiring: f.decimal({
      scale: 2,
      label: 'Expiring',
      help: 'Carried days that are lost on the date beside it unless they are taken.',
    }),
    expiresOn: f.date({ label: 'Expire on' }),
  },
});

// ---- reading

interface PlanRow {
  readonly id: number;
  readonly type: number;
  readonly company: number;
  readonly start: string;
  readonly formula: string;
  readonly rules: AccrualRules;
  /** Compensatory days: hundredths earned for a day off worked (0: none), the hours needed, the days they last. */
  readonly comp: {
    readonly days: number;
    readonly minHours: string;
    readonly expiryDays: number | null;
  };
}

const planRow = (p: {
  id: unknown;
  type: { id: unknown };
  company: { id: unknown };
  dateStart: unknown;
  formula: string;
  probationMonths: number;
  cap: Decimal | null;
  carryOver: Decimal | null;
  carryExpiryMonth: number | null;
  compDays: Decimal | null;
  compMinHours: Decimal | null;
  compExpiryDays: number | null;
}): PlanRow => ({
  comp: {
    days: cents(p.compDays),
    minHours: (p.compMinHours ?? orm.toDecimal(0)).toString(),
    expiryDays: p.compExpiryDays,
  },
  id: p.id as number,
  type: p.type.id as number,
  company: p.company.id as number,
  start: iso(p.dateStart).slice(0, 7),
  formula: p.formula,
  rules: {
    probationMonths: p.probationMonths,
    cap: p.cap === null ? null : cents(p.cap),
    carryOver: p.carryOver === null ? null : cents(p.carryOver),
    carryExpiryMonth: p.carryExpiryMonth,
  },
});

/** The active plan of a leave type in a company, if it has one. */
async function planOf(su: Env, type: number, company: number): Promise<PlanRow | null> {
  const [p] = await su
    .model('hr.accrual.plan')
    .search({
      where: { type: type as never, company: company as never, active: true } as never,
      limit: 1,
    })
    .then((found) => found.load(['type', 'company']));
  return p === undefined ? null : planRow(p);
}

/** The ledger of a person in a plan, in hundredths, up to a day (included). */
async function ledgerTo(su: Env, employee: number, plan: number, to: string): Promise<number> {
  const rows = await su.model('hr.accrual.entry').search({
    where: { employee: employee as never, plan: plan as never, date: { lte: to } } as never,
  });
  return [...rows].reduce((sum, e) => sum + cents(e.days), 0);
}

/** The ledger of a person in a plan between two days (both included), in hundredths. */
async function ledgerBetween(
  su: Env,
  employee: number,
  plan: number,
  from: string,
  to: string,
): Promise<number> {
  if (to < from) return 0;
  const rows = await su.model('hr.accrual.entry').search({
    where: {
      employee: employee as never,
      plan: plan as never,
      date: { gte: from, lte: to },
    } as never,
  });
  return [...rows].reduce((sum, e) => sum + cents(e.days), 0);
}

/** Leave days of a type that start between two days (both included), in hundredths. */
async function takenBetween(
  su: Env,
  employee: number,
  type: number,
  from: string,
  to: string,
  states: readonly string[],
): Promise<number> {
  if (to < from) return 0;
  const rows = await (
    await su.model('hr.leave').search({
      where: {
        employee: employee as never,
        type: type as never,
        state: { in: states },
        dateFrom: { gte: from, lte: to },
      } as never,
    })
  ).load(['days', 'half']);
  // Half a day of leave takes half a day (RFC 0039 §4).
  return [...rows].reduce(
    (sum, l) => sum + (l.half === null ? Math.round(Number(l.days ?? 0) * 100) : 50),
    0,
  );
}

const APPROVED = ['approved'] as const;
const ASKED = ['submitted', 'approved'] as const;

/**
 * What a month is to a plan: the formula's days for the person — from their attendance when the month is over,
 * from their working days when it is still to come —, the leave that starts in it, their service at its end.
 */
async function monthInput(
  su: Env,
  plan: PlanRow,
  employee: { readonly id: number; readonly joined: string },
  month: string,
  balance: number,
  options: { readonly expected: boolean; readonly states: readonly string[]; readonly to?: string },
): Promise<MonthInput> {
  const first = `${month}-01`;
  const last = monthEnd(month);
  const serviceMonths = serviceMonthsAt(employee.joined, month);
  const working = await leaveDays(su as never, employee.id, first, last);
  let worked = working;
  if (!options.expected) {
    const attendance = await su.model('attendance.day').search({
      where: {
        employee: employee.id as never,
        date: { gte: first, lte: last },
        state: 'approved',
        status: { in: ['present', 'tour'] },
      } as never,
    });
    worked = attendance.length;
  }
  const scope = {
    variables: new Map<string, Decimal>(
      Object.entries({
        SERVICE_MONTHS: serviceMonths,
        SERVICE_YEARS: Math.floor(serviceMonths / 12),
        WORKED_DAYS: worked,
        WORKING_DAYS: working,
        MONTH: Number(month.slice(5)),
        BALANCE: days(balance),
      }).map(([name, value]) => [name, orm.toDecimal(value)]),
    ),
    slabs: new Map(),
  };
  let accrued = 0;
  try {
    accrued = cents(evaluate(parse(plan.formula), scope).toDecimalPlaces(2));
  } catch (error) {
    // A division by zero in a month without working days: nothing accrues, rather than no run at all.
    if (!(error instanceof FormulaError)) throw error;
  }
  return {
    month,
    accrued,
    taken: await takenBetween(
      su,
      employee.id,
      plan.type,
      first,
      options.to ?? last,
      options.states,
    ),
    serviceMonths,
  };
}

// ---- the run

/** The month before `YYYY-MM`. */
const previousMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/** A person's balance record in a plan, made when missing. */
async function balanceRecord(
  su: Env,
  plan: PlanRow,
  employee: number,
): Promise<{ id: number; accruedThrough: string | null; carried: number }> {
  const [found] = await su.model('hr.accrual.balance').search({
    where: { employee: employee as never, plan: plan.id as never } as never,
    limit: 1,
  });
  if (found !== undefined)
    return {
      id: found.id as number,
      accruedThrough: found.accruedThrough,
      carried: cents(found.carried),
    };
  const made = await su
    .model('hr.accrual.balance')
    .create([{ employee, plan: plan.id, type: plan.type, company: plan.company } as never]);
  return { id: made.ids[0] as number, accruedThrough: null, carried: 0 };
}

/**
 * Writes a person's months that are over and not accrued yet to the ledger (RFC 0034 §2.5), from the plan's first
 * month or the month they joined: each month once — the balance record remembers the last one. Returns the lines.
 */
async function accruePerson(
  su: Env,
  plan: PlanRow,
  employee: { readonly id: number; readonly joined: string },
  today: string,
): Promise<number> {
  const record = await balanceRecord(su, plan, employee.id);
  const lastComplete = previousMonth(today.slice(0, 7));
  const joinedMonth = employee.joined.slice(0, 7);
  const begin = [
    plan.start,
    joinedMonth,
    record.accruedThrough === null ? '0000-00' : nextMonth(record.accruedThrough),
  ].reduce((a, b) => (a > b ? a : b));
  const months = monthsBetween(begin, lastComplete);
  if (months.length === 0) return 0;
  const before = iso(new Date(Date.parse(`${begin}-01T00:00:00Z`) - 86_400_000));
  let state: AccrualState = {
    balance:
      (await ledgerTo(su, employee.id, plan.id, before)) -
      (await takenBetween(su, employee.id, plan.type, '0001-01-01', before, APPROVED)),
    carried: record.carried,
  };
  const movements: Movement[] = [];
  for (const month of months) {
    // Adjustments given in the month count before its accrual (an opening balance meets the cap).
    const given = await ledgerBetween(su, employee.id, plan.id, `${month}-01`, monthEnd(month));
    state = { ...state, balance: state.balance + given };
    const input = await monthInput(su, plan, employee, month, state.balance, {
      expected: false,
      states: APPROVED,
    });
    const stepped = stepMonth(state, plan.rules, input);
    state = stepped.state;
    movements.push(...stepped.movements);
  }
  if (movements.length > 0)
    await su.model('hr.accrual.entry').create(
      movements.map((m) => ({
        employee: employee.id,
        plan: plan.id,
        company: plan.company,
        date: m.date,
        kind: m.kind,
        days: days(m.days),
        period: m.period,
        note: m.note === '' ? null : m.note,
      })) as never,
    );
  await su
    .model('hr.accrual.balance')
    .browse([record.id as never])
    .write({ accruedThrough: lastComplete, carried: days(state.carried) } as never);
  await su.flush();
  return movements.length;
}

/** A step of a projection, for whoever asks why. */
export interface ProjectionStep {
  readonly month: string;
  readonly accrued: string;
  readonly taken: string;
  readonly lost: string;
  readonly balance: string;
}

export interface Projection {
  readonly date: string;
  readonly balance: string;
  readonly steps: readonly ProjectionStep[];
  /** Carried days that will be lost, and when, unless they are taken. */
  readonly expiring: { readonly days: string; readonly on: string } | null;
}

/**
 * A person's balance in a plan on any day (RFC 0034 §2.5): from the ledger as it stands, the months since the last
 * accrual by the plan — the person's working days for the months to come —, less the leave waiting or approved
 * that starts by then; the month of the day itself counts its leave and the year's lapse, not its accrual.
 */
async function projectPerson(
  su: Env,
  plan: PlanRow,
  employee: { readonly id: number; readonly joined: string },
  date: string,
  today: string,
): Promise<Projection> {
  const record = await balanceRecord(su, plan, employee.id);
  const begin = [
    plan.start,
    employee.joined.slice(0, 7),
    record.accruedThrough === null ? '0000-00' : nextMonth(record.accruedThrough),
  ].reduce((a, b) => (a > b ? a : b));
  const before = iso(new Date(Date.parse(`${begin}-01T00:00:00Z`) - 86_400_000));
  const at = date < before ? date : before;
  let state: AccrualState = {
    balance:
      (await ledgerTo(su, employee.id, plan.id, at)) -
      (await takenBetween(su, employee.id, plan.type, '0001-01-01', at, ASKED)),
    carried: record.carried,
  };
  const steps: ProjectionStep[] = [];
  let expiring: Projection['expiring'] = null;
  const currentMonth = today.slice(0, 7);
  for (const month of monthsBetween(begin, date.slice(0, 7))) {
    const whole = monthEnd(month) <= date;
    // What HR gave in the month, up to the day, counts before its accrual: as the run will see it.
    const given = await ledgerBetween(
      su,
      employee.id,
      plan.id,
      `${month}-01`,
      whole ? monthEnd(month) : date,
    );
    state = { ...state, balance: state.balance + given };
    const input = await monthInput(su, plan, employee, month, state.balance, {
      expected: month >= currentMonth,
      states: ASKED,
      ...(whole ? {} : { to: date }),
    });
    const stepped = stepMonth(
      state,
      whole ? plan.rules : { ...plan.rules, carryExpiryMonth: null },
      whole ? input : { ...input, accrued: 0 },
    );
    const sum = (kind: string) =>
      stepped.movements.filter((m) => m.kind === kind).reduce((s, m) => s + m.days, 0);
    const expired = stepped.movements.find((m) => m.kind === 'expiry');
    if (expired !== undefined && expiring === null && expired.date >= today)
      expiring = { days: days(-expired.days), on: expired.date };
    state = stepped.state;
    steps.push({
      month,
      accrued: days(sum('accrual')),
      taken: days(input.taken),
      lost: days(-(sum('lapse') + sum('expiry'))),
      balance: days(state.balance),
    });
  }
  return { date, balance: days(state.balance), steps, expiring };
}

const personOf = (e: { id: unknown; hireDate: unknown }): { id: number; joined: string } | null =>
  e.hireDate === null || e.hireDate === undefined
    ? null
    : { id: e.id as number, joined: iso(e.hireDate) };

/** Where a person stands today, this year and at the year's end, written on their balance record. */
async function refreshPerson(
  su: Env,
  plan: PlanRow,
  employee: { readonly id: number; readonly joined: string },
  today: string,
): Promise<void> {
  const record = await balanceRecord(su, plan, employee.id);
  const year = today.slice(0, 4);
  const ledger = await ledgerTo(su, employee.id, plan.id, today);
  const started = await takenBetween(su, employee.id, plan.type, '0001-01-01', today, APPROVED);
  const asked = await takenBetween(su, employee.id, plan.type, '0001-01-01', '9999-12-31', ASKED);
  const accruedYear = [
    ...(await su.model('hr.accrual.entry').search({
      where: {
        employee: employee.id as never,
        plan: plan.id as never,
        kind: 'accrual',
        date: { gte: `${year}-01-01`, lte: today },
      } as never,
    })),
  ].reduce((sum, e) => sum + cents(e.days), 0);
  const takenYear = await takenBetween(
    su,
    employee.id,
    plan.type,
    `${year}-01-01`,
    `${year}-12-31`,
    APPROVED,
  );
  const end = await projectPerson(su, plan, employee, `${year}-12-31`, today);
  await su
    .model('hr.accrual.balance')
    .browse([record.id as never])
    .write({
      balance: days(ledger - started),
      available: days(ledger - asked),
      accruedYear: days(accruedYear),
      takenYear: days(takenYear),
      yearEnd: end.balance,
      expiring: end.expiring === null ? null : end.expiring.days,
      expiresOn: end.expiring === null ? null : end.expiring.on,
    } as never);
}

// ---- compensatory days

/** How many attendance days are credited in one go. */
const COMP_BATCH = 2000;

/**
 * Compensatory days (RFC 0039 §6): every **approved** attendance day worked on a day nothing was expected — a
 * weekend, a holiday — for at least the plan's hours earns the plan's days, dated that day, **once** (the ledger
 * line names the attendance day). Found by the database in one query per batch, whatever the head count. Returns
 * the lines written.
 */
async function creditDaysOff(su: Env, plan: PlanRow): Promise<number> {
  if (plan.comp.days <= 0) return 0;
  let lines = 0;
  for (;;) {
    await su.flush();
    const found = await su.sql<{ id: string | number; employee: string | number; date: string }>`
      SELECT d.id, d.employee_id AS employee, to_char(d.date, 'YYYY-MM-DD') AS date
        FROM attendance_day d
       WHERE d.company_id = ${plan.company}
         AND d.state = 'approved' AND d.worked_hours > 0 AND d.expected_hours = 0
         AND d.worked_hours >= ${plan.comp.minHours}::numeric
         AND d.date >= ${`${plan.start}-01`}::date
         AND NOT EXISTS (SELECT 1 FROM hr_accrual_entry e
                          WHERE e.source_id = d.id AND e.kind = 'compensatory')
       ORDER BY d.id
       LIMIT ${COMP_BATCH}`;
    if (found.length === 0) return lines;
    await su.model('hr.accrual.entry').create(
      found.map((d) => ({
        employee: Number(d.employee),
        plan: plan.id,
        company: plan.company,
        date: d.date,
        kind: 'compensatory',
        days: days(plan.comp.days),
        period: d.date.slice(0, 7),
        source: Number(d.id),
        note: 'A day off worked',
      })) as never,
    );
    lines += found.length;
    if (found.length < COMP_BATCH) {
      await su.flush();
      return lines;
    }
  }
}

/** For how long after its last day a credit is still looked at: the run comes by every six hours. */
const COMP_LOOK_BACK = 60;

/**
 * What compensatory days are lost by `today` (RFC 0039 §6): only the people with a credit whose last day has just
 * passed are looked at; for them the credits, the leave taken of the type and what was paid out or taken back
 * are read in sets, and `expireLots` — the oldest used first — says what each credit has left. Each loss is
 * written once (the line names the attendance day). Returns the lines written.
 */
async function expireCompensatory(su: Env, plan: PlanRow, today: string): Promise<number> {
  const lasts = plan.comp.expiryDays;
  if (lasts === null) return 0;
  await su.flush();
  const due = await su.sql<{ employee: string | number }>`
    SELECT DISTINCT e.employee_id AS employee
      FROM hr_accrual_entry e
     WHERE e.plan_id = ${plan.id} AND e.kind = 'compensatory' AND e.source_id IS NOT NULL
       AND e.date < ${dayAfter(today, -lasts)}::date
       AND e.date >= ${dayAfter(today, -lasts - COMP_LOOK_BACK)}::date
       AND NOT EXISTS (SELECT 1 FROM hr_accrual_entry x
                        WHERE x.source_id = e.source_id AND x.kind = 'comp_expiry')`;
  const people = due.map((d) => Number(d.employee));
  if (people.length === 0) return 0;
  const lots = new Map<number, CompLot[]>();
  const uses = new Map<number, CompUse[]>();
  const written = new Set<number>();
  const push = <T>(by: Map<number, T[]>, employee: number, value: T): void => {
    const list = by.get(employee);
    if (list === undefined) by.set(employee, [value]);
    else list.push(value);
  };
  for (const e of await (
    await su.model('hr.accrual.entry').search({
      where: { plan: plan.id as never, employee: { in: people } as never } as never,
    })
  ).load(['employee', 'source'])) {
    const employee = e.employee.id as number;
    const amount = cents(e.days);
    if (e.kind === 'compensatory' && e.source !== null)
      push(lots, employee, { key: e.source.id as number, date: iso(e.date), days: amount });
    else if (e.kind === 'comp_expiry' && e.source !== null) written.add(e.source.id as number);
    // Paid out or taken back: used, like leave.
    else if (amount < 0 && e.kind !== 'comp_expiry')
      push(uses, employee, { date: iso(e.date), days: -amount });
  }
  for (const l of await (
    await su.model('hr.leave').search({
      where: {
        employee: { in: people } as never,
        type: plan.type as never,
        state: 'approved',
      } as never,
    })
  ).load(['employee', 'dateFrom', 'days', 'half']))
    push(uses, l.employee.id as number, {
      date: iso(l.dateFrom),
      days: l.half === null ? Math.round(Number(l.days ?? 0) * 100) : 50,
    });
  const lost: Record<string, unknown>[] = [];
  for (const employee of people)
    for (const gone of expireLots(lots.get(employee) ?? [], uses.get(employee) ?? [], lasts, today))
      if (!written.has(gone.key))
        lost.push({
          employee,
          plan: plan.id,
          company: plan.company,
          date: gone.on,
          kind: 'comp_expiry',
          days: days(-gone.days),
          period: gone.on.slice(0, 7),
          source: gone.key,
          note: `Not taken within ${lasts} days`,
        });
  if (lost.length > 0) {
    await su.model('hr.accrual.entry').create(lost as never);
    await su.flush();
  }
  return lost.length;
}

/**
 * The monthly run (RFC 0034 §2.5), for the company of `env`: every active plan, every active employee with a
 * joining date — the months that are over go to the ledger, once, and each balance is brought up to date. Safe to
 * run any number of times a day. Returns the ledger lines written.
 */
export async function accrueLeave(env: Env, today: string = iso(env.today())): Promise<number> {
  return env.asSuperuser({ reason: 'leave accruals' }, async (su) => {
    const plans = await su
      .model('hr.accrual.plan')
      .search({ where: { active: true } as never })
      .then((found) => found.load(['type', 'company']));
    let lines = 0;
    for (const p of plans) {
      const plan = planRow(p);
      // Compensatory days first (RFC 0039 §6): the balances refreshed below see them.
      lines += await creditDaysOff(su, plan);
      lines += await expireCompensatory(su, plan, today);
      const employees = await su
        .model('hr.employee')
        .search({ where: { company: plan.company as never, active: true } as never });
      for (const e of employees) {
        const person = personOf(e);
        if (person === null || person.joined > today) continue;
        lines += await accruePerson(su, plan, person, today);
        await refreshPerson(su, plan, person, today);
      }
    }
    await su.flush();
    return lines;
  });
}

/**
 * A person's balance of a leave type on a day, as the plan sees it; `null` when the type has no plan or the person
 * no joining date.
 */
export async function projectLeave(
  env: Env,
  employee: number,
  type: number,
  date: string,
): Promise<Projection | null> {
  return env.asSuperuser({ reason: 'a leave balance projected' }, async (su) => {
    const [e] = await su
      .model('hr.employee')
      .search({ where: { id: employee as never }, limit: 1 });
    if (e === undefined) return null;
    const [loaded] = await su.model('hr.employee').browse([e.id]).load(['company']);
    const person = personOf(e);
    if (person === null || loaded === undefined) return null;
    const plan = await planOf(su, type, loaded.company.id as number);
    if (plan === null) return null;
    return projectPerson(su, plan, person, date, iso(su.today()));
  });
}

// ---- paying days out

const ENCASH_DECIDES =
  'A payout is approved or refused by an HR manager, never one’s own; a refusal says why.';

/** The requests among `ids` the acting user may not decide: all without the permission, and their own. */
async function payoutUndecidable(
  env: Env,
  ids: readonly number[],
  refusing: boolean,
): Promise<number[]> {
  if (!env.su && !env.access.has('hr_accrual.encash_decide')) return [...ids];
  const me = env.userId;
  const system = env.su;
  return env.asSuperuser({ reason: 'who decides a leave payout' }, async (su) => {
    const failing: number[] = [];
    const loaded = await su
      .model('hr.leave.encashment')
      .browse([...ids] as never)
      .load({ employee: { user: true } });
    for (const r of loaded) {
      const own = !system && r.employee.user?.id === me;
      const silent = refusing && (r.refuseReason === null || r.refuseReason.trim() === '');
      if (own || silent) failing.push(r.id as number);
    }
    return failing;
  });
}

const refusePayout = (message: string, hint: string): never => {
  throw new orm.ValidationError('hr.leave.encashment', ['state'], message, hint);
};

/**
 * Pays days out (RFC 0034 §2.5): checks the plan allows it and that the balance on the day keeps what must stay,
 * values a day by the plan's formula on the person's running contract, takes the days from the ledger and leaves
 * the amount as a Payroll input of that month — which the person's salary structure must pay. Returns the amount.
 */
export async function payOut(env: Env, id: number): Promise<string> {
  return env.asSuperuser({ reason: 'leave paid out' }, async (su) => {
    const [r] = await su
      .model('hr.leave.encashment')
      .browse([id as never])
      .load({ employee: { company: true }, plan: { type: true, company: true } });
    if (r === undefined) return refusePayout('The request is gone.', 'Make a new one.');
    const plan = planRow(r.plan);
    if (r.plan.active !== true || r.plan.encashable !== true)
      return refusePayout(
        'Days of this plan are not paid out.',
        'Switch on Days may be paid out on the accrual plan.',
      );
    const person = personOf(r.employee);
    if (person === null)
      return refusePayout('The person has no joining date.', 'Give it on the employee.');
    const date = iso(r.date);
    const wanted = cents(r.days);
    const on = await projectPerson(su, plan, person, date, iso(su.today()));
    const balance = cents(on.balance);
    const free = balance - cents(r.plan.encashKeep);
    if (wanted > free)
      return refusePayout(
        `Only ${days(Math.max(0, free))} day(s) can be paid out: the balance on ${date} is ${days(balance)}, and ${days(cents(r.plan.encashKeep))} stay.`,
        'Ask for fewer days.',
      );
    const [contract] = await su
      .model('hr.contract')
      .search({
        where: { employee: person.id as never, state: 'running' } as never,
        order: ['dateStart desc'],
        limit: 1,
      })
      .then((found) => found.load({ structure: { rules: true } }));
    if (contract === undefined || contract.wage === null)
      return refusePayout(
        'The person has no running contract with a wage.',
        'Start their contract in Workforce › Contracts.',
      );
    const input = `INPUT_${r.plan.encashCode}`;
    const pays =
      contract.structure !== null &&
      [...contract.structure.rules].some((rule) => {
        try {
          return variablesOf(parse(rule.formula)).includes(input);
        } catch {
          return false;
        }
      });
    if (!pays)
      return refusePayout(
        `The person’s salary structure has no rule that pays ${input}.`,
        `Add a rule with the formula ${input} to the structure (Payroll › Configuration), or choose the structure on the contract.`,
      );
    const value = evaluate(parse(r.plan.encashFormula), {
      variables: new Map<string, Decimal>(
        Object.entries({
          WAGE: contract.wage,
          DAYS: days(wanted),
          BALANCE: days(balance),
          SERVICE_YEARS: Math.floor(serviceMonthsAt(person.joined, date.slice(0, 7)) / 12),
        }).map(([name, v]) => [name, orm.toDecimal(v)]),
      ),
      slabs: new Map(),
    }).toDecimalPlaces(2);
    const amount = value.times(days(wanted)).toDecimalPlaces(2);
    if (amount.lte(0))
      return refusePayout('A day is worth nothing by the plan’s formula.', 'Check the formula.');
    const entry = (
      await su.model('hr.accrual.entry').create([
        {
          employee: person.id,
          plan: plan.id,
          company: plan.company,
          date,
          kind: 'encashment',
          days: days(-wanted),
          period: date.slice(0, 7),
          note: `Paid out: ${r.name}`,
        } as never,
      ])
    ).ids[0];
    const made = (
      await su.model('payroll.input').create([
        {
          employee: person.id,
          company: plan.company,
          date,
          code: r.plan.encashCode,
          amount: amount.toFixed(2),
          note: `${r.name}: ${days(wanted)} day(s) of leave paid out`,
        } as never,
      ])
    ).ids[0];
    await su
      .model('hr.leave.encashment')
      .browse([r.id])
      .write({
        dayValue: value.toFixed(2),
        amount: amount.toFixed(2),
        entry,
        input: made,
        refuseReason: null,
      } as never);
    await su.flush();
    await refreshPerson(su, plan, person, iso(su.today()));
    return amount.toFixed(2);
  });
}

/** The requests among `ids` that are no longer drafts. */
async function payoutsAsked(env: Env, ids: readonly number[]): Promise<number[]> {
  const rows = await env.asSuperuser({ reason: 'a payout asked for' }, async (su) =>
    (
      await su
        .model('hr.leave.encashment')
        .browse([...ids] as never)
        .load(['state'])
    ).read(['id', 'state']),
  );
  return rows.filter((r) => r['state'] !== 'draft').map((r) => Number(r['id']));
}

/** Days a person asks to be paid for instead of taking them: approved by HR, paid by Payroll. */
export const LeaveEncashment = defineModel('hr.leave.encashment', {
  label: 'Leave payout',
  recName: 'name',
  order: ['date desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'days', 'amount'],
  access: { 'hr.user': ALL, 'hr.manager': [...ALL, 'export'] },
  rules: {
    seeOwn: { groups: ['hr.user'], perms: ['read'], domain: { 'employee.user': me } },
    draftOwn: {
      groups: ['hr.user'],
      perms: ['write', 'create', 'unlink'],
      domain: { 'employee.user': me, state: 'draft' },
    },
    all: { groups: ['hr.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, sequence: 'hr.leave.encashment', label: 'Reference' }),
    employee: f.many2one('hr.employee', { required: true, ondelete: 'cascade' }),
    plan: f.many2one('hr.accrual.plan', {
      required: true,
      ondelete: 'restrict',
      checkCompany: true,
      label: 'Plan',
      help: 'A plan whose days may be paid out.',
    }),
    days: f.decimal({ scale: 2, required: true, label: 'Days' }),
    date: f.date({
      required: true,
      default: (env: Env) => env.today(),
      label: 'Paid in the month of',
      help: 'The days leave the balance on this day, and the amount is in this month’s payroll.',
    }),
    note: f.char({ label: 'Note' }),
    refuseReason: f.char({ label: 'Why refused' }),
    dayValue: f.decimal({
      scale: 2,
      label: 'A day is worth',
      groups: { write: [...SYSTEM] },
      help: 'By the plan’s formula on the running contract, when it was approved.',
    }),
    amount: f.decimal({ scale: 2, label: 'Amount', groups: { write: [...SYSTEM] } }),
    entry: f.many2one('hr.accrual.entry', {
      ondelete: 'set null',
      label: 'Ledger line',
      groups: { write: [...SYSTEM] },
    }),
    input: f.many2one('payroll.input', {
      ondelete: 'set null',
      label: 'Payroll input',
      groups: { write: [...SYSTEM] },
    }),
    state: f.state({
      states: { draft: 'Draft', submitted: 'Submitted', approved: 'Approved', refused: 'Refused' },
      initial: 'draft',
      help: 'Approved: the days have left the balance and the amount waits for the month’s payroll.',
      transitions: {
        submit: { from: ['draft'], to: 'submitted' },
        approve: emitting('hr.leave.encashment.approved', {
          from: ['submitted'],
          to: 'approved',
          guard: records('hr.leave.encashment', (requests) =>
            payoutUndecidable(
              requests.env as unknown as Env,
              requests.ids as readonly number[],
              false,
            ),
          ),
          message: ENCASH_DECIDES,
          after: records('hr.leave.encashment', async (requests) => {
            const env = requests.env as unknown as Env;
            for (const id of requests.ids) await payOut(env, id as number);
          }),
        }),
        refuse: {
          from: ['submitted'],
          to: 'refused',
          guard: records('hr.leave.encashment', (requests) =>
            payoutUndecidable(
              requests.env as unknown as Env,
              requests.ids as readonly number[],
              true,
            ),
          ),
          message: ENCASH_DECIDES,
        },
        redraft: { from: ['submitted', 'refused'], to: 'draft' },
      },
    }),
  },
  sqlConstraints: {
    daysPositive: { check: orm.sql`days > 0`, message: 'A payout is for more than no days.' },
  },
  constraints: {
    lockedOnceAsked: {
      ...check('hr.leave.encashment', ['employee', 'plan', 'days', 'date'], (requests) =>
        payoutsAsked(requests.env as unknown as Env, requests.ids as readonly number[]),
      ),
      message: 'A payout that was submitted does not change: take it back to draft first.',
    },
  },
});

/** Leave of a type with a plan is checked against the balance on the day it starts. */
export const LeaveByAccrual = extendModel('hr.leave', {
  overrides: {
    overBalance: async function (this: unknown, next: () => Promise<number[]>): Promise<number[]> {
      const leaves = this as Records<'hr.leave'>;
      const env = leaves.env as unknown as Env;
      const byYear = new Set(await next());
      return env.asSuperuser({ reason: 'leave against its accrual' }, async (su) => {
        const today = iso(su.today());
        const loaded = await su
          .model('hr.leave')
          .browse(leaves.ids as never)
          .load({ employee: ['company', 'hireDate'], type: true });
        for (const l of loaded) {
          const plan = await planOf(su, l.type.id as number, l.employee.company.id as number);
          if (plan === null) continue;
          // The plan decides, not the type's days per year.
          byYear.delete(l.id as number);
          if (l.state !== 'submitted' && l.state !== 'approved') continue;
          const person = personOf(l.employee);
          if (person === null) {
            byYear.add(l.id as number);
            continue;
          }
          const on = await projectPerson(su, plan, person, iso(l.dateFrom), today);
          if (Number(on.balance) < 0) byYear.add(l.id as number);
        }
        return [...byYear];
      });
    },
  },
});

const LEAVE_LINE = /^LEAVE_(\d+)$/;

/**
 * The leave left when a person leaves (RFC 0039 §6): a final settlement pays the whole balance on the last day of
 * every plan whose days may be paid out — nothing stays, there is no later —, valued by the plan's formula; once
 * the settlement is approved the days leave the ledger.
 */
export const SettlementLeave = extendModel('payroll.settlement', {
  overrides: {
    extraLines: async function (
      this: unknown,
      next: () => Promise<SettlementLineInput[]>,
    ): Promise<SettlementLineInput[]> {
      const settlements = this as Records<'payroll.settlement'>;
      const env = settlements.env as unknown as Env;
      const lines = [...(await next())];
      await env.asSuperuser({ reason: 'the leave left in a final settlement' }, async (su) => {
        const today = iso(su.today());
        for (const s of await su
          .model('payroll.settlement')
          .browse(settlements.ids as never)
          .load({ employee: ['company', 'hireDate'] })) {
          const person = personOf(s.employee);
          if (person === null) continue;
          const lastDay = iso(s.lastDay);
          const [contract] = await su.model('hr.contract').search({
            where: {
              employee: person.id as never,
              state: 'running',
              dateStart: { lte: lastDay },
            } as never,
            order: ['dateStart desc', 'id desc'],
            limit: 1,
          });
          if (contract === undefined || contract.wage === null) continue;
          const plans = await su
            .model('hr.accrual.plan')
            .search({
              where: {
                company: s.employee.company.id as never,
                active: true,
                encashable: true,
              } as never,
              order: ['id asc'],
            })
            .then((found) => found.load(['type', 'company']));
          for (const p of plans) {
            const on = await projectPerson(su, planRow(p), person, lastDay, today);
            const left = cents(on.balance);
            if (left <= 0) continue;
            let value: Decimal;
            try {
              value = evaluate(parse(p.encashFormula), {
                variables: new Map<string, Decimal>(
                  Object.entries({
                    WAGE: contract.wage,
                    DAYS: days(left),
                    BALANCE: days(left),
                    SERVICE_YEARS: Math.floor(
                      serviceMonthsAt(person.joined, lastDay.slice(0, 7)) / 12,
                    ),
                  }).map(([name, v]) => [name, orm.toDecimal(v)]),
                ),
                slabs: new Map(),
              }).toDecimalPlaces(2);
            } catch (error) {
              if (error instanceof FormulaError) continue;
              throw error;
            }
            const amount = value.times(days(left)).toDecimalPlaces(2);
            if (amount.lte(0)) continue;
            lines.push({
              code: `LEAVE_${p.id}`,
              name: `Leave not taken: ${p.name}`,
              category: 'allowance',
              amount: amount.toFixed(2),
              explanation: `${days(left)} day(s) left on ${lastDay} × ${value.toFixed(2)} a day (${p.encashFormula}) = ${amount.toFixed(2)}`,
              quantity: days(left),
            });
          }
        }
      });
      return lines;
    },
    settledOut: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const settlements = this as Records<'payroll.settlement'>;
      const env = settlements.env as unknown as Env;
      await env.asSuperuser({ reason: 'leave paid out by a final settlement' }, async (su) => {
        const today = iso(su.today());
        for (const s of await su
          .model('payroll.settlement')
          .browse(settlements.ids as never)
          .load({ employee: ['company', 'hireDate'], lines: true })) {
          const person = personOf(s.employee);
          for (const line of s.lines) {
            const plan = Number(LEAVE_LINE.exec(line.code)?.[1]);
            const paid = cents(line.quantity);
            if (!Number.isInteger(plan) || paid <= 0) continue;
            const [p] = await su
              .model('hr.accrual.plan')
              .search({ where: { id: plan as never } as never, limit: 1 })
              .then((found) => found.load(['type', 'company']));
            if (p === undefined) continue;
            await su.model('hr.accrual.entry').create([
              {
                employee: s.employee.id,
                plan,
                company: p.company.id,
                date: iso(s.lastDay),
                kind: 'encashment',
                days: days(-paid),
                period: iso(s.lastDay).slice(0, 7),
                note: `Paid out: final settlement ${s.name}`,
              } as never,
            ]);
            await su.flush();
            if (person !== null) await refreshPerson(su, planRow(p), person, today);
          }
        }
      });
    },
  },
});

export const hrAccrualShutro = defineModule({
  name: 'hr_accrual',
  version: '0.1.0',
  depends: [hrShutro, attendanceShutro, payrollShutro],
  groups: [
    orm.defineGroup({
      code: 'hr_accrual.user',
      label: 'Leave balances',
      implies: ['hr.user'],
    }),
  ],
  permissions: [
    orm.definePermission({
      code: 'hr_accrual.encash_decide',
      label: 'Approve and refuse leave payouts',
      groups: ['hr.manager'],
    }),
  ],
  sequences: [
    orm.defineSequence({
      code: 'hr.leave.encashment',
      prefix: 'ENC/{year}/',
      padding: 4,
      reset: 'yearly',
    }),
  ],
  models: [AccrualPlan, AccrualEntry, AccrualBalance, LeaveEncashment],
  extensions: [LeaveByAccrual, SettlementLeave],
});
