/**
 * The data layer of Payroll (RFC 0024 §2.3): salary **structures** of **rules** (a code, a category, a formula in
 * the payroll language, an optional condition, effective dates), versioned **parameters** and progressive **slab
 * tables** (rates and thresholds are data, never code), one-off **inputs**, **loans** repaid run by run, monthly
 * **runs** with a **payslip** per person whose **lines** carry their explanation, and the employee's pay details.
 *
 * People read their own payslips; payroll officers prepare runs; payroll managers approve them, which locks them —
 * a correction is a new run that refers to the old one, never an edit.
 */
import { attendanceShutro } from '@kosh/attendance';
import { hrShutro } from '@kosh/hr';
import { emitting } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  method,
  records,
} from './.kosh/bindings.js';
import {
  COMPUTE_JOB,
  checkRun,
  computeBatch,
  INLINE_LIMIT,
  recordRepayments,
  refreshTotals,
  startRun,
} from './compute.js';
import { FormulaError, parse } from './formula.js';
import {
  computeSettlement,
  fillSettlementRun,
  type SettlementLineInput,
  settle,
} from './settlement.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
// Only the server writes these (a run's figures and how far its computation is).
const SYSTEM = ['base.admin'] as const;
const OFFICERS = ['payroll.officer'];
const me = { $env: 'uid' } as const;
const ZERO: Decimal = orm.toDecimal(0);
const CODE = orm.sql`~ '^[A-Z][A-Z0-9_]*$'`;

export const CATEGORIES = {
  basic: 'Basic',
  allowance: 'Allowance',
  deduction: 'Deduction',
  contribution: 'Company contribution',
  info: 'For information',
} as const;

/** The formulas that do not parse, by record id. */
function badFormulas<T extends { id: number; formula?: string | null; condition?: string | null }>(
  rows: Iterable<T>,
): number[] {
  const out: number[] = [];
  for (const r of rows)
    for (const text of [r.formula, r.condition])
      if (text != null && text.trim() !== '')
        try {
          parse(text);
        } catch (error) {
          if (error instanceof FormulaError) {
            out.push(r.id);
            break;
          }
          throw error;
        }
  return out;
}

export const PayrollStructure = defineModel('payroll.structure', {
  label: 'Salary structure',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  tracking: ['name'],
  access: { 'payroll.officer': READ, 'payroll.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    rules: f.one2many('payroll.rule', 'structure'),
    note: f.text(),
    // What a final settlement is valued by (RFC 0039 §6), in the payroll language.
    settleSalary: f.char({
      size: 500,
      required: true,
      default:
        'if(PAID_BY_DAY, WAGE * WORKED_DAYS, if(PAID_BY_HOUR, WAGE * WORKED_HOURS, WAGE * UNPAID_DAYS / 30))',
      label: 'Settlement: salary of the unpaid days',
      help: 'From the day after the last approved payslip to the last day. It may read WAGE, UNPAID_DAYS, WORKED_DAYS, WORKED_HOURS, PAID_BY_DAY and PAID_BY_HOUR.',
    }),
    settleGratuity: f.char({
      size: 500,
      required: true,
      default: '0',
      label: 'Settlement: gratuity',
      help: 'What the person is owed for their service: if(SERVICE_YEARS >= 5, WAGE * SERVICE_YEARS, 0). It may read WAGE, SERVICE_MONTHS and SERVICE_YEARS. 0: none.',
    }),
    settleNotice: f.char({
      size: 500,
      required: true,
      default: 'WAGE / 30',
      label: 'Settlement: a day of notice is worth',
      help: 'Times the notice days not given: paid to the person when the company ends the contract, taken from them when they resign.',
    }),
  },
  constraints: {
    settlementFormulas: {
      ...check(
        'payroll.structure',
        ['settleSalary', 'settleGratuity', 'settleNotice'],
        (structures) =>
          [...structures]
            .filter(
              (s) =>
                badFormulas([
                  { id: 1, formula: s.settleSalary },
                  { id: 2, formula: s.settleGratuity },
                  { id: 3, formula: s.settleNotice },
                ]).length > 0,
            )
            .map((s) => s.id),
      ),
      message: 'A settlement formula is not in the payroll language.',
    },
  },
});

export const PayrollRule = defineModel('payroll.rule', {
  label: 'Salary rule',
  recName: 'name',
  order: ['sequence asc', 'id asc'],
  tracking: ['formula', 'condition', 'dateFrom', 'dateTo'],
  access: { 'payroll.officer': READ, 'payroll.manager': [...ALL, 'export', 'import'] },
  fields: {
    structure: f.many2one('payroll.structure', { required: true, ondelete: 'cascade' }),
    sequence: f.integer({ required: true, default: 10 }),
    code: f.char({
      size: 40,
      required: true,
      help: 'In capitals; later rules read this rule’s amount by it (BASIC, HOUSE_RENT…).',
    }),
    name: f.char({ required: true, translate: true }),
    category: f.selection(CATEGORIES, {
      required: true,
      default: 'allowance',
      help: 'Basic and allowances make the gross; deductions come off it; company contributions are paid on top.',
    }),
    formula: f.char({
      size: 500,
      required: true,
      default: '0',
      help: "In the payroll language: WAGE * 0.6, max(0, ABSENT_DAYS) * BASIC / 30, slab('TAX', …).",
    }),
    condition: f.char({
      size: 500,
      label: 'Applies when',
      help: 'Empty: always; otherwise a formula that is not zero (SERVICE_MONTHS >= 12).',
    }),
    appearsOnSlip: f.boolean({ default: true, label: 'On the payslip' }),
    dateFrom: f.date({ label: 'Valid from' }),
    dateTo: f.date({ label: 'Valid to' }),
    note: f.text(),
  },
  sqlConstraints: {
    code: { check: orm.sql`code ${CODE}`, message: 'A code is written in capitals, digits and _.' },
    ordered: {
      check: orm.sql`date_to IS NULL OR date_from IS NULL OR date_to >= date_from`,
      message: 'A rule ends on or after it starts.',
    },
  },
  constraints: {
    formulas: {
      ...check('payroll.rule', ['formula', 'condition'], (rules) => badFormulas(rules)),
      message: 'The formula or the condition is not in the payroll language.',
    },
  },
});

export const PayrollParameter = defineModel('payroll.parameter', {
  label: 'Payroll parameter',
  recName: 'name',
  order: ['code asc', 'dateFrom desc'],
  tracking: ['value', 'dateFrom', 'dateTo'],
  access: { 'payroll.officer': READ, 'payroll.manager': [...ALL, 'export', 'import'] },
  fields: {
    code: f.char({
      size: 40,
      required: true,
      help: 'Read in formulas as P_ and the code (P_TAX_FREE).',
    }),
    name: f.char({ required: true, translate: true }),
    value: f.decimal({ scale: 4, required: true }),
    dateFrom: f.date({ label: 'Valid from' }),
    dateTo: f.date({ label: 'Valid to' }),
    note: f.text({ help: 'Where the value comes from (the law, the circular, the year).' }),
  },
  sqlConstraints: {
    code: { check: orm.sql`code ${CODE}`, message: 'A code is written in capitals, digits and _.' },
  },
});

export const PayrollSlab = defineModel('payroll.slab', {
  label: 'Slab table',
  recName: 'name',
  order: ['code asc', 'dateFrom desc'],
  archivable: true,
  tracking: ['dateFrom', 'dateTo'],
  access: { 'payroll.officer': READ, 'payroll.manager': [...ALL, 'export', 'import'] },
  fields: {
    code: f.char({ size: 40, required: true, help: "Read in formulas as slab('CODE', amount)." }),
    name: f.char({ required: true, translate: true }),
    dateFrom: f.date({ label: 'Valid from' }),
    dateTo: f.date({ label: 'Valid to' }),
    bands: f.one2many('payroll.slab.band', 'slab'),
    note: f.text({ help: 'Where the bands come from (the Finance Act, the year).' }),
  },
  sqlConstraints: {
    code: { check: orm.sql`code ${CODE}`, message: 'A code is written in capitals, digits and _.' },
  },
});

export const PayrollSlabBand = defineModel('payroll.slab.band', {
  label: 'Slab band',
  order: ['sequence asc', 'id asc'],
  access: { 'payroll.officer': READ, 'payroll.manager': ALL },
  fields: {
    slab: f.many2one('payroll.slab', { required: true, ondelete: 'cascade' }),
    sequence: f.integer({ required: true, default: 10 }),
    upTo: f.decimal({
      scale: 2,
      label: 'Up to',
      help: 'The band ends at this amount; empty: the rest.',
    }),
    rate: f.decimal({ scale: 2, required: true, default: '0', label: 'Rate (%)' }),
  },
});

export const PayrollEmployeeValue = defineModel('payroll.employee.value', {
  label: 'Per-person payroll value',
  order: ['code asc', 'dateFrom desc'],
  companyScoped: { required: true },
  tracking: ['value', 'dateFrom', 'dateTo'],
  access: { 'payroll.user': READ, 'payroll.officer': [...ALL, 'export', 'import'] },
  rules: {
    own: { groups: ['payroll.user'], perms: ['read'], domain: { 'employee.user': me } },
    officers: { groups: ['payroll.officer'], perms: [...ALL], domain: {} },
  },
  fields: {
    employee: f.many2one('hr.employee', { required: true, ondelete: 'cascade' }),
    code: f.char({
      size: 40,
      required: true,
      help: 'Read in formulas as E_ and the code (E_PF_MEMBER, E_INVESTMENT, E_MOBILE_ALLOWANCE).',
    }),
    value: f.decimal({ scale: 4, required: true }),
    dateFrom: f.date({ label: 'Valid from' }),
    dateTo: f.date({ label: 'Valid to' }),
    note: f.char(),
  },
  sqlConstraints: {
    code: { check: orm.sql`code ${CODE}`, message: 'A code is written in capitals, digits and _.' },
  },
});

export const PayrollInput = defineModel('payroll.input', {
  label: 'Payroll input',
  order: ['date desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['amount'],
  access: { 'payroll.user': READ, 'payroll.officer': [...ALL, 'export', 'import'] },
  rules: {
    own: { groups: ['payroll.user'], perms: ['read'], domain: { 'employee.user': me } },
    officers: { groups: ['payroll.officer'], perms: [...ALL], domain: {} },
  },
  fields: {
    employee: f.many2one('hr.employee', { required: true, ondelete: 'cascade' }),
    date: f.date({ required: true, help: 'The month it is paid in.' }),
    code: f.char({
      size: 40,
      required: true,
      help: 'Read in formulas as INPUT_ and the code (INPUT_BONUS).',
    }),
    amount: f.decimal({ scale: 2, required: true }),
    note: f.char(),
  },
  sqlConstraints: {
    code: { check: orm.sql`code ${CODE}`, message: 'A code is written in capitals, digits and _.' },
  },
});

export const PayrollLoan = defineModel('payroll.loan', {
  label: 'Salary loan',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'amount', 'installment'],
  access: { 'payroll.user': READ, 'payroll.officer': [...ALL, 'export', 'import'] },
  rules: {
    own: { groups: ['payroll.user'], perms: ['read'], domain: { 'employee.user': me } },
    officers: { groups: ['payroll.officer'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, sequence: 'payroll.loan', label: 'Reference' }),
    employee: f.many2one('hr.employee', { required: true, ondelete: 'restrict' }),
    amount: f.decimal({ scale: 2, required: true }),
    installment: f.decimal({ scale: 2, required: true, label: 'Per month' }),
    dateStart: f.date({ required: true, label: 'First deduction in' }),
    repayments: f.one2many('payroll.loan.repayment', 'loan'),
    repaid: f.decimal({
      scale: 2,
      label: 'Repaid',
      help: 'The instalments taken by approved payroll runs.',
      ...compute('payroll.loan', 'repaid', ['repayments.amount'], (loans) => {
        for (const l of loans)
          l.repaid = [...l.repayments].reduce((s, r) => s.plus(r.amount), ZERO);
      }),
      store: true,
    }),
    remaining: f.decimal({
      scale: 2,
      label: 'Remaining',
      help: 'The loan less what was repaid; the loan ends when nothing remains.',
      ...compute('payroll.loan', 'remaining', ['amount', 'repaid'], (loans) => {
        for (const l of loans) l.remaining = l.amount.minus(l.repaid ?? ZERO);
      }),
      store: true,
    }),
    state: f.state({
      states: { draft: 'Draft', running: 'Being repaid', done: 'Repaid', cancelled: 'Cancelled' },
      initial: 'draft',
      help: 'Being repaid: each approved run deducts the instalment until nothing remains.',
      transitions: {
        start: {
          from: ['draft'],
          to: 'running',
          requires: 'payroll.approve',
          after: records('payroll.loan', async (loans) => {
            for (const id of loans.ids) await loans.env.emit('payroll.loan.started', { id });
          }),
        },
        finish: { from: ['running'], to: 'done' },
        cancel: { from: ['draft'], to: 'cancelled' },
      },
    }),
  },
  sqlConstraints: {
    positive: {
      check: orm.sql`amount > 0 AND installment > 0 AND installment <= amount`,
      message: 'A loan and its instalment are positive, the instalment no more than the loan.',
    },
  },
});

export const PayrollLoanRepayment = defineModel('payroll.loan.repayment', {
  label: 'Loan repayment',
  order: ['date asc', 'id asc'],
  access: { 'payroll.user': READ, 'payroll.officer': READ, 'payroll.manager': ALL },
  rules: {
    own: { groups: ['payroll.user'], perms: ['read'], domain: { 'loan.employee.user': me } },
    officers: { groups: ['payroll.officer'], perms: ['read'], domain: {} },
    managers: { groups: ['payroll.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    loan: f.many2one('payroll.loan', { required: true, ondelete: 'cascade' }),
    slip: f.many2one('payroll.slip', { ondelete: 'set null', label: 'Payslip' }),
    date: f.date({ required: true }),
    amount: f.decimal({ scale: 2, required: true }),
  },
});

const RUN_STATES = {
  draft: 'Draft',
  computed: 'Computed',
  approved: 'Approved',
  paid: 'Paid',
  cancelled: 'Cancelled',
} as const;

export const PayrollRun = defineModel('payroll.run', {
  label: 'Payroll run',
  recName: 'name',
  order: ['dateFrom desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'gross', 'net'],
  access: { 'payroll.officer': [...ALL, 'export'], 'payroll.manager': [...ALL, 'export'] },
  fields: {
    name: f.char({ required: true, sequence: 'payroll.run', label: 'Reference' }),
    title: f.char({ label: 'Title', help: 'October 2026 salaries, the Eid bonus…' }),
    kind: f.selection(
      { regular: 'Regular', correction: 'Correction', settlement: 'Final settlement' },
      {
        required: true,
        default: 'regular',
        help: 'A correction pays the difference to an approved run of the same period, which stays as it was. A final settlement’s run is made by its settlement and pays the person who leaves.',
      },
    ),
    correctionOf: f.many2one('payroll.run', { ondelete: 'restrict', label: 'Corrects' }),
    dateFrom: f.date({ required: true, label: 'From' }),
    dateTo: f.date({ required: true, label: 'To' }),
    paymentDate: f.date({ label: 'Paid on' }),
    festival: f.boolean({
      default: false,
      label: 'Festival bonus run',
      help: 'Read in formulas as FESTIVAL (1 or 0): the run that pays a festival bonus (Eid, Puja…).',
    }),
    slips: f.one2many('payroll.slip', 'run', { label: 'Payslips' }),
    // The figures of a run are sums the database makes once per batch of payslips (`refreshTotals`): a run of
    // 30 000 people does not read every payslip again each time one is added (RFC 0039 §2).
    slipCount: f.integer({
      default: 0,
      label: 'Payslips',
      groups: { write: [...SYSTEM] },
    }),
    gross: f.decimal({
      scale: 2,
      default: '0',
      label: 'Gross',
      help: 'The payslips’ basic and allowances.',
      groups: { write: [...SYSTEM] },
    }),
    net: f.decimal({
      scale: 2,
      default: '0',
      label: 'Net',
      help: 'What the payslips pay out.',
      groups: { write: [...SYSTEM] },
    }),
    toCompute: f.integer({
      default: 0,
      label: 'People to compute',
      help: 'How many people the run pays; a large run is computed in the background, a batch at a time.',
      groups: { write: [...SYSTEM] },
    }),
    computedCount: f.integer({
      default: 0,
      label: 'People computed',
      help: 'How far the computation is. The run is approved once everybody is computed.',
      groups: { write: [...SYSTEM] },
    }),
    /** The last person computed: the next batch starts after them. */
    computeCursor: f.integer({ default: 0, groups: { write: [...SYSTEM] } }),
    /** Counts the computations of the run: a batch left over from an earlier one does nothing. */
    computeRound: f.integer({ default: 0, groups: { write: [...SYSTEM] } }),
    computeError: f.text({
      label: 'What stopped the computation',
      help: 'The person and the rule a formula failed on. Fix it, then compute again.',
      groups: { write: [...SYSTEM] },
    }),
    state: f.state({
      states: RUN_STATES,
      initial: 'draft',
      help: 'Computed, checked, approved (then locked), paid.',
      transitions: {
        compute: {
          from: ['draft', 'computed'],
          to: 'computed',
          // Not while the job is still at it: it would be computed twice at once.
          guard: records('payroll.run', async (runs) =>
            [...(await runs.load(['state', 'toCompute', 'computedCount', 'computeError']))]
              .filter(
                (r) =>
                  r.state === 'computed' &&
                  (r.computedCount ?? 0) < (r.toCompute ?? 0) &&
                  (r.computeError ?? '') === '',
              )
              .map((r) => r.id),
          ),
          message:
            'The payslips are being computed: wait until everybody is computed, or set the run back to draft.',
          // The payslips, from the contracts, attendance, inputs and loans (read as the system: wages are HR's).
          // A small run at once; a large one by the job, a batch at a time (RFC 0039 §2): the run shows how
          // far it is, and is approved once everybody is computed.
          after: records('payroll.run', async (runs) => {
            const env = runs.env as unknown as Env;
            await env.flush();
            const later: number[] = [];
            await env.asSuperuser({ reason: 'compute payroll' }, async (su) => {
              const kinds = new Map(
                [
                  ...(await su
                    .model('payroll.run')
                    .browse(runs.ids as never)
                    .load(['kind'])),
                ].map((r) => [r.id as number, r.kind]),
              );
              for (const id of runs.ids as readonly number[]) {
                // A settlement's run is its settlement's lines, not the structure's rules.
                if (kinds.get(id) === 'settlement') {
                  await fillSettlementRun(su, id);
                  continue;
                }
                const total = await startRun(su, id);
                if (total > INLINE_LIMIT) {
                  await refreshTotals(su, id);
                  later.push(id);
                  continue;
                }
                while ((await computeBatch(su, id)) > 0);
                await refreshTotals(su, id);
              }
              await su.flush();
            });
            for (const id of later) {
              const [run] = await env
                .model('payroll.run')
                .browse([id] as never)
                .load(['computeRound']);
              const round = run?.computeRound ?? 0;
              await env.enqueue(
                COMPUTE_JOB,
                { run: id, round },
                { key: `${COMPUTE_JOB}:${id}:${round}:0` },
              );
            }
          }),
        },
        redraft: { from: ['computed'], to: 'draft' },
        approve: {
          from: ['computed'],
          to: 'approved',
          requires: 'payroll.approve',
          guard: records('payroll.run', async (runs) =>
            [...(await runs.load(['slipCount', 'toCompute', 'computedCount', 'computeError']))]
              .filter(
                (r) =>
                  (r.slipCount ?? 0) === 0 ||
                  (r.computedCount ?? 0) < (r.toCompute ?? 0) ||
                  (r.computeError ?? '') !== '',
              )
              .map((r) => r.id),
          ),
          message:
            'Compute the payslips before approving the run — and wait until everybody is computed.',
          // The proof (RFC 0039 §2): a run is approved only if it adds up — everybody it pays has one payslip,
          // every payslip is the sum of its lines, the run's figures are its payslips'. Worked out by the
          // database over every payslip; a run that fails is computed again, not approved.
          before: records('payroll.run', async (runs): Promise<void> => {
            const env = runs.env as unknown as Env;
            await env.asSuperuser({ reason: 'payroll run proof' }, async (su) => {
              for (const id of runs.ids as readonly number[]) {
                const failed = (await checkRun(su, id)).filter((c) => !c.ok);
                if (failed.length > 0)
                  throw new orm.ValidationError(
                    'payroll.run',
                    ['slips'],
                    `The run does not add up. ${failed.map((c) => c.detail).join(' ')}`,
                    'Compute the payslips again, then approve.',
                  );
              }
            });
          }),
          after: records('payroll.run', async (runs) => {
            const env = runs.env as unknown as Env;
            await env.asSuperuser({ reason: 'loan repayments' }, async (su) => {
              await recordRepayments(su, runs.ids as readonly number[]);
              await su.flush();
            });
            await env.flush();
            await env
              .model('payroll.run')
              .browse(runs.ids as never)
              .approvedOut();
            for (const id of runs.ids) await env.emit('payroll.run.approved', { id });
          }),
        },
        pay: {
          from: ['approved'],
          to: 'paid',
          requires: 'payroll.approve',
          after: records('payroll.run', async (runs) => {
            const env = runs.env as unknown as Env;
            await env.flush();
            await env
              .model('payroll.run')
              .browse(runs.ids as never)
              .paidOut();
          }),
        },
        cancel: { from: ['draft', 'computed'], to: 'cancelled' },
      },
      extensible: true,
    }),
  },
  methods: {
    /** After the approval: nothing here; Accounting books the run (`payroll_account`). */
    approvedOut: method('payroll.run', async () => undefined),
    /** After the payment: nothing here; Accounting books it. */
    paidOut: method('payroll.run', async () => undefined),
  },
  sqlConstraints: {
    ordered: { check: orm.sql`date_to >= date_from`, message: 'A run ends on or after it starts.' },
    correction: {
      check: orm.sql`(kind = 'correction') = (correction_of_id IS NOT NULL)`,
      message: 'A correction names the run it corrects; a regular run none.',
    },
  },
});

export const PayrollSlip = defineModel('payroll.slip', {
  label: 'Payslip',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  access: {
    'payroll.user': READ,
    'payroll.officer': [...ALL, 'export'],
    'payroll.manager': [...ALL, 'export'],
  },
  rules: {
    own: {
      groups: ['payroll.user'],
      perms: ['read'],
      // Their own, once the run is approved.
      domain: { 'employee.user': me, 'run.state': { in: ['approved', 'paid'] } },
    },
    officers: { groups: ['payroll.officer'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, label: 'Reference' }),
    run: f.many2one('payroll.run', { required: true, ondelete: 'cascade' }),
    // Indexed: a person's payslips of the year so far, and their own payslips on their page.
    employee: f.many2one('hr.employee', { required: true, ondelete: 'restrict', index: true }),
    contract: f.many2one('hr.contract', { ondelete: 'set null' }),
    structure: f.many2one('payroll.structure', { ondelete: 'set null' }),
    dateFrom: f.date({ required: true, label: 'From' }),
    dateTo: f.date({ required: true, label: 'To' }),
    lines: f.one2many('payroll.slip.line', 'slip'),
    gross: f.decimal({ scale: 2, required: true, default: '0', help: 'Basic and allowances.' }),
    deductions: f.decimal({ scale: 2, required: true, default: '0' }),
    contributions: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Company contributions',
      help: 'Paid by the company on top of the gross (its share of the provident fund…).',
    }),
    net: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      help: 'Gross less deductions: what is paid out.',
    }),
    previousNet: f.decimal({
      scale: 2,
      label: 'Net paid before',
      help: 'A correction: the net of the person’s payslip in the corrected run.',
    }),
    difference: f.decimal({
      scale: 2,
      label: 'To pay now',
      help: 'The net, less what the corrected payslip paid.',
      ...compute('payroll.slip', 'difference', ['net', 'previousNet'], (slips) => {
        for (const s of slips) s.difference = s.net.minus(s.previousNet ?? ZERO);
      }),
      store: true,
    }),
    warnings: f.text({
      help: 'What to check before approving: days not yet approved, a missing contract…',
    }),
  },
  sqlConstraints: {
    onePerRun: { unique: ['run', 'employee'], message: 'One payslip per person in a run.' },
  },
});

export const PayrollSlipLine = defineModel('payroll.slip.line', {
  label: 'Payslip line',
  order: ['sequence asc', 'id asc'],
  access: {
    'payroll.user': READ,
    'payroll.officer': [...ALL, 'export'],
    'payroll.manager': [...ALL, 'export'],
  },
  rules: {
    own: {
      groups: ['payroll.user'],
      perms: ['read'],
      domain: { 'slip.employee.user': me, 'slip.run.state': { in: ['approved', 'paid'] } },
    },
    officers: { groups: ['payroll.officer'], perms: [...ALL], domain: {} },
  },
  fields: {
    // Indexed: a payslip's lines are found by their payslip — reading them, the year so far, the loan
    // instalments on approval, and deleting a run's payslips. Without it a run of thirty thousand people made
    // PostgreSQL scan every line for every payslip (approval: 172 s instead of under a second).
    slip: f.many2one('payroll.slip', { required: true, ondelete: 'cascade', index: true }),
    rule: f.many2one('payroll.rule', { ondelete: 'set null' }),
    sequence: f.integer({ required: true, default: 10 }),
    code: f.char({ size: 40, required: true }),
    name: f.char({ required: true }),
    category: f.selection(CATEGORIES, {
      required: true,
      default: 'allowance',
      help: 'From the rule: whether the amount adds to the gross, comes off it, or is paid by the company on top.',
    }),
    amount: f.decimal({ scale: 2, required: true, default: '0' }),
    explanation: f.char({
      size: 1000,
      help: 'The formula with its values: how the amount came about.',
    }),
    appearsOnSlip: f.boolean({ default: true, label: 'On the payslip' }),
  },
});

const SETTLEMENT_DECIDES =
  'A final settlement is approved by a Payroll manager, never one’s own — and once it is computed.';

/** The settlements among `records` of the acting user's own employee. */
async function ownSettlements(records: unknown): Promise<number[]> {
  const { env, ids } = records as { env: Env; ids: readonly number[] };
  if (env.su) return [];
  return env.asSuperuser({ reason: 'whose settlement' }, async (su) =>
    [
      ...(await su
        .model('payroll.settlement')
        .browse([...ids] as never)
        .load({ employee: { user: true } })),
    ]
      .filter((s) => s.employee.user?.id === env.uid)
      .map((s) => s.id as number),
  );
}

/**
 * The final settlement of a person who leaves (RFC 0039 §6): the last day, why, the notice owed and given; the
 * server works out what they are owed and owe (`settlement.ts`), lines may be added by hand, a Payroll manager
 * approves — never their own —, and the approval makes the settlement's payroll run, repays the loans and ends
 * the contract.
 */
export const PayrollSettlement = defineModel('payroll.settlement', {
  label: 'Final settlement',
  recName: 'name',
  order: ['lastDay desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'lastDay', 'reason', 'noticeDays', 'noticeServed', 'net'],
  access: {
    'payroll.user': READ,
    'payroll.officer': [...ALL, 'export'],
    'payroll.manager': [...ALL, 'export'],
  },
  rules: {
    own: {
      groups: ['payroll.user'],
      perms: ['read'],
      domain: { 'employee.user': me, state: 'approved' },
    },
    officers: { groups: ['payroll.officer'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, sequence: 'payroll.settlement', label: 'Reference' }),
    employee: f.many2one('hr.employee', { required: true, ondelete: 'restrict', index: true }),
    lastDay: f.date({
      required: true,
      label: 'Last day',
      help: 'The last day the person works: they are paid up to it, and the contract ends on it.',
    }),
    reason: f.selection(
      {
        resignation: 'Resignation',
        termination: 'Termination',
        redundancy: 'Redundancy',
        retirement: 'Retirement',
        contract_end: 'End of the contract',
        death: 'Death',
      },
      {
        required: true,
        default: 'resignation',
        label: 'Why',
        help: 'Who owes the notice not given: the person who resigns; the company that terminates or makes redundant. Otherwise nobody.',
      },
    ),
    noticeDays: f.integer({
      required: true,
      default: 0,
      label: 'Notice owed (days)',
      help: 'The notice the contract asks for.',
    }),
    noticeServed: f.integer({
      required: true,
      default: 0,
      label: 'Notice given (days)',
      help: 'The days of notice actually worked, or given by the company.',
    }),
    contract: f.many2one('hr.contract', {
      ondelete: 'set null',
      label: 'Contract',
      groups: { write: [...SYSTEM] },
    }),
    unpaidFrom: f.date({
      label: 'Unpaid from',
      help: 'The day after the person’s last approved payslip: the settlement pays from here to the last day.',
      groups: { write: [...SYSTEM] },
    }),
    lines: f.one2many('payroll.settlement.line', 'settlement'),
    gross: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Owed to the person',
      help: 'The lines that pay: salary of the unpaid days, gratuity, notice, leave, what was added by hand.',
      groups: { write: [...SYSTEM] },
    }),
    deductions: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Owed by the person',
      help: 'The lines that take: notice not served, loans, what was added by hand.',
      groups: { write: [...SYSTEM] },
    }),
    net: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'To pay',
      help: 'Owed to the person less owed by them.',
      groups: { write: [...SYSTEM] },
    }),
    warnings: f.text({
      help: 'What to check before approving: attendance not approved yet, days already paid after the last day…',
      groups: { write: [...SYSTEM] },
    }),
    run: f.many2one('payroll.run', {
      ondelete: 'restrict',
      index: true,
      label: 'Payroll run',
      help: 'Made by the approval: it books the settlement and pays it, like any run.',
      groups: { write: [...SYSTEM] },
    }),
    note: f.text(),
    state: f.state({
      states: {
        draft: 'Draft',
        computed: 'Computed',
        approved: 'Approved',
        cancelled: 'Cancelled',
      },
      initial: 'draft',
      help: 'Computed by the server, checked, approved — which makes its payroll run, repays the loans and ends the contract.',
      transitions: {
        compute: {
          from: ['draft', 'computed'],
          to: 'computed',
          after: records('payroll.settlement', async (settlements) => {
            const env = settlements.env as unknown as Env;
            await env.flush();
            await env.asSuperuser({ reason: 'compute a final settlement' }, async (su) => {
              for (const id of settlements.ids as readonly number[])
                await computeSettlement(su, id);
            });
          }),
        },
        redraft: { from: ['computed'], to: 'draft' },
        approve: emitting('payroll.settlement.approved', {
          from: ['computed'],
          to: 'approved',
          requires: 'payroll.approve',
          guard: records('payroll.settlement', (settlements) => ownSettlements(settlements)),
          message: SETTLEMENT_DECIDES,
          // What is approved is what is true now: a loan repaid or a payslip approved since the computation
          // changes the figures, and the settlement is computed again first.
          before: records('payroll.settlement', async (settlements): Promise<void> => {
            const env = settlements.env as unknown as Env;
            await env.flush();
            await env.asSuperuser({ reason: 'a final settlement checked' }, async (su) => {
              for (const id of settlements.ids as readonly number[]) {
                const model = su.model('payroll.settlement');
                // Kept as text: a record reads what is true now, also after the computation below.
                const [seen] = await model.browse([id] as never).load(['net']);
                const was = seen?.net.toString() ?? '';
                await computeSettlement(su, id);
                const [again] = await model.browse([id] as never).load(['net']);
                const now = again?.net.toString() ?? '';
                if (was === '' || !orm.toDecimal(was).eq(now))
                  throw new orm.ValidationError(
                    'payroll.settlement',
                    ['net'],
                    `The figures changed since the settlement was computed: ${was} then, ${now} now.`,
                    'Compute it again, check it, then approve.',
                  );
              }
            });
          }),
          after: records('payroll.settlement', async (settlements) => {
            const env = settlements.env as unknown as Env;
            await env.flush();
            await env.asSuperuser({ reason: 'a final settlement approved' }, async (su) => {
              for (const id of settlements.ids as readonly number[]) await settle(su, id);
            });
          }),
        }),
        cancel: { from: ['draft', 'computed'], to: 'cancelled' },
      },
    }),
  },
  methods: {
    /** The lines other apps add when a settlement is computed (leave accruals: the days left, paid out). */
    extraLines: method('payroll.settlement', async function (this: unknown): Promise<
      SettlementLineInput[]
    > {
      return [];
    }),
    /** After the approval: nothing here; other apps follow (the leave paid out leaves its ledger). */
    settledOut: method('payroll.settlement', async () => undefined),
  },
  sqlConstraints: {
    notice: {
      check: orm.sql`notice_days >= 0 AND notice_served >= 0`,
      message: 'Days of notice are not negative.',
    },
  },
  constraints: {
    // A person leaves once: one settlement that is not cancelled.
    one: {
      ...check('payroll.settlement', ['employee', 'state'], async (settlements) =>
        settlements.env.asSuperuser({ reason: 'one settlement a person' }, async (su) => {
          const failing: number[] = [];
          for (const s of settlements) {
            if (s.state === 'cancelled') continue;
            const other = await su.model('payroll.settlement').search({
              where: {
                employee: s.employee.id,
                id: { ne: s.id },
                state: { in: ['draft', 'computed', 'approved'] },
              },
              limit: 1,
            });
            if (other.length > 0) failing.push(s.id);
          }
          return failing;
        }),
      ),
      message: 'This person already has a final settlement.',
    },
  },
});

export const PayrollSettlementLine = defineModel('payroll.settlement.line', {
  label: 'Settlement line',
  order: ['sequence asc', 'id asc'],
  access: {
    'payroll.user': READ,
    'payroll.officer': [...ALL, 'export'],
    'payroll.manager': [...ALL, 'export'],
  },
  rules: {
    own: {
      groups: ['payroll.user'],
      perms: ['read'],
      domain: { 'settlement.employee.user': me, 'settlement.state': 'approved' },
    },
    // Lines are added and changed until the settlement is approved.
    officers: {
      groups: ['payroll.officer'],
      perms: ['write', 'create', 'unlink'],
      domain: { 'settlement.state': { in: ['draft', 'computed'] } },
    },
    officersRead: { groups: ['payroll.officer'], perms: ['read'], domain: {} },
  },
  fields: {
    settlement: f.many2one('payroll.settlement', {
      required: true,
      ondelete: 'cascade',
      index: true,
    }),
    sequence: f.integer({ required: true, default: 50 }),
    code: f.char({ size: 40, required: true, default: 'OTHER' }),
    name: f.char({ required: true }),
    category: f.selection(
      { basic: 'Salary', allowance: 'Owed to the person', deduction: 'Owed by the person' },
      {
        required: true,
        default: 'allowance',
        help: 'Whether the amount is paid to the person or taken from what they are paid.',
      },
    ),
    amount: f.decimal({ scale: 2, required: true, default: '0' }),
    quantity: f.decimal({
      scale: 2,
      label: 'For',
      help: 'What the amount is for, in its own unit: days of salary, of notice, of leave paid out.',
    }),
    explanation: f.char({
      size: 1000,
      help: 'The formula with its values: how the amount came about.',
    }),
    manual: f.boolean({
      default: true,
      label: 'Added by hand',
      help: 'Lines added by hand are kept when the settlement is computed again; the server’s are replaced.',
      groups: { write: [...SYSTEM] },
    }),
  },
  sqlConstraints: {
    code: { check: orm.sql`code ${CODE}`, message: 'A code is written in capitals, digits and _.' },
    positive: {
      check: orm.sql`amount >= 0`,
      message: 'An amount is not negative: what is taken from the person is a line owed by them.',
    },
  },
});

/** The structure a contract is paid by. */
export const ContractStructure = extendModel('hr.contract', {
  fields: {
    structure: f.many2one('payroll.structure', {
      ondelete: 'restrict',
      label: 'Salary structure',
      help: 'The rules this contract is paid by; without one, the person is left out of payroll runs.',
    }),
  },
});

/** How each employee is paid: bank transfer, mobile wallet or cash. Payroll officers only. */
export const EmployeePay = extendModel('hr.employee', {
  fields: {
    payMethod: f.selection(
      { bank: 'Bank transfer', wallet: 'Mobile wallet', cash: 'Cash' },
      {
        default: 'bank',
        label: 'Paid by',
        help: 'Which payment file the person’s net pay goes into.',
        groups: { read: OFFICERS, write: OFFICERS },
      },
    ),
    bankName: f.char({ label: 'Bank', groups: { read: OFFICERS, write: OFFICERS } }),
    bankBranch: f.char({ label: 'Branch', groups: { read: OFFICERS, write: OFFICERS } }),
    bankAccount: f.char({ label: 'Account number', groups: { read: OFFICERS, write: OFFICERS } }),
    routingNumber: f.char({ label: 'Routing number', groups: { read: OFFICERS, write: OFFICERS } }),
    walletProvider: f.selection(
      { bkash: 'bKash', nagad: 'Nagad', rocket: 'Rocket' },
      { label: 'Wallet', groups: { read: OFFICERS, write: OFFICERS } },
    ),
    walletNumber: f.char({ label: 'Wallet number', groups: { read: OFFICERS, write: OFFICERS } }),
  },
});

export const payrollShutro = defineModule({
  name: 'payroll',
  version: '0.1.0',
  depends: [hrShutro, attendanceShutro],
  groups: [
    orm.defineGroup({ code: 'payroll.user', label: 'Payroll: own payslips', implies: ['hr.user'] }),
    orm.defineGroup({
      code: 'payroll.officer',
      label: 'Payroll officer (prepares runs)',
      implies: ['payroll.user'],
    }),
    orm.defineGroup({
      code: 'payroll.manager',
      label: 'Payroll manager (approves runs)',
      implies: ['payroll.officer'],
    }),
  ],
  permissions: [
    orm.definePermission({
      code: 'payroll.approve',
      label: 'Approve and pay payroll runs, start loans',
      groups: ['payroll.manager'],
    }),
  ],
  sequences: [
    orm.defineSequence({ code: 'payroll.run', prefix: 'PAY/{year}/', padding: 4, reset: 'yearly' }),
    orm.defineSequence({
      code: 'payroll.settlement',
      prefix: 'FS/{year}/',
      padding: 4,
      reset: 'yearly',
    }),
    orm.defineSequence({
      code: 'payroll.loan',
      prefix: 'LOAN/{year}/',
      padding: 4,
      reset: 'yearly',
    }),
  ],
  models: [
    PayrollStructure,
    PayrollRule,
    PayrollParameter,
    PayrollSlab,
    PayrollSlabBand,
    PayrollEmployeeValue,
    PayrollInput,
    PayrollLoan,
    PayrollLoanRepayment,
    PayrollRun,
    PayrollSlip,
    PayrollSlipLine,
    PayrollSettlement,
    PayrollSettlementLine,
  ],
  extensions: [ContractStructure, EmployeePay],
});
