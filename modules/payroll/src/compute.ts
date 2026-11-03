/**
 * The payroll engine (RFC 0024 §2.3): a run's payslips computed from each person's running contract and its
 * structure. Every rule sees these variables, then the codes of the rules before it:
 *
 * - `WAGE` (the contract's monthly wage), `PERIOD_DAYS`, `CONTRACT_DAYS` (the contract's days in the period: joiners
 *   and leavers paid in proportion), `SERVICE_MONTHS` (since joining), `MONTH`, `FY_MONTH` and `MONTHS_LEFT` (in the
 *   fiscal year that starts in the month of App settings › Payroll, July by default);
 * - from Attendance's **approved** days: `PRESENT_DAYS`, `ABSENT_DAYS`, `LEAVE_DAYS`, `HOLIDAYS`, `LATE_DAYS`,
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

/** Computes the payslips of runs (replacing those it had); the run must be a draft or computed. */
export async function computeRuns(env: Env, ids: readonly number[]): Promise<void> {
  const startMonth = await fiscalStartOf(env);
  for (const run of await env
    .model('payroll.run')
    .browse(ids as never)
    .load({ company: true, correctionOf: true })) {
    const from = isoDate(run.dateFrom);
    const to = isoDate(run.dateTo);
    // The slips the run had are replaced.
    const old = await env.model('payroll.slip').search({ where: { run: run.id } });
    if (old.length > 0) await old.unlink();

    // Who: the people of the corrected run, else every running contract with a structure in the period.
    let contracts = [
      ...(await (
        await env.model('hr.contract').search({
          where: {
            company: run.company.id,
            state: 'running',
            structure: { isNull: false },
            dateStart: { lte: to },
            or: [{ dateEnd: { isNull: true } }, { dateEnd: { gte: from } }],
          },
        })
      ).load({ employee: true, structure: true })),
    ];
    const previous = new Map<number, Decimal>();
    if (run.correctionOf !== null) {
      for (const s of await (
        await env.model('payroll.slip').search({ where: { run: run.correctionOf.id } })
      ).load({ employee: true }))
        previous.set(s.employee.id, s.net);
      contracts = contracts.filter((c) => previous.has(c.employee.id));
    }

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
      for (const v of [
        ...(await (
          await env.model('payroll.employee.value').search({ where: { employee: e.id } })
        ).load(['code', 'value', 'dateFrom', 'dateTo'])),
      ]
        .filter((v) => inForce(v, to))
        .sort((a, b) => isoDate(a.dateFrom ?? '').localeCompare(isoDate(b.dateFrom ?? ''))))
        set(`E_${v.code}`, v.value);

      // Attendance: approved days only.
      const attendance = [
        ...(await (
          await env.model('attendance.day').search({
            where: { employee: e.id, date: { gte: from, lte: to } },
          })
        ).load(['status', 'state', 'lateMinutes', 'overtimeApproved', 'overtimeRate'])),
      ];
      const approved = attendance.filter((d) => d.state === 'approved');
      const count = (status: string) => approved.filter((d) => d.status === status).length;
      set('PRESENT_DAYS', count('present'));
      set('ABSENT_DAYS', count('absent'));
      set('LEAVE_DAYS', count('leave'));
      set('HOLIDAYS', count('holiday'));
      set('LATE_DAYS', approved.filter((d) => d.lateMinutes > 0).length);
      const overtime = approved.reduce((s, d) => s.plus(d.overtimeApproved), ZERO);
      set('OVERTIME_HOURS', overtime);
      set(
        'OVERTIME_RATE',
        approved.find((d) => d.overtimeApproved.gt(0))?.overtimeRate ?? orm.toDecimal(2),
      );
      const waiting = attendance.length - approved.length;
      if (waiting > 0)
        warnings.push(
          `${waiting} attendance day(s) of the period are not approved and are left out.`,
        );

      // Inputs of the period, running loans, and what was paid this fiscal year.
      for (const i of await (
        await env
          .model('payroll.input')
          .search({ where: { employee: e.id, date: { gte: from, lte: to } } })
      ).load(['code', 'amount']))
        set(`INPUT_${i.code}`, (variables.get(`INPUT_${i.code}`) ?? ZERO).plus(i.amount));
      let loan = ZERO;
      for (const l of await (
        await env.model('payroll.loan').search({
          where: { employee: e.id, state: 'running', dateStart: { lte: to } },
        })
      ).load(['installment', 'remaining']))
        loan = loan.plus(
          l.installment.lt(l.remaining ?? ZERO) ? l.installment : (l.remaining ?? ZERO),
        );
      set('LOAN', loan);
      for (const [code, amount] of await yearToDate(env, e.id, fyStart, from))
        set(`YTD_${code}`, amount);

      // The rules, in order.
      const rules = [
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
      ]
        .filter((r) => inForce(r, to))
        .sort((a, b) => a.sequence - b.sequence || a.id - b.id);
      const scope: Scope = {
        variables,
        slabs,
        zero: (name) =>
          name.startsWith('INPUT_') ||
          name.startsWith('YTD_') ||
          name.startsWith('E_') ||
          rules.some((r) => r.code === name),
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
      await env.model('payroll.slip').create([
        {
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
        } as never,
      ]);
    }
  }
}

/**
 * What the person was paid this fiscal year before `before`, by rule code: per period, the latest approved or paid
 * payslip (a correction replaces the payslip it corrects).
 */
async function yearToDate(
  env: Env,
  employee: number,
  fyStart: string,
  before: string,
): Promise<Map<string, Decimal>> {
  const slips = [
    ...(await (
      await env.model('payroll.slip').search({
        where: {
          employee: employee as never,
          dateFrom: { gte: fyStart, lt: before },
          'run.state': { in: ['approved', 'paid'] },
        },
      })
    ).load({ lines: true })),
  ];
  const latest = new Map<string, (typeof slips)[number]>();
  for (const s of slips) {
    const key = isoDate(s.dateFrom);
    const kept = latest.get(key);
    if (kept === undefined || s.id > kept.id) latest.set(key, s);
  }
  const out = new Map<string, Decimal>();
  for (const s of latest.values())
    for (const l of s.lines) out.set(l.code, (out.get(l.code) ?? ZERO).plus(l.amount));
  return out;
}

/** On approval: each running loan's instalment taken by its payslip; repaid loans finished. */
export async function recordRepayments(env: Env, runIds: readonly number[]): Promise<void> {
  for (const run of await env
    .model('payroll.run')
    .browse(runIds as never)
    .load({ slips: true })) {
    if (run.kind === 'correction') continue;
    for (const slip of run.slips) {
      const taken = [
        ...(await (
          await env.model('payroll.slip.line').search({ where: { slip: slip.id, code: 'LOAN' } })
        ).load(['amount'])),
      ].reduce((s, l) => s.plus(l.amount), ZERO);
      let left = taken;
      for (const loan of await (
        await env.model('payroll.loan').search({
          where: {
            employee: slip.employee.id,
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
    .load({ slips: { employee: true } });
  if (run === undefined) return [];
  return [...run.slips]
    .map((s) => ({ slip: s, amount: run.kind === 'correction' ? (s.difference ?? ZERO) : s.net }))
    .filter((x) => x.amount.gt(0))
    .map(({ slip, amount }) => ({
      employee: slip.employee.name,
      method: slip.employee.payMethod ?? 'bank',
      bank: slip.employee.bankName,
      branch: slip.employee.bankBranch,
      account: slip.employee.bankAccount,
      routing: slip.employee.routingNumber,
      wallet: slip.employee.walletProvider,
      walletNumber: slip.employee.walletNumber,
      amount,
      reference: `${run.name}`,
    }));
}
