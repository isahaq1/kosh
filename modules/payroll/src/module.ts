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
  computeBatch,
  INLINE_LIMIT,
  recordRepayments,
  refreshTotals,
  startRun,
} from './compute.js';
import { FormulaError, parse } from './formula.js';

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
      { regular: 'Regular', correction: 'Correction' },
      {
        required: true,
        default: 'regular',
        help: 'A correction pays the difference to an approved run of the same period, which stays as it was.',
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
              for (const id of runs.ids as readonly number[]) {
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
    employee: f.many2one('hr.employee', { required: true, ondelete: 'restrict' }),
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
    slip: f.many2one('payroll.slip', { required: true, ondelete: 'cascade' }),
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
  ],
  extensions: [ContractStructure, EmployeePay],
});
