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
import { evaluate, FormulaError, parse, payrollShutro, variablesOf } from '@kosh/payroll';
import { type Decimal, orm } from '@kosh/server/orm';
import {
  check,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  type Records,
} from './.kosh/bindings.js';
import {
  type AccrualRules,
  type AccrualState,
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

/** The first problem of a formula, or `null`: it parses, and reads only what a plan knows. */
export function formulaProblem(text: string): string | null {
  try {
    const unknown = variablesOf(parse(text)).filter((v) => !(v in ACCRUAL_VARIABLES));
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
  tracking: ['formula', 'cap', 'carryOver', 'carryExpiryMonth', 'probationMonths'],
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
  },
  sqlConstraints: {
    sane: {
      check: orm.sql`probation_months >= 0 AND (cap IS NULL OR cap >= 0) AND (carry_over IS NULL OR carry_over >= 0)
        AND (carry_expiry_month IS NULL OR carry_expiry_month BETWEEN 1 AND 12)`,
      message:
        'Probation, the cap and the carry-over are not negative, and the expiry month is 1 to 12.',
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
  },
  sqlConstraints: {
    notZero: {
      check: orm.sql`days <> 0`,
      message: 'A ledger line moves at least a hundredth of a day.',
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
}): PlanRow => ({
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
  const rows = await su.model('hr.leave').search({
    where: {
      employee: employee as never,
      type: type as never,
      state: { in: states },
      dateFrom: { gte: from, lte: to },
    } as never,
  });
  return [...rows].reduce((sum, l) => sum + Math.round(Number(l.days ?? 0) * 100), 0);
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
  models: [AccrualPlan, AccrualEntry, AccrualBalance],
  extensions: [LeaveByAccrual],
});
