/**
 * The final settlement (RFC 0039 §6): what a person who leaves is owed and owes, worked out by the server on their
 * last day, approved by a Payroll manager, then paid as **a payroll run of its own** — one payslip — so that the
 * proof, the books, the payment and the bank's file are the ones every run has.
 *
 * Worked out, each line with how it came about:
 *
 * - `SALARY`: the days not paid yet — from the day after the person's last approved regular payslip (else the
 *   contract's start or the month's first day) to the last day — by the structure's formula;
 * - `GRATUITY`: by the structure's formula (nothing unless the structure says so);
 * - `NOTICE_PAY` / `NOTICE_SHORT`: the notice not given, valued by the structure's formula for one day — paid to
 *   the person when the company ends the contract, taken from them when they resign;
 * - `LOAN_SETTLE`: what remains of their running loans, in full;
 * - what other apps add (`extraLines`: leave accruals pay the days left);
 * - and the lines added by hand, which a new computation keeps.
 *
 * The formulas read `WAGE`, `UNPAID_DAYS`, `WORKED_DAYS` and `WORKED_HOURS` (approved attendance of the unpaid
 * days), `SERVICE_MONTHS`, `SERVICE_YEARS`, `NOTICE_DAYS`, `NOTICE_SERVED`, `NOTICE_SHORT`, `PAID_BY_DAY`,
 * `PAID_BY_HOUR`.
 */
import { type Decimal, orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { isoDate, refreshTotals } from './compute.js';
import { evaluate, explain, FormulaError, parse, type Scope } from './formula.js';

const ZERO: Decimal = orm.toDecimal(0);
const DAY = 86_400_000;

/** What a settlement's formulas may read. */
export const SETTLEMENT_VARIABLES = [
  'WAGE',
  'UNPAID_DAYS',
  'WORKED_DAYS',
  'WORKED_HOURS',
  'SERVICE_MONTHS',
  'SERVICE_YEARS',
  'NOTICE_DAYS',
  'NOTICE_SERVED',
  'NOTICE_SHORT',
  'PAID_BY_DAY',
  'PAID_BY_HOUR',
] as const;

/** A line another app adds to a settlement (`extraLines`). */
export interface SettlementLineInput {
  readonly code: string;
  readonly name: string;
  readonly category: 'basic' | 'allowance' | 'deduction';
  readonly amount: string;
  readonly explanation?: string;
  /** What the amount is for, in its own unit (days of leave paid out). */
  readonly quantity?: string | null;
}

/** The reasons the company gives notice for — it pays the notice it did not give; a person who resigns owes it. */
const COMPANY_ENDS = new Set(['termination', 'redundancy']);

const dayAfter = (date: string, n = 1): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number =>
  to < from ? 0 : Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;

/** Full months from a day to the end of another (joined on the 15th: a month is full on the 14th after). */
export function fullMonths(from: string, to: string): number {
  if (to < from) return 0;
  const end = dayAfter(to);
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = end.split('-').map(Number) as [number, number, number];
  return Math.max(0, (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0));
}

const refuse = (fields: string[], message: string, hint: string): never => {
  throw new orm.ValidationError('payroll.settlement', fields, message, hint);
};

/**
 * Works a settlement out and writes it: the server's lines are replaced, the lines added by hand kept, the
 * figures summed. Run as the system (wages are HR's to read).
 */
export async function computeSettlement(su: Env, id: number): Promise<void> {
  const [s] = await su
    .model('payroll.settlement')
    .browse([id] as never)
    .load({ employee: true, company: true });
  if (s === undefined) return;
  const lastDay = isoDate(s.lastDay);
  const [contract] = await (
    await su.model('hr.contract').search({
      where: { employee: s.employee.id, state: 'running', dateStart: { lte: lastDay } },
      order: ['dateStart desc', 'id desc'],
      limit: 1,
    })
  ).load({ structure: true });
  if (contract === undefined)
    return refuse(
      ['employee'],
      `${s.employee.name} has no running contract on ${lastDay}.`,
      'A settlement is worked out from the running contract: check its dates and that it was started.',
    );
  const structure = contract.structure;
  if (structure === null)
    return refuse(
      ['employee'],
      `The contract of ${s.employee.name} has no salary structure.`,
      'Give the contract a salary structure: its formulas value the settlement.',
    );

  // From when the person is still to be paid: the day after their last approved regular payslip.
  await su.flush();
  const [paid] = await su.sql<{ next: string | null }>`
    SELECT to_char(max(sl.date_to) + 1, 'YYYY-MM-DD') AS next
      FROM payroll_slip sl
      JOIN payroll_run r ON r.id = sl.run_id
     WHERE sl.employee_id = ${s.employee.id} AND r.state IN ('approved', 'paid') AND r.kind = 'regular'`;
  const monthStart = `${lastDay.slice(0, 7)}-01`;
  const contractStart = isoDate(contract.dateStart);
  const unpaidFrom = paid?.next ?? (contractStart > monthStart ? contractStart : monthStart);
  const unpaidDays = daysBetween(unpaidFrom, lastDay);
  const [seen] = await su.sql<{ worked: number; hours: string; waiting: number }>`
    SELECT count(*) FILTER (WHERE d.state = 'approved'
                              AND d.status IN ('present', 'tour', 'remote'))::int AS worked,
           coalesce(sum(d.worked_hours) FILTER (WHERE d.state = 'approved'), 0)::text AS hours,
           count(*) FILTER (WHERE d.state <> 'approved')::int AS waiting
      FROM attendance_day d
     WHERE d.employee_id = ${s.employee.id}
       AND d.date BETWEEN ${unpaidFrom}::date AND ${lastDay}::date`;

  const joined = isoDate(s.employee.hireDate ?? contract.dateStart);
  const months = fullMonths(joined, lastDay);
  const noticeDays = s.noticeDays ?? 0;
  const noticeServed = s.noticeServed ?? 0;
  const short = Math.max(0, noticeDays - noticeServed);
  const variables = new Map<string, Decimal>(
    Object.entries({
      WAGE: contract.wage ?? ZERO,
      UNPAID_DAYS: unpaidDays,
      WORKED_DAYS: seen?.worked ?? 0,
      WORKED_HOURS: seen?.hours ?? '0',
      SERVICE_MONTHS: months,
      SERVICE_YEARS: Math.floor(months / 12),
      NOTICE_DAYS: noticeDays,
      NOTICE_SERVED: noticeServed,
      NOTICE_SHORT: short,
      PAID_BY_DAY: contract.payBasis === 'day' ? 1 : 0,
      PAID_BY_HOUR: contract.payBasis === 'hour' ? 1 : 0,
    }).map(([name, value]) => [name, orm.toDecimal(value as never)]),
  );
  const scope: Scope = { variables, slabs: new Map() };
  const valued = (formula: string, what: string): { amount: Decimal; why: string } => {
    try {
      const amount = evaluate(parse(formula), scope).toDecimalPlaces(2);
      return { amount, why: `${explain(formula, scope)} = ${amount.toString()}`.slice(0, 1000) };
    } catch (error) {
      if (error instanceof FormulaError)
        return refuse(
          ['employee'],
          `${what} of the structure ${structure.name}: ${error.message}`,
          `Fix the formula in Payroll › Configuration › Structures. It may read ${SETTLEMENT_VARIABLES.join(', ')}.`,
        );
      throw error;
    }
  };

  const lines: Record<string, unknown>[] = [];
  const add = (
    sequence: number,
    code: string,
    name: string,
    category: string,
    amount: Decimal,
    explanation: string,
    quantity: string | null = null,
  ): void => {
    if (amount.isZero()) return;
    lines.push({
      settlement: id,
      sequence,
      code,
      name,
      category,
      amount: amount.toDecimalPlaces(2).toString(),
      explanation: explanation.slice(0, 1000),
      quantity,
      manual: false,
    });
  };
  const salary = valued(structure.settleSalary, 'The salary of the unpaid days');
  add(
    10,
    'SALARY',
    `Salary, ${unpaidFrom} to ${lastDay}`,
    'basic',
    salary.amount,
    salary.why,
    String(unpaidDays),
  );
  const gratuity = valued(structure.settleGratuity, 'The gratuity');
  add(20, 'GRATUITY', 'Gratuity', 'allowance', gratuity.amount, gratuity.why);
  if (short > 0) {
    const day = valued(structure.settleNotice, 'The value of a day of notice');
    const amount = day.amount.times(short).toDecimalPlaces(2);
    const why = `${short} day(s) × (${day.why}) = ${amount.toString()}`;
    if (COMPANY_ENDS.has(s.reason))
      add(30, 'NOTICE_PAY', 'Pay in lieu of notice', 'allowance', amount, why, String(short));
    else if (s.reason === 'resignation')
      add(30, 'NOTICE_SHORT', 'Notice not served', 'deduction', amount, why, String(short));
  }
  // What other apps add: the leave left, paid out.
  const extra = (await su
    .model('payroll.settlement')
    .browse([id] as never)
    .extraLines()) as readonly SettlementLineInput[];
  let sequence = 40;
  for (const line of extra) {
    add(
      sequence,
      line.code,
      line.name,
      line.category,
      orm.toDecimal(line.amount),
      line.explanation ?? '',
      line.quantity ?? null,
    );
    sequence += 1;
  }
  const loans = await su
    .model('payroll.loan')
    .search({ where: { employee: s.employee.id, state: 'running' } });
  const owed = [...loans].reduce((sum, l) => sum.plus(l.remaining ?? ZERO), ZERO);
  add(
    90,
    'LOAN_SETTLE',
    'Loans, what remains',
    'deduction',
    owed,
    `${loans.length} running loan(s), ${owed.toString()} left to repay`,
  );

  const old = await su
    .model('payroll.settlement.line')
    .search({ where: { settlement: id as never, manual: false } });
  if (old.length > 0) await old.unlink();
  if (lines.length > 0) await su.model('payroll.settlement.line').create(lines as never);
  await su.flush();
  const [sums] = await su.sql<{ gross: string; deductions: string }>`
    SELECT coalesce(sum(amount) FILTER (WHERE category IN ('basic', 'allowance')), 0)::text AS gross,
           coalesce(sum(amount) FILTER (WHERE category = 'deduction'), 0)::text AS deductions
      FROM payroll_settlement_line WHERE settlement_id = ${id}`;
  const gross = orm.toDecimal(sums?.gross ?? '0');
  const deductions = orm.toDecimal(sums?.deductions ?? '0');
  const warnings: string[] = [];
  if (unpaidFrom > lastDay)
    warnings.push(
      `Already paid through ${dayAfter(unpaidFrom, -1)}, after the last day: take back what was paid for the days after it with a line by hand.`,
    );
  if ((seen?.waiting ?? 0) > 0)
    warnings.push(`${seen?.waiting} attendance day(s) of the unpaid days wait for approval.`);
  if (gross.lt(deductions))
    warnings.push('The person owes more than they are owed: nothing is paid out.');
  await su
    .model('payroll.settlement')
    .browse([id] as never)
    .write({
      contract: contract.id,
      unpaidFrom,
      gross: gross.toString(),
      deductions: deductions.toString(),
      net: gross.minus(deductions).toString(),
      warnings: warnings.length === 0 ? null : warnings.join('\n'),
    } as never);
  await su.flush();
}

/**
 * The payslip of a settlement's run, from the settlement's lines (the run's computation, for a run of the kind
 * *settlement*): the one it had is replaced. Returns 1 when the run pays somebody.
 */
export async function fillSettlementRun(su: Env, runId: number): Promise<number> {
  const [s] = await (
    await su.model('payroll.settlement').search({ where: { run: runId as never }, limit: 1 })
  ).load({ employee: true, contract: { structure: true }, lines: true, company: true });
  const [run] = await su
    .model('payroll.run')
    .browse([runId] as never)
    .load(['name', 'dateFrom', 'dateTo', 'computeRound']);
  await su.flush();
  await su.sql`DELETE FROM payroll_slip WHERE run_id = ${runId}`;
  if (s !== undefined && run !== undefined)
    await su.model('payroll.slip').create([
      {
        name: `${run.name} ${s.employee.name}`,
        run: runId,
        company: s.company.id,
        employee: s.employee.id,
        contract: s.contract?.id ?? null,
        structure: s.contract?.structure?.id ?? null,
        dateFrom: isoDate(run.dateFrom),
        dateTo: isoDate(run.dateTo),
        gross: s.gross.toString(),
        deductions: s.deductions.toString(),
        contributions: '0',
        net: s.net.toString(),
        warnings: s.warnings,
        lines: {
          create: [...s.lines].map((l) => ({
            sequence: l.sequence,
            code: l.code,
            name: l.name,
            category: l.category,
            amount: l.amount.toString(),
            explanation: l.explanation,
            appearsOnSlip: true,
          })),
        },
      } as never,
    ]);
  const people = s === undefined ? 0 : 1;
  await su
    .model('payroll.run')
    .browse([runId] as never)
    .write({
      toCompute: people,
      computedCount: people,
      computeCursor: 0,
      computeError: null,
      computeRound: (run?.computeRound ?? 0) + 1,
    } as never);
  await refreshTotals(su, runId);
  return people;
}

/**
 * An approved settlement takes effect, once: its payroll run — made, computed from its lines, proved and approved,
 * which books it —, the loans repaid in full, the contract ended on the last day, and what other apps do
 * (`settledOut`: the leave paid out leaves the ledger). The run is then paid like any other.
 */
export async function settle(su: Env, id: number): Promise<void> {
  const [s] = await su
    .model('payroll.settlement')
    .browse([id] as never)
    .load({ employee: true, company: true, contract: true });
  if (s === undefined || s.run !== null) return;
  const lastDay = isoDate(s.lastDay);
  const unpaidFrom = isoDate(s.unpaidFrom ?? s.lastDay);
  const made = await su.model('payroll.run').create([
    {
      kind: 'settlement',
      title: `Final settlement ${s.name} — ${s.employee.name}`,
      company: s.company.id,
      dateFrom: unpaidFrom > lastDay ? lastDay : unpaidFrom,
      dateTo: lastDay,
    } as never,
  ]);
  const runId = made.ids[0] as number;
  await su
    .model('payroll.settlement')
    .browse([id] as never)
    .write({ run: runId } as never);
  await su.flush();
  const run = su.model('payroll.run').browse([runId] as never);
  await run.compute();
  await run.approve();

  // The loans: what the settlement took is all that remained.
  const [slip] = await su
    .model('payroll.slip')
    .search({ where: { run: runId as never }, limit: 1 });
  const loans = await (
    await su.model('payroll.loan').search({ where: { employee: s.employee.id, state: 'running' } })
  ).load(['remaining']);
  for (const loan of loans) {
    const left = loan.remaining ?? ZERO;
    if (left.gt(0))
      await su.model('payroll.loan.repayment').create([
        {
          loan: loan.id,
          slip: slip?.id ?? null,
          date: lastDay,
          amount: left.toString(),
        } as never,
      ]);
  }
  await su.flush();
  if (loans.length > 0) await su.model('payroll.loan').browse(loans.ids).finish();

  // The contract ends on the last day; it is closed once that day has come.
  if (s.contract !== null) {
    const contract = su.model('hr.contract').browse([s.contract.id]);
    await contract.write({ dateEnd: lastDay } as never);
    const [c] = await contract.load(['state']);
    if (c?.state === 'running' && lastDay <= isoDate(su.today())) await contract.end();
  }
  await su
    .model('payroll.settlement')
    .browse([id] as never)
    .settledOut();
  await su.flush();
}
