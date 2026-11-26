/**
 * The payroll engine (RFC 0024 §2.3): a run's payslips computed from each person's running contract and its
 * structure. Every rule sees these variables, then the codes of the rules before it:
 *
 * - `WAGE` (the contract's monthly wage), `PERIOD_DAYS`, `CONTRACT_DAYS` (the contract's days in the period: joiners
 *   and leavers paid in proportion), `SERVICE_MONTHS` (since joining), `MONTH`, `FY_MONTH` and `MONTHS_LEFT` (in the
 *   fiscal year that starts in the month of App settings › Payroll, July by default);
 * - `PAID_BY_DAY` and `PAID_BY_HOUR` (1 or 0: how the contract's wage is counted — else by the month) and
 *   `TYPE_<CODE>` (1 for the contract's employment type: `TYPE_PERM`, `TYPE_CONT`, `TYPE_TEMP`, `TYPE_CASU`…;
 *   any other type reads as 0);
 * - half a day of leave counts in halves — 0.5 in `PRESENT_DAYS` (or `ABSENT_DAYS`) and 0.5 in the leave
 *   figures — and `HALF_DAYS` says how many such days;
 * - leave told apart: `PAID_LEAVE_DAYS`, `UNPAID_LEAVE_DAYS` (the leave type says which) and `LEAVE_<CODE>` (the
 *   approved days of one type: `LEAVE_CL`, `LEAVE_SL`, `LEAVE_EL`, `LEAVE_LWP`; a type not taken reads as 0);
 * - from the shifts, approved days only: `WORKED_HOURS`, `EXPECTED_HOURS`, `LATE_MINUTES`, `EARLY_MINUTES`,
 *   `NIGHT_SHIFTS` (days worked on a shift that ends the next day), `OFF_DAYS_WORKED` (days worked on a weekend
 *   or a holiday);
 * - from Attendance's **approved** days: `PRESENT_DAYS` (days on tour and at home included), `TOUR_DAYS`, `REMOTE_DAYS` (home office), `ABSENT_DAYS`, `LEAVE_DAYS`, `HOLIDAYS`, `LATE_DAYS`,
 *   `OVERTIME_HOURS` (approved), `OVERTIME_RATE` — a payslip warns when days of the period wait for approval;
 * - `GROSS` and `DEDUCTIONS` (the totals of the rules before), `E_<CODE>` (the person's own values: a provident fund membership, a declared investment), `FESTIVAL` (the run
 *   pays a festival bonus), `INPUT_<CODE>` (the month's one-off inputs), `LOAN` (instalments of running loans, never more than remains),
 *   `YTD_<CODE>` (paid this fiscal year before the period), `P_<CODE>` (parameters in force), and `slab('CODE', x)`.
 *
 * Each line keeps the formula with its values. A formula that fails stops the run, naming the person and the rule.
 */
import { installationSetting } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { evaluate, explain, FormulaError, parse, type Scope, type Slab } from './formula.js';

const ZERO: Decimal = orm.toDecimal(0);
const DAY = 86_400_000;

/** A date-only value as `YYYY-MM-DD` (PostgreSQL dates read as local midnights). */
export function isoDate(v: unknown): string {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}
const days = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
const later = (a: string, b: string) => (a > b ? a : b);
const earlier = (a: string, b: string) => (a < b ? a : b);
const inForce = (row: { dateFrom: unknown; dateTo: unknown }, on: string) =>
  (row.dateFrom == null || isoDate(row.dateFrom) <= on) &&
  (row.dateTo == null || isoDate(row.dateTo) >= on);

/** The month the fiscal year starts in (1–12), from App settings › Payroll. */
export async function fiscalStartOf(env: Env): Promise<number> {
  const m = Number(await installationSetting(env, 'payroll.fiscalStart', '7'));
  return Number.isInteger(m) && m >= 1 && m <= 12 ? m : 7;
}

/** The fiscal year's first day for a date. */
export function fiscalYearStart(date: string, startMonth: number): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const year = m >= startMonth ? y : y - 1;
  return `${year}-${String(startMonth).padStart(2, '0')}-01`;
}

/** The job that computes a large run, a batch per job: each batch commits, the next one is enqueued. */
export const COMPUTE_JOB = 'payroll.compute';

/** A run's figures — how many payslips, their gross and net — as sums the database makes. */
export async function refreshTotals(env: Env, id: number): Promise<void> {
  await env.flush();
  const [sums] = await env.sql<{ n: string | number; gross: string; net: string }>`
    SELECT count(*) AS n, coalesce(sum(gross), 0)::text AS gross, coalesce(sum(net), 0)::text AS net
      FROM payroll_slip WHERE run_id = ${id}`;
  await env
    .model('payroll.run')
    .browse([id] as never)
    .write({
      slipCount: Number(sums?.n ?? 0),
      gross: sums?.gross ?? '0',
      net: sums?.net ?? '0',
    } as never);
  await env.flush();
}

/**
 * One step of a large run's computation, as the job does it: the next batch, the run's figures, and whether
 * there is more. A formula that fails is written on the run with the person and the rule — the batches done
 * stay — and stops the computation until *Compute* is pressed again.
 */
export async function computeStep(
  env: Env,
  id: number,
  round?: number,
): Promise<'more' | 'done' | 'stopped'> {
  const [run] = await (
    await env.model('payroll.run').search({ where: { id: id as never }, limit: 1 })
  ).load(['state', 'computeError', 'computeRound']);
  // Redrafted, cancelled, deleted or computed again since: nothing more to do.
  if (run === undefined || run.state !== 'computed') return 'stopped';
  if (round !== undefined && (run.computeRound ?? 0) !== round) return 'stopped';
  if ((run.computeError ?? '') !== '') return 'stopped';
  let left: number;
  try {
    // (`KOSH_PAYROLL_BATCH`: a smaller batch, for tests and for servers with little memory.)
    const size = Number(process.env['KOSH_PAYROLL_BATCH']) || BATCH;
    // No savepoint is needed to undo a failed batch: its formulas are all evaluated before its first payslip
    // is written, so a formula that fails has written nothing.
    left = await computeBatch(env, id, size);
  } catch (error) {
    // Only what a person can fix stops the run with its reason; anything else is the job's to retry.
    if (!(error instanceof orm.ValidationError)) throw error;
    await env
      .model('payroll.run')
      .browse([id] as never)
      .write({ computeError: error.message.slice(0, 2000) } as never);
    await refreshTotals(env, id);
    return 'stopped';
  }
  await refreshTotals(env, id);
  return left > 0 ? 'more' : 'done';
}

/** How many people a batch computes: one transaction's worth when a run is computed in the background. */
export const BATCH = 500;
/** A run of up to this many people is computed at once, in the request; a larger one by the job, in batches. */
export const INLINE_LIMIT = 200;

/** The people a run pays from `after` on (by id): those of the corrected run, else everybody with a running contract on a structure in the period. */
async function peopleOf(
  env: Env,
  run: {
    id: number;
    company: { id: number };
    correctionOf: { id: number } | null;
    dateFrom: unknown;
    dateTo: unknown;
  },
  after: number,
  limit: number | null,
): Promise<number[]> {
  const from = isoDate(run.dateFrom);
  const to = isoDate(run.dateTo);
  const corrected = run.correctionOf?.id ?? null;
  const rows = await env.sql<{ employee_id: string | number }>`
    SELECT DISTINCT c.employee_id
      FROM hr_contract c
     WHERE c.company_id = ${run.company.id} AND c.state = 'running' AND c.structure_id IS NOT NULL
       AND c.date_start <= ${to}::date AND (c.date_end IS NULL OR c.date_end >= ${from}::date)
       AND c.employee_id > ${after}
       AND (${corrected}::bigint IS NULL
            OR c.employee_id IN (SELECT s.employee_id FROM payroll_slip s WHERE s.run_id = ${corrected}::bigint))
     ORDER BY c.employee_id
     LIMIT ${limit ?? 2_000_000_000}`;
  return rows.map((r) => Number(r.employee_id));
}

/**
 * Starts a run's computation: the payslips it had are removed, and the run knows how many people it pays
 * (`toCompute`) and that none is computed yet. Returns that number.
 */
export async function startRun(env: Env, id: number): Promise<number> {
  const [run] = await env
    .model('payroll.run')
    .browse([id] as never)
    .load({ company: true, correctionOf: true });
  if (run === undefined) return 0;
  // The slips the run had are replaced (their lines go with them, by the database).
  await env.flush();
  await env.sql`DELETE FROM payroll_slip WHERE run_id = ${id}`;
  const total = (await peopleOf(env, run as never, 0, null)).length;
  await env
    .model('payroll.run')
    .browse([id] as never)
    .write({
      toCompute: total,
      computedCount: 0,
      computeCursor: 0,
      computeError: null,
      computeRound: ((run as unknown as { computeRound: number | null }).computeRound ?? 0) + 1,
    } as never);
  await env.flush();
  return total;
}

/** Computes the payslips of runs at once (replacing those they had); the run must be a draft or computed. */
export async function computeRuns(env: Env, ids: readonly number[]): Promise<void> {
  for (const id of ids) {
    await startRun(env, id);
    while ((await computeBatch(env, id)) > 0);
  }
}

/**
 * Computes the payslips of the next people of a run (`limit` of them, after the run's cursor) and moves the
 * cursor on. Everything the batch reads is read in sets — a query per kind of thing, not per person. Returns how
 * many people are left.
 */
export async function computeBatch(env: Env, id: number, limit: number = BATCH): Promise<number> {
  const startMonth = await fiscalStartOf(env);
  for (const run of await env
    .model('payroll.run')
    .browse([id] as never)
    .load({ company: true, correctionOf: true })) {
    const from = isoDate(run.dateFrom);
    const to = isoDate(run.dateTo);
    const cursor = (run as unknown as { computeCursor: number | null }).computeCursor ?? 0;
    const people = await peopleOf(env, run as never, cursor, limit);
    if (people.length === 0) return 0;
    const inBatch = { in: people } as never;

    const contracts = [
      ...(await (
        await env.model('hr.contract').search({
          where: {
            company: run.company.id,
            employee: inBatch,
            state: 'running',
            structure: { isNull: false },
            dateStart: { lte: to },
            or: [{ dateEnd: { isNull: true } }, { dateEnd: { gte: from } }],
          },
        })
      ).load({ employee: true, structure: true, employmentType: true })),
    ];
    const previous = new Map<number, Decimal>();
    if (run.correctionOf !== null)
      for (const s of await (
        await env
          .model('payroll.slip')
          .search({ where: { run: run.correctionOf.id, employee: inBatch } })
      ).load({ employee: true }))
        previous.set(s.employee.id, s.net);

    // The batch's own data, each kind read once and grouped by person.
    const grouped = <T extends { employee: { id: number } }>(rows: Iterable<T>) => {
      const by = new Map<number, T[]>();
      for (const row of rows) by.set(row.employee.id, [...(by.get(row.employee.id) ?? []), row]);
      return by;
    };
    const valuesOf = grouped(
      await (
        await env.model('payroll.employee.value').search({ where: { employee: inBatch } })
      ).load({ employee: true }),
    );
    // Attendance summed by the database: one row a person, not a month of days each turned into a record.
    const attendanceOf = new Map(
      (
        await env.sql<{
          employee_id: string | number;
          days: number;
          approved: number;
          present: string;
          half_days: number;
          tour: number;
          remote: number;
          absent: string;
          on_leave: string;
          holiday: number;
          late: number;
          overtime: string;
          rate: string | null;
          worked_hours: string;
          expected_hours: string;
          late_minutes: number;
          early_minutes: number;
          night_shifts: number;
          off_days_worked: number;
        }>`
        SELECT d.employee_id,
               count(*)::int AS days,
               count(*) FILTER (WHERE d.state = 'approved')::int AS approved,
               -- Half a day of leave is half a day present (or absent) and half a day on leave (RFC 0039 §4).
               coalesce(sum(1 - d.leave_fraction)
                 FILTER (WHERE d.state = 'approved' AND d.status = 'present'), 0)::text AS present,
               count(*) FILTER (WHERE d.state = 'approved' AND d.status <> 'leave'
                                  AND d.leave_fraction = 0.5)::int AS half_days,
               count(*) FILTER (WHERE d.state = 'approved' AND d.status = 'tour')::int AS tour,
               count(*) FILTER (WHERE d.state = 'approved' AND d.status = 'remote')::int AS remote,
               coalesce(sum(1 - d.leave_fraction)
                 FILTER (WHERE d.state = 'approved' AND d.status = 'absent'), 0)::text AS absent,
               coalesce(sum(CASE WHEN d.status = 'leave' THEN 1 ELSE d.leave_fraction END)
                 FILTER (WHERE d.state = 'approved'), 0)::text AS on_leave,
               count(*) FILTER (WHERE d.state = 'approved' AND d.status = 'holiday')::int AS holiday,
               count(*) FILTER (WHERE d.state = 'approved' AND d.late_minutes > 0)::int AS late,
               coalesce(sum(d.overtime_approved) FILTER (WHERE d.state = 'approved'), 0)::text AS overtime,
               (array_agg(d.overtime_rate ORDER BY d.date DESC, d.id DESC)
                  FILTER (WHERE d.state = 'approved' AND d.overtime_approved > 0))[1]::text AS rate,
               coalesce(sum(d.worked_hours) FILTER (WHERE d.state = 'approved'), 0)::text AS worked_hours,
               coalesce(sum(d.expected_hours) FILTER (WHERE d.state = 'approved'), 0)::text AS expected_hours,
               coalesce(sum(d.late_minutes) FILTER (WHERE d.state = 'approved'), 0)::int AS late_minutes,
               coalesce(sum(d.early_minutes) FILTER (WHERE d.state = 'approved'), 0)::int AS early_minutes,
               -- A night shift ends on the next day: its end is not after its start.
               count(*) FILTER (WHERE d.state = 'approved' AND d.worked_hours > 0
                                  AND s.id IS NOT NULL AND s."end" <= s."start")::int AS night_shifts,
               -- Worked on a day nothing was expected of them: a weekend or a holiday.
               count(*) FILTER (WHERE d.state = 'approved' AND d.worked_hours > 0
                                  AND d.expected_hours = 0)::int AS off_days_worked
          FROM attendance_day d
          LEFT JOIN attendance_shift s ON s.id = d.shift_id
         WHERE d.employee_id = ANY(${people}::bigint[]) AND d.date BETWEEN ${from}::date AND ${to}::date
         GROUP BY d.employee_id`
      ).map((row) => [Number(row.employee_id), row]),
    );
    // Leave by its type (RFC 0039 §4): an approved day on leave belongs to the approved request that covers it,
    // whose type says whether it is paid and carries the code the rules read (`LEAVE_CL`…).
    const leaveOf = new Map<
      number,
      { paid: number; unpaid: number; byCode: Map<string, number> }
    >();
    for (const row of await env.sql<{
      employee_id: string | number;
      code: string | null;
      paid: boolean | null;
      n: string;
    }>`
      SELECT d.employee_id, t.code, t.paid,
             sum(CASE WHEN d.status = 'leave' THEN 1 ELSE d.leave_fraction END)::text AS n
        FROM attendance_day d
        JOIN LATERAL (
               SELECT l.type_id FROM hr_leave l
                WHERE l.employee_id = d.employee_id AND l.state = 'approved'
                  AND l.date_from <= d.date AND l.date_to >= d.date
                ORDER BY l.id LIMIT 1
             ) taken ON true
        JOIN hr_leave_type t ON t.id = taken.type_id
       WHERE d.employee_id = ANY(${people}::bigint[]) AND d.date BETWEEN ${from}::date AND ${to}::date
         AND d.state = 'approved' AND (d.status = 'leave' OR d.leave_fraction > 0)
       GROUP BY d.employee_id, t.code, t.paid`) {
      const who = Number(row.employee_id);
      const mine = leaveOf.get(who) ?? { paid: 0, unpaid: 0, byCode: new Map<string, number>() };
      // Whole days and halves: exact in a JS number.
      const n = Number(row.n);
      if (row.paid === false) mine.unpaid += n;
      else mine.paid += n;
      const code = (row.code ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      if (code !== '') mine.byCode.set(code, (mine.byCode.get(code) ?? 0) + n);
      leaveOf.set(who, mine);
    }
    const inputsOf = grouped(
      await (
        await env
          .model('payroll.input')
          .search({ where: { employee: inBatch, date: { gte: from, lte: to } } })
      ).load({ employee: true }),
    );
    const loansOf = grouped(
      await (
        await env
          .model('payroll.loan')
          .search({ where: { employee: inBatch, state: 'running', dateStart: { lte: to } } })
      ).load({ employee: true }),
    );
    const rulesOf = new Map<number, RuleRow[]>();
    const slipsToMake: Record<string, unknown>[] = [];

    // What is in force at the period's end: parameters and slab tables.
    const parameters = new Map<string, Decimal>();
    for (const p of [
      ...(await (
        await env.model('payroll.parameter').search({ where: {} })
      ).load(['code', 'value', 'dateFrom', 'dateTo'])),
    ]
      .filter((p) => inForce(p, to))
      .sort((a, b) => isoDate(a.dateFrom ?? '').localeCompare(isoDate(b.dateFrom ?? ''))))
      parameters.set(`P_${p.code}`, p.value);
    const slabs = new Map<string, Slab>();
    for (const t of [
      ...(await (await env.model('payroll.slab').search({ where: {} })).load({ bands: true })),
    ]
      .filter((t) => inForce(t, to))
      .sort((a, b) => isoDate(a.dateFrom ?? '').localeCompare(isoDate(b.dateFrom ?? ''))))
      slabs.set(t.code, {
        bands: [...t.bands]
          .sort((a, b) => a.sequence - b.sequence)
          .map((b) => ({ upTo: b.upTo, rate: b.rate })),
      });

    const fyStart = fiscalYearStart(to, startMonth);
    const month = Number(to.slice(5, 7));
    const fyMonth = ((month - startMonth + 12) % 12) + 1;
    const paidBefore = await yearToDate(env, people, fyStart, from);
    // One payslip a person: by the most recent of their running contracts, the others named in a warning.
    const byPerson = new Map<number, (typeof contracts)[number][]>();
    for (const c of contracts)
      byPerson.set(c.employee.id, [...(byPerson.get(c.employee.id) ?? []), c]);
    for (const held of byPerson.values()) {
      const sorted = [...held].sort(
        (a, b) => isoDate(b.dateStart).localeCompare(isoDate(a.dateStart)) || b.id - a.id,
      );
      const contract = sorted[0] as (typeof contracts)[number];
      const e = contract.employee;
      const structure = contract.structure;
      if (structure === null) continue;
      const variables = new Map<string, Decimal>(parameters);
      const warnings: string[] =
        sorted.length > 1
          ? [
              `${sorted.length} running contracts in the period: paid by ${contract.name}; end the others.`,
            ]
          : [];
      const set = (k: string, v: Decimal | number) =>
        variables.set(k, typeof v === 'number' ? orm.toDecimal(v) : v);
      set('WAGE', contract.wage ?? ZERO);
      // How the wage is counted, and the kind of employment (RFC 0039 §4): a casual or temporary person paid
      // by the day or the hour, and rules that hold for one employment type only (`TYPE_CASU`, `TYPE_TEMP`…).
      set('PAID_BY_DAY', contract.payBasis === 'day' ? 1 : 0);
      set('PAID_BY_HOUR', contract.payBasis === 'hour' ? 1 : 0);
      const typeCode = (contract.employmentType?.code ?? '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_');
      if (typeCode !== '') set(`TYPE_${typeCode}`, 1);
      set('PERIOD_DAYS', days(from, to));
      const cFrom = later(from, isoDate(contract.dateStart));
      const cTo = contract.dateEnd === null ? to : earlier(to, isoDate(contract.dateEnd));
      set('CONTRACT_DAYS', cTo < cFrom ? 0 : days(cFrom, cTo));
      const joined = isoDate(e.hireDate ?? contract.dateStart);
      const [jy, jm] = joined.split('-').map(Number) as [number, number];
      const [ty, tm] = to.split('-').map(Number) as [number, number];
      set('SERVICE_MONTHS', Math.max(0, (ty - jy) * 12 + (tm - jm)));
      set('MONTH', month);
      set('FY_MONTH', fyMonth);
      set('MONTHS_LEFT', 12 - fyMonth + 1);
      set('FESTIVAL', run.festival ? 1 : 0);
      // The person's own values in force at the period's end (the latest start wins).
      for (const v of [...(valuesOf.get(e.id) ?? [])]
        .filter((v) => inForce(v, to))
        .sort((a, b) => isoDate(a.dateFrom ?? '').localeCompare(isoDate(b.dateFrom ?? ''))))
        set(`E_${v.code}`, v.value);

      // Attendance: approved days only.
      const seen = attendanceOf.get(e.id);
      // A day on an approved official tour is a day worked (RFC 0037 §3.2); `TOUR_DAYS` says how many.
      // So is a day of approved home office (RFC 0039 §3); `REMOTE_DAYS` says how many.
      // Half a day of leave makes halves: 0.5 present (or absent) and 0.5 on leave; `HALF_DAYS` counts them.
      const onLeave = Number(seen?.on_leave ?? 0);
      set(
        'PRESENT_DAYS',
        orm.toDecimal(seen?.present ?? '0').plus((seen?.tour ?? 0) + (seen?.remote ?? 0)),
      );
      set('TOUR_DAYS', seen?.tour ?? 0);
      set('REMOTE_DAYS', seen?.remote ?? 0);
      set('ABSENT_DAYS', orm.toDecimal(seen?.absent ?? '0'));
      set('LEAVE_DAYS', orm.toDecimal(seen?.on_leave ?? '0'));
      set('HALF_DAYS', seen?.half_days ?? 0);
      // Paid and unpaid apart, and by type. A day on leave no approved request covers (typed in by hand) is
      // taken as paid: only a leave type that says *not paid* makes a day unpaid.
      const taken = leaveOf.get(e.id);
      set('UNPAID_LEAVE_DAYS', orm.toDecimal(String(taken?.unpaid ?? 0)));
      set('PAID_LEAVE_DAYS', orm.toDecimal(String(onLeave - (taken?.unpaid ?? 0))));
      for (const [code, n] of taken?.byCode ?? []) set(`LEAVE_${code}`, orm.toDecimal(String(n)));
      set('HOLIDAYS', seen?.holiday ?? 0);
      set('LATE_DAYS', seen?.late ?? 0);
      set('OVERTIME_HOURS', orm.toDecimal(seen?.overtime ?? '0'));
      // The rate of the latest approved day with overtime; double time when there is none.
      set('OVERTIME_RATE', orm.toDecimal(seen?.rate ?? '2'));
      // What shift-based pay reads (RFC 0039 §4): the hours, the minutes late and left early, night shifts
      // worked, and days worked on a weekend or a holiday.
      set('WORKED_HOURS', orm.toDecimal(seen?.worked_hours ?? '0'));
      set('EXPECTED_HOURS', orm.toDecimal(seen?.expected_hours ?? '0'));
      set('LATE_MINUTES', seen?.late_minutes ?? 0);
      set('EARLY_MINUTES', seen?.early_minutes ?? 0);
      set('NIGHT_SHIFTS', seen?.night_shifts ?? 0);
      set('OFF_DAYS_WORKED', seen?.off_days_worked ?? 0);
      const waiting = (seen?.days ?? 0) - (seen?.approved ?? 0);
      if (waiting > 0)
        warnings.push(
          `${waiting} attendance day(s) of the period are not approved and are left out.`,
        );

      // Inputs of the period, running loans, and what was paid this fiscal year.
      for (const i of inputsOf.get(e.id) ?? [])
        set(`INPUT_${i.code}`, (variables.get(`INPUT_${i.code}`) ?? ZERO).plus(i.amount));
      let loan = ZERO;
      for (const l of loansOf.get(e.id) ?? [])
        loan = loan.plus(
          l.installment.lt(l.remaining ?? ZERO) ? l.installment : (l.remaining ?? ZERO),
        );
      set('LOAN', loan);
      for (const [code, amount] of paidBefore.get(e.id) ?? []) set(`YTD_${code}`, amount);

      // The rules, in order: read once per structure.
      let rules = rulesOf.get(structure.id);
      if (rules === undefined) {
        rules = (
          [
            ...(await (
              await env.model('payroll.rule').search({ where: { structure: structure.id } })
            ).load([
              'sequence',
              'code',
              'name',
              'category',
              'formula',
              'condition',
              'appearsOnSlip',
              'dateFrom',
              'dateTo',
            ])),
          ] as unknown as RuleRow[]
        )
          .filter((r) => inForce(r, to))
          .sort((a, b) => a.sequence - b.sequence || a.id - b.id);
        rulesOf.set(structure.id, rules);
      }
      const structureRules = rules;
      const scope: Scope = {
        variables,
        slabs,
        zero: (name) =>
          name.startsWith('INPUT_') ||
          name.startsWith('YTD_') ||
          name.startsWith('E_') ||
          // An employment type the person does not have; a leave type they took no day of.
          name.startsWith('TYPE_') ||
          name.startsWith('LEAVE_') ||
          structureRules.some((r) => r.code === name),
      };
      const lines: Record<string, unknown>[] = [];
      const totals = { gross: ZERO, deductions: ZERO, contributions: ZERO };
      set('GROSS', ZERO);
      set('DEDUCTIONS', ZERO);
      for (const rule of rules) {
        let amount: Decimal;
        let why: string;
        try {
          if (
            rule.condition !== null &&
            rule.condition.trim() !== '' &&
            evaluate(parse(rule.condition), scope).isZero()
          ) {
            set(rule.code, ZERO);
            continue;
          }
          why = explain(rule.formula, scope);
          amount = evaluate(parse(rule.formula), scope).toDecimalPlaces(2);
        } catch (error) {
          if (error instanceof FormulaError)
            throw new orm.ValidationError(
              'payroll.run',
              ['slips'],
              `${e.name}, rule ${rule.code}: ${error.message}`,
              'Fix the rule in Payroll › Configuration › Structures, then compute again.',
            );
          throw error;
        }
        set(rule.code, amount);
        if (rule.category === 'basic' || rule.category === 'allowance')
          totals.gross = totals.gross.plus(amount);
        else if (rule.category === 'deduction') totals.deductions = totals.deductions.plus(amount);
        else if (rule.category === 'contribution')
          totals.contributions = totals.contributions.plus(amount);
        // The totals so far, for the rules after this one (income tax reads the gross).
        set('GROSS', totals.gross);
        set('DEDUCTIONS', totals.deductions);
        lines.push({
          rule: rule.id,
          sequence: rule.sequence,
          code: rule.code,
          name: rule.name,
          category: rule.category,
          amount: amount.toString(),
          explanation: `${why} = ${amount.toString()}`.slice(0, 1000),
          appearsOnSlip: rule.appearsOnSlip,
        });
      }
      const net = totals.gross.minus(totals.deductions);
      slipsToMake.push({
        name: `${run.name} ${e.name}`,
        run: run.id,
        company: run.company.id,
        employee: e.id,
        contract: contract.id,
        structure: structure.id,
        dateFrom: from,
        dateTo: to,
        gross: totals.gross.toString(),
        deductions: totals.deductions.toString(),
        contributions: totals.contributions.toString(),
        net: net.toString(),
        previousNet: previous.has(e.id) ? (previous.get(e.id) as Decimal).toString() : null,
        warnings: warnings.length === 0 ? null : warnings.join('\n'),
        lines: { create: lines },
      });
    }
    // The batch's payslips in one go, the cursor past its last person, and how far the run is.
    if (slipsToMake.length > 0) await env.model('payroll.slip').create(slipsToMake as never);
    const computed = (run as unknown as { computedCount: number | null }).computedCount ?? 0;
    await env
      .model('payroll.run')
      .browse([id] as never)
      .write({
        computeCursor: people[people.length - 1],
        computedCount: computed + people.length,
      } as never);
    await env.flush();
    return (await peopleOf(env, run as never, people[people.length - 1] as number, 1)).length;
  }
  return 0;
}

/** A structure's rule, as the engine reads it. */
interface RuleRow {
  readonly id: number;
  readonly sequence: number;
  readonly code: string;
  readonly name: string;
  readonly category: string;
  readonly formula: string;
  readonly condition: string | null;
  readonly appearsOnSlip: boolean;
  readonly dateFrom: unknown;
  readonly dateTo: unknown;
}

/**
 * What each of these people was paid this fiscal year before `before`, by rule code: per period, the latest
 * approved or paid payslip (a correction replaces the payslip it corrects). One query for all of them.
 */
async function yearToDate(
  env: Env,
  employees: readonly number[],
  fyStart: string,
  before: string,
): Promise<Map<number, Map<string, Decimal>>> {
  const slips = [
    ...(await (
      await env.model('payroll.slip').search({
        where: {
          employee: { in: employees } as never,
          dateFrom: { gte: fyStart, lt: before },
          'run.state': { in: ['approved', 'paid'] },
        },
      })
    ).load({ lines: true, employee: true })),
  ];
  const latest = new Map<string, (typeof slips)[number]>();
  for (const s of slips) {
    const key = `${s.employee.id}:${isoDate(s.dateFrom)}`;
    const kept = latest.get(key);
    if (kept === undefined || s.id > kept.id) latest.set(key, s);
  }
  const out = new Map<number, Map<string, Decimal>>();
  for (const s of latest.values()) {
    const mine = out.get(s.employee.id) ?? new Map<string, Decimal>();
    for (const l of s.lines) mine.set(l.code, (mine.get(l.code) ?? ZERO).plus(l.amount));
    out.set(s.employee.id, mine);
  }
  return out;
}

/** On approval: each running loan's instalment taken by its payslip; repaid loans finished. */
export async function recordRepayments(env: Env, runIds: readonly number[]): Promise<void> {
  for (const run of await env
    .model('payroll.run')
    .browse(runIds as never)
    .load(['kind', 'dateTo'])) {
    if (run.kind === 'correction') continue;
    // Only the payslips that took a loan instalment, found by the database: a run of thirty thousand people
    // is not read payslip by payslip for the few who repay a loan (RFC 0039 §2).
    await env.flush();
    const repaying = await env.sql<{
      slip_id: string | number;
      employee_id: string | number;
      taken: string;
    }>`
      SELECT s.id AS slip_id, s.employee_id, sum(l.amount)::text AS taken
        FROM payroll_slip s
        JOIN payroll_slip_line l ON l.slip_id = s.id AND l.code = 'LOAN'
       WHERE s.run_id = ${run.id}
       GROUP BY s.id, s.employee_id
      HAVING sum(l.amount) > 0
       ORDER BY s.id`;
    for (const row of repaying) {
      const slip = { id: Number(row.slip_id), employee: { id: Number(row.employee_id) } };
      let left = orm.toDecimal(row.taken);
      for (const loan of await (
        await env.model('payroll.loan').search({
          where: {
            employee: slip.employee.id as never,
            state: 'running',
            dateStart: { lte: isoDate(run.dateTo) },
          },
          order: ['dateStart asc', 'id asc'],
        })
      ).load(['installment', 'remaining'])) {
        if (left.lte(0)) break;
        const due = loan.installment.lt(loan.remaining ?? ZERO)
          ? loan.installment
          : (loan.remaining ?? ZERO);
        const part = left.lt(due) ? left : due;
        if (part.lte(0)) continue;
        await env.model('payroll.loan.repayment').create([
          {
            loan: loan.id,
            slip: slip.id,
            date: isoDate(run.dateTo),
            amount: part.toString(),
          } as never,
        ]);
        left = left.minus(part);
      }
    }
  }
  await env.flush();
  const done = await env
    .model('payroll.loan')
    .search({ where: { state: 'running', remaining: { lte: '0' } } });
  if (done.length > 0) await done.finish();
}

// ---- payment files.

export interface PaymentRow {
  readonly employee: string;
  readonly method: string;
  readonly bank: string | null;
  readonly branch: string | null;
  readonly account: string | null;
  readonly routing: string | null;
  readonly wallet: string | null;
  readonly walletNumber: string | null;
  readonly amount: Decimal;
  readonly reference: string;
}

/** A payment file format (RFC 0024 §3: an adapter; a generic bank file and the wallets' bulk files ship). */
export interface PaymentFormat {
  readonly key: string;
  readonly label: string;
  /** The rows the file takes. */
  readonly takes: (row: PaymentRow) => boolean;
  readonly render: (rows: readonly PaymentRow[]) => string;
}

const csv = (cells: readonly (string | null)[]) =>
  cells
    .map((c) => (c === null ? '' : /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c))
    .join(',');
const wallet = (provider: string, label: string): PaymentFormat => ({
  key: provider,
  label,
  takes: (r) => r.method === 'wallet' && r.wallet === provider,
  render: (rows) =>
    [
      csv(['Wallet Number', 'Amount', 'Reference', 'Name']),
      ...rows.map((r) => csv([r.walletNumber, r.amount.toFixed(2), r.reference, r.employee])),
    ].join('\r\n'),
});

export const PAYMENT_FORMATS: readonly PaymentFormat[] = [
  {
    key: 'bank',
    label: 'Bank transfer (generic CSV)',
    takes: (r) => r.method === 'bank',
    render: (rows) =>
      [
        csv(['Name', 'Bank', 'Branch', 'Account Number', 'Routing Number', 'Amount', 'Reference']),
        ...rows.map((r) =>
          csv([
            r.employee,
            r.bank,
            r.branch,
            r.account,
            r.routing,
            r.amount.toFixed(2),
            r.reference,
          ]),
        ),
      ].join('\r\n'),
  },
  wallet('bkash', 'bKash disbursement (CSV)'),
  wallet('nagad', 'Nagad disbursement (CSV)'),
  wallet('rocket', 'Rocket disbursement (CSV)'),
  {
    key: 'cash',
    label: 'Cash sheet (CSV, with a column to sign)',
    takes: (r) => r.method === 'cash',
    render: (rows) =>
      [
        csv(['Name', 'Amount', 'Reference', 'Received (signature)']),
        ...rows.map((r) => csv([r.employee, r.amount.toFixed(2), r.reference, ''])),
      ].join('\r\n'),
  },
];

/** The rows of a run's payment files: each payslip's net (a correction: the difference), people with nothing out. */
export async function paymentRows(env: Env, runId: number): Promise<PaymentRow[]> {
  const [run] = await env
    .model('payroll.run')
    .browse([runId as never])
    .load(['name']);
  if (run === undefined) return [];
  // One query for the whole run — the columns the files need, not thirty thousand payslips and as many
  // people turned into records (RFC 0039 §2). Called as the system by the route, which checks who asks.
  await env.flush();
  const rows = await env.sql<{
    name: string;
    pay_method: string | null;
    bank_name: string | null;
    bank_branch: string | null;
    bank_account: string | null;
    routing_number: string | null;
    wallet_provider: string | null;
    wallet_number: string | null;
    amount: string;
  }>`
    SELECT e.name, e.pay_method, e.bank_name, e.bank_branch, e.bank_account, e.routing_number,
           e.wallet_provider, e.wallet_number,
           (CASE WHEN r.kind = 'correction' THEN coalesce(s.difference, 0) ELSE s.net END)::text AS amount
      FROM payroll_slip s
      JOIN payroll_run r ON r.id = s.run_id
      JOIN hr_employee e ON e.id = s.employee_id
     WHERE s.run_id = ${runId}
       AND (CASE WHEN r.kind = 'correction' THEN coalesce(s.difference, 0) ELSE s.net END) > 0
     ORDER BY s.id DESC`;
  return rows.map((row) => ({
    employee: row.name,
    method: row.pay_method ?? 'bank',
    bank: row.bank_name,
    branch: row.bank_branch,
    account: row.bank_account,
    routing: row.routing_number,
    wallet: row.wallet_provider,
    walletNumber: row.wallet_number,
    amount: orm.toDecimal(row.amount),
    reference: `${run.name}`,
  }));
}
