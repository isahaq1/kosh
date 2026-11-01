/**
 * The data layer of Spend (RFC 0024 §2.1): expense categories with their **policy** (a limit per expense and per
 * month, a receipt above an amount, a rate per day or per kilometre), expenses with their receipts, expense reports
 * submitted together and decided through the approval engine, and **cash advances** that later reports settle.
 *
 * The server enforces the policy when a report is submitted: a missing receipt refuses it; an expense over a limit
 * needs a reason and brings a further approval level (`overPolicy`); likely duplicates (the same amount, date and
 * category, or the same receipt file) are flagged for the approvers. People file their own expenses; approvers see
 * every report of their companies; Spend managers everything.
 */
import { hrShutro } from '@kosh/hr';
import { approvalGuard, permissionsShutro, requestApprovals } from '@kosh/permissions';
import { productShutro } from '@kosh/product';
import { type Decimal, orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  method,
  onchange,
  record,
  records,
} from './.kosh/bindings.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const me = { $env: 'uid' } as const;
const ZERO: Decimal = orm.toDecimal(0);

export const ExpenseCategory = defineModel('expense.category', {
  label: 'Expense category',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  access: { 'expense.user': READ, 'expense.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    kind: f.selection(
      { amount: 'An amount', per_diem: 'Per day', mileage: 'Per kilometre' },
      {
        required: true,
        default: 'amount',
        label: 'Claimed as',
        help: 'An amount as on the receipt, or a quantity of days or kilometres at the category’s rate.',
      },
    ),
    rate: f.decimal({ scale: 2, label: 'Rate', help: 'Per day or per kilometre.' }),
    limitPerExpense: f.decimal({
      scale: 2,
      label: 'Limit per expense',
      help: 'An expense above it needs a reason and a further approval.',
    }),
    limitPerMonth: f.decimal({
      scale: 2,
      label: 'Limit per person per month',
      help: 'A person’s expenses of this category in a month, together.',
    }),
    receiptAbove: f.decimal({
      scale: 2,
      label: 'Receipt required above',
      help: 'Empty: always; 0 or more: a receipt is attached to expenses above this amount.',
    }),
    tax: f.many2one('account.tax', {
      ondelete: 'set null',
      label: 'Tax included',
      help: 'The purchase tax included in the amounts of this category.',
    }),
    note: f.text({ label: 'Guidance', translate: true }),
  },
  sqlConstraints: {
    ratedHasRate: {
      check: orm.sql`kind = 'amount' OR (rate IS NOT NULL AND rate > 0)`,
      message: 'A category per day or per kilometre has a rate.',
    },
  },
});

/** The employee of the acting user, if they have one. */
async function ownEmployee(env: Env): Promise<number | null> {
  const found = await env.model('hr.employee').search({ where: { user: env.userId }, limit: 1 });
  return found.ids[0] ?? null;
}

/** Fills an empty employee with the user's own, and a rated category's amount from its quantity. */
async function fillExpense(
  d: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    record(key: string): Promise<unknown>;
  },
  env: Env,
): Promise<void> {
  if ((d.get('employee') ?? null) === null) {
    const mine = await ownEmployee(env);
    if (mine !== null) d.set('employee', mine);
  }
  const category = (await d.record('category')) as {
    kind: string;
    rate: Decimal | null;
    tax: { id: number } | null;
  } | null;
  if (category === null) return;
  if ((d.get('tax') ?? null) === null && category.tax !== null) d.set('tax', category.tax.id);
  if (category.kind !== 'amount' && category.rate !== null) {
    const quantity = orm.toDecimal(String(d.get('quantity') ?? '1'));
    d.set('amount', category.rate.times(quantity).toDecimalPlaces(2).toString());
  }
}

export const ExpenseExpense = defineModel('expense.expense', {
  label: 'Expense',
  order: ['date desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['amount', 'category', 'sheet'],
  access: {
    'expense.user': ALL,
    'expense.approver': ALL,
    'expense.manager': [...ALL, 'export', 'import'],
  },
  rules: {
    // One's own expenses; changed while not yet submitted.
    seeOwn: { groups: ['expense.user'], perms: ['read'], domain: { 'employee.user': me } },
    draftOwn: {
      groups: ['expense.user'],
      perms: ['write', 'create', 'unlink'],
      domain: {
        'employee.user': me,
        or: [{ sheet: { isNull: true } }, { 'sheet.state': { in: ['draft', 'refused'] } }],
      },
    },
    approvers: { groups: ['expense.approver'], perms: ['read'], domain: {} },
    all: { groups: ['expense.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, label: 'Description' }),
    employee: f.many2one('hr.employee', { required: true, ondelete: 'restrict' }),
    date: f.date({ required: true, label: 'Spent on' }),
    category: f.many2one('expense.category', { required: true, ondelete: 'restrict' }),
    quantity: f.decimal({
      scale: 2,
      required: true,
      default: '1',
      help: 'Days or kilometres for a category claimed per day or per kilometre; 1 otherwise.',
    }),
    amount: f.decimal({ scale: 2, required: true, label: 'Amount (tax included)' }),
    tax: f.many2one('account.tax', { ondelete: 'set null', label: 'Tax included' }),
    taxAmount: f.decimal({
      scale: 2,
      label: 'Of which tax',
      help: 'The tax included in the amount, from the tax’s rate.',
      ...compute(
        'expense.expense',
        'taxAmount',
        ['amount', 'quantity', 'tax.amountType', 'tax.rate', 'tax.fixedAmount'],
        (expenses) => {
          for (const e of expenses) {
            const t = e.tax;
            if (t === null) e.taxAmount = ZERO;
            else if (t.amountType === 'percent')
              e.taxAmount = e.amount
                .times(t.rate)
                .div(orm.toDecimal(100).plus(t.rate))
                .toDecimalPlaces(2);
            else e.taxAmount = t.fixedAmount.times(e.quantity).toDecimalPlaces(2);
          }
        },
      ),
      store: true,
    }),
    vendor: f.many2one('res.partner', { ondelete: 'set null', label: 'Paid to' }),
    reference: f.char({ label: 'Receipt number' }),
    paidBy: f.selection(
      { employee: 'The employee (to reimburse)', company: 'The company (company card)' },
      {
        required: true,
        default: 'employee',
        label: 'Paid by',
        help: 'Expenses paid by the employee are reimbursed; company-card expenses only booked.',
      },
    ),
    sheet: f.many2one('expense.sheet', { ondelete: 'set null', label: 'Report' }),
    /** Why the expense goes beyond its category's policy (required then, at submission). */
    policyReason: f.char({ size: 300, label: 'Reason beyond the policy' }),
    overPolicy: f.boolean({
      default: false,
      label: 'Beyond the policy',
      help: 'Set when the report is submitted: above a limit of its category.',
    }),
    duplicate: f.boolean({
      default: false,
      label: 'Possible duplicate',
      help: 'Set when the report is submitted: the same amount, date and category, or the same receipt file, as another expense.',
    }),
    status: f.selection(
      {
        draft: 'Not reported',
        reported: 'In a draft report',
        submitted: 'Waiting for approval',
        approved: 'Approved',
        refused: 'Refused',
        done: 'Done',
        posted: 'Booked',
        paid: 'Reimbursed',
      },
      {
        label: 'Status',
        help: 'Follows the report the expense is in.',
        ...compute('expense.expense', 'status', ['sheet', 'sheet.state'], (expenses) => {
          for (const e of expenses) {
            const s = e.sheet?.state ?? null;
            e.status =
              s === null
                ? 'draft'
                : s === 'draft'
                  ? 'reported'
                  : s === 'to_approve'
                    ? 'submitted'
                    : (s as typeof e.status);
          }
        }),
        store: true,
      },
    ),
  },
  sqlConstraints: {
    positive: {
      check: orm.sql`amount > 0 AND quantity > 0`,
      message: 'Amounts and quantities are positive.',
    },
  },
  constraints: {
    // A category claimed per day or kilometre: the amount is its rate times the quantity.
    rated: {
      ...check('expense.expense', ['category', 'quantity', 'amount'], async (expenses) =>
        [...(await expenses.load({ category: true }))]
          .filter(
            (e) =>
              e.category.kind !== 'amount' &&
              e.category.rate !== null &&
              !e.category.rate.times(e.quantity).toDecimalPlaces(2).eq(e.amount),
          )
          .map((e) => e.id),
      ),
      message: 'The amount is the category’s rate times the days or kilometres.',
    },
    sameEmployee: {
      ...check('expense.expense', ['sheet', 'employee'], async (expenses) =>
        [...(await expenses.load({ sheet: true }))]
          .filter((e) => e.sheet !== null && e.sheet.employee.id !== e.employee.id)
          .map((e) => e.id),
      ),
      message: 'A report holds the expenses of its own employee.',
    },
  },
  onchange: {
    name: onchange(
      'expense.expense',
      async (d, env): Promise<void> => fillExpense(d as never, env),
    ),
    category: onchange(
      'expense.expense',
      async (d, env): Promise<void> => fillExpense(d as never, env),
    ),
    quantity: onchange(
      'expense.expense',
      async (d, env): Promise<void> => fillExpense(d as never, env),
    ),
  },
});

/**
 * The policy at submission: receipts where required (refused otherwise), limits (a reason then, and the flag that
 * brings the further approval), and likely duplicates (flagged). Writes the flags and the advance used.
 */
async function checkPolicy(sheets: unknown): Promise<void> {
  const { env, ids } = sheets as { env: Env; ids: readonly number[] };
  await env.asSuperuser({ reason: 'expense policy' }, async (su) => {
    for (const sheet of await su
      .model('expense.sheet')
      .browse([...ids])
      .load({
        expenses: { category: true },
        advance: true,
      })) {
      let over = false;
      for (const e of sheet.expenses) {
        const c = e.category;
        // A receipt: an attachment of the expense, when the category asks for one at this amount.
        const attachments = await su.model('storage.attachment').search({
          where: { resModel: 'expense.expense', resId: e.id, variantOf: { isNull: true } },
        });
        const needsReceipt = c.receiptAbove === null || e.amount.gt(c.receiptAbove);
        if (needsReceipt && c.kind === 'amount' && attachments.length === 0)
          throw new orm.ValidationError(
            'expense.sheet',
            ['expenses'],
            `${e.name}: attach the receipt (${c.name} needs one${c.receiptAbove === null ? '' : ` above ${c.receiptAbove.toString()}`}).`,
            'Open the expense and attach a photo or a PDF of the receipt.',
          );
        // The limits: per expense, and per person and month with the category's other expenses.
        let beyond = c.limitPerExpense !== null && e.amount.gt(c.limitPerExpense);
        if (!beyond && c.limitPerMonth !== null) {
          const date = isoDate(e.date);
          const month = date.slice(0, 7);
          const others = await (
            await su.model('expense.expense').search({
              where: {
                employee: e.employee.id,
                category: c.id,
                id: { ne: e.id },
                status: { notIn: ['refused', 'draft'] },
                date: { gte: `${month}-01`, lte: `${month}-31` },
              },
            })
          ).load(['amount']);
          const total = [...others].reduce((s, x) => s.plus(x.amount), e.amount);
          beyond = total.gt(c.limitPerMonth);
        }
        if (beyond && (e.policyReason === null || e.policyReason.trim() === ''))
          throw new orm.ValidationError(
            'expense.sheet',
            ['expenses'],
            `${e.name}: beyond the ${c.name} policy — say why.`,
            'Write the reason on the expense; a Spend manager approves it as well.',
          );
        over ||= beyond;
        // Likely duplicates: the same amount, date and category, or the same receipt file.
        const twins = await su.model('expense.expense').search({
          where: {
            id: { ne: e.id },
            employee: e.employee.id,
            category: c.id,
            amount: e.amount,
            date: e.date,
            status: { ne: 'refused' },
          },
          limit: 1,
        });
        let duplicate = twins.length > 0;
        if (!duplicate && attachments.length > 0) {
          const hashes = [...(await attachments.load(['sha256']))].map((a) => a.sha256);
          const same = await su.model('storage.attachment').search({
            where: {
              resModel: 'expense.expense',
              resId: { ne: e.id },
              sha256: { in: hashes },
            },
            limit: 1,
          });
          duplicate = same.length > 0;
        }
        await su.model('expense.expense').browse([e.id]).write({ overPolicy: beyond, duplicate });
      }
      // The advance this report settles: what is left of it, up to the report's total.
      let used = ZERO;
      if (sheet.advance !== null) {
        const left = await advanceLeft(su, sheet.advance.id, sheet.id);
        used = left.lt(sheet.total ?? ZERO) ? left : (sheet.total ?? ZERO);
        if (used.lt(0)) used = ZERO;
      }
      await su
        .model('expense.sheet')
        .browse([sheet.id])
        .write({ overPolicy: over, advanceUsed: used });
    }
    await su.flush();
  });
}

/** What is left of an advance, other reports' use deducted (refused and draft reports aside). */
export async function advanceLeft(env: Env, advance: number, except?: number): Promise<Decimal> {
  const [a] = await env
    .model('expense.advance')
    .browse([advance as never])
    .load(['amount']);
  if (a === undefined) return ZERO;
  const users = await (
    await env.model('expense.sheet').search({
      where: {
        advance: advance as never,
        state: { notIn: ['draft', 'refused'] },
        ...(except === undefined ? {} : { id: { ne: except as never } }),
      },
    })
  ).load(['advanceUsed']);
  return [...users].reduce((s, x) => s.minus(x.advanceUsed), a.amount);
}

/** A date-only value as `YYYY-MM-DD` (PostgreSQL dates read as local midnights). */
export function isoDate(v: unknown): string {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

const SHEET_STATES = {
  draft: 'Draft',
  to_approve: 'Waiting for approval',
  approved: 'Approved',
  done: 'Done',
  refused: 'Refused',
} as const;

export const ExpenseSheet = defineModel('expense.sheet', {
  label: 'Expense report',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'total', 'advance'],
  access: {
    'expense.user': ALL,
    'expense.approver': ALL,
    'expense.manager': [...ALL, 'export', 'import'],
  },
  rules: {
    seeOwn: { groups: ['expense.user'], perms: ['read'], domain: { 'employee.user': me } },
    draftOwn: {
      groups: ['expense.user'],
      perms: ['write', 'create', 'unlink'],
      domain: { 'employee.user': me, state: { in: ['draft', 'refused'] } },
    },
    approvers: { groups: ['expense.approver'], perms: ['read'], domain: {} },
    all: { groups: ['expense.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, sequence: 'expense.sheet', label: 'Reference' }),
    title: f.char({ label: 'Purpose' }),
    employee: f.many2one('hr.employee', { required: true, ondelete: 'restrict' }),
    expenses: f.one2many('expense.expense', 'sheet'),
    expenseCount: f.integer({
      label: 'Expenses',
      ...compute('expense.sheet', 'expenseCount', ['expenses'], (sheets) => {
        for (const s of sheets) s.expenseCount = s.expenses.length;
      }),
    }),
    total: f.decimal({
      scale: 2,
      label: 'Total',
      help: 'The expenses of the report, tax included.',
      ...compute('expense.sheet', 'total', ['expenses.amount'], (sheets) => {
        for (const s of sheets) s.total = [...s.expenses].reduce((t, e) => t.plus(e.amount), ZERO);
      }),
      store: true,
    }),
    toReimburse: f.decimal({
      scale: 2,
      label: 'To reimburse',
      help: 'Paid by the employee, less what an advance already covered.',
      ...compute(
        'expense.sheet',
        'toReimburse',
        ['expenses.amount', 'expenses.paidBy', 'advanceUsed'],
        (sheets) => {
          for (const s of sheets) {
            const own = [...s.expenses]
              .filter((e) => e.paidBy === 'employee')
              .reduce((t, e) => t.plus(e.amount), ZERO);
            const left = own.minus(s.advanceUsed);
            s.toReimburse = left.gt(0) ? left : ZERO;
          }
        },
      ),
      store: true,
    }),
    advance: f.many2one('expense.advance', {
      ondelete: 'restrict',
      label: 'Settles advance',
      help: 'A cash advance paid to the employee that this report’s expenses settle.',
    }),
    advanceUsed: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'From the advance',
      help: 'Set when the report is submitted: what the advance covers.',
    }),
    overPolicy: f.boolean({
      default: false,
      label: 'Beyond the policy',
      help: 'An expense of the report goes beyond its category’s policy: a Spend manager approves it too.',
    }),
    state: f.state({
      states: SHEET_STATES,
      initial: 'draft',
      help: 'Draft, then submitted for approval; approved reports are booked and reimbursed (or settled outside the books).',
      transitions: {
        submit: {
          from: ['draft', 'refused'],
          to: 'to_approve',
          guard: records('expense.sheet', async (sheets) =>
            [...(await sheets.load({ expenses: true }))]
              .filter((s) => s.expenses.length === 0)
              .map((s) => s.id),
          ),
          message: 'Add the expenses to the report before submitting it.',
          before: records('expense.sheet', (sheets) => checkPolicy(sheets)),
          after: records('expense.sheet', async (sheets) => {
            await requestApprovals(sheets);
            for (const s of await sheets.load({}))
              await sheets.env.emit('expense.sheet.submitted', { id: s.id });
          }),
        },
        approve: {
          from: ['to_approve'],
          to: 'approved',
          guard: records('expense.sheet', (sheets) => approvalGuard(sheets)),
          message: 'Waiting for approvals.',
          after: records('expense.sheet', async (sheets) => {
            for (const s of await sheets.load({}))
              await sheets.env.emit('expense.sheet.approved', { id: s.id });
          }),
        },
        refuse: { from: ['to_approve'], to: 'refused' },
        /** Settled outside the books (no accounting, or paid by other means). */
        reimbursed: { from: ['approved'], to: 'done', requires: 'expense.settle' },
        redraft: { from: ['refused'], to: 'draft' },
      },
      extensible: true, // expense_account books and reimburses
    }),
  },
  constraints: {
    // The advance is one of the employee's, paid, with something left.
    advanceOfTheEmployee: {
      ...check('expense.sheet', ['advance', 'employee'], async (sheets) =>
        [...(await sheets.load({ advance: true }))]
          .filter(
            (s) =>
              s.advance !== null &&
              (s.advance.employee.id !== s.employee.id ||
                !['paid', 'settled'].includes(s.advance.state)),
          )
          .map((s) => s.id),
      ),
      message: 'A report settles a paid advance of its own employee.',
    },
  },
  onchange: {
    title: onchange('expense.sheet', async (d, env) => {
      const draft = d as unknown as { get(k: string): unknown; set(k: string, v: unknown): void };
      if ((draft.get('employee') ?? null) === null) {
        const mine = await ownEmployee(env);
        if (mine !== null) draft.set('employee', mine);
      }
    }),
  },
});

export const ExpenseAdvance = defineModel('expense.advance', {
  label: 'Cash advance',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'amount'],
  access: {
    'expense.user': ALL,
    'expense.approver': ALL,
    'expense.manager': [...ALL, 'export', 'import'],
  },
  rules: {
    seeOwn: { groups: ['expense.user'], perms: ['read'], domain: { 'employee.user': me } },
    draftOwn: {
      groups: ['expense.user'],
      perms: ['write', 'create', 'unlink'],
      domain: { 'employee.user': me, state: { in: ['draft', 'refused'] } },
    },
    approvers: { groups: ['expense.approver'], perms: ['read'], domain: {} },
    all: { groups: ['expense.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, sequence: 'expense.advance', label: 'Reference' }),
    employee: f.many2one('hr.employee', { required: true, ondelete: 'restrict' }),
    purpose: f.char({ required: true }),
    date: f.date({ required: true, label: 'Needed on' }),
    amount: f.decimal({ scale: 2, required: true }),
    sheets: f.one2many('expense.sheet', 'advance', { label: 'Settling reports' }),
    settled: f.decimal({
      scale: 2,
      label: 'Settled',
      help: 'Covered by the expenses of submitted and approved reports.',
      ...compute(
        'expense.advance',
        'settled',
        ['sheets.advanceUsed', 'sheets.state'],
        (advances) => {
          for (const a of advances)
            a.settled = [...a.sheets]
              .filter((s) => s.state !== 'draft' && s.state !== 'refused')
              .reduce((t, s) => t.plus(s.advanceUsed), ZERO);
        },
      ),
      store: true,
    }),
    balance: f.decimal({
      scale: 2,
      label: 'Left to settle',
      help: 'The advance less what reports settled: returned by the employee when nothing more is spent.',
      ...compute('expense.advance', 'balance', ['amount', 'settled'], (advances) => {
        for (const a of advances) a.balance = a.amount.minus(a.settled ?? ZERO);
      }),
      store: true,
    }),
    state: f.state({
      states: {
        draft: 'Draft',
        to_approve: 'Waiting for approval',
        approved: 'Approved',
        paid: 'Paid out',
        settled: 'Settled',
        refused: 'Refused',
      },
      initial: 'draft',
      help: 'Requested, approved, paid out, then settled by expense reports and the rest returned.',
      transitions: {
        submit: {
          from: ['draft', 'refused'],
          to: 'to_approve',
          after: records('expense.advance', async (advances) => {
            await requestApprovals(advances);
            for (const a of await advances.load({}))
              await advances.env.emit('expense.advance.submitted', { id: a.id });
          }),
        },
        approve: {
          from: ['to_approve'],
          to: 'approved',
          guard: records('expense.advance', (advances) => approvalGuard(advances)),
          message: 'Waiting for approvals.',
        },
        refuse: { from: ['to_approve'], to: 'refused' },
        pay: {
          from: ['approved'],
          to: 'paid',
          requires: 'expense.settle',
          // Accounting books the payout (expense_account overrides `paidOut`).
          after: records('expense.advance', async (advances) => {
            const env = advances.env as unknown as Env;
            await env.flush();
            await env.model('expense.advance').browse(advances.ids).paidOut();
            for (const id of advances.ids) await env.emit('expense.advance.paid', { id });
          }),
        },
        /** Spent in full by reports, or the rest returned. */
        settle: {
          from: ['paid'],
          to: 'settled',
          requires: 'expense.settle',
          after: records('expense.advance', async (advances) => {
            const env = advances.env as unknown as Env;
            await env.flush();
            await env.model('expense.advance').browse(advances.ids).settledOut();
          }),
        },
        redraft: { from: ['refused'], to: 'draft' },
      },
      extensible: true,
    }),
  },
  sqlConstraints: {
    positive: { check: orm.sql`amount > 0`, message: 'An advance is a positive amount.' },
  },
  methods: {
    /** After the payout: nothing here; Accounting books it. */
    paidOut: method('expense.advance', async () => undefined),
    /** After the settlement: nothing here; Accounting books the cash returned. */
    settledOut: method('expense.advance', async () => undefined),
  },
});

export const expenseShutro = defineModule({
  name: 'expense',
  version: '0.1.0',
  depends: [hrShutro, productShutro, permissionsShutro],
  groups: [
    orm.defineGroup({
      code: 'expense.user',
      label: 'Spend: own expenses',
      // Receipts are attachments.
      implies: ['hr.user', 'storage.user'],
    }),
    orm.defineGroup({
      code: 'expense.approver',
      label: 'Spend: approver',
      implies: ['expense.user'],
    }),
    orm.defineGroup({
      code: 'expense.manager',
      label: 'Spend manager',
      implies: ['expense.approver', 'product.user'],
    }),
  ],
  permissions: [
    orm.definePermission({
      code: 'expense.settle',
      label: 'Pay out advances and settle reports',
      groups: ['expense.manager'],
    }),
  ],
  sequences: [
    orm.defineSequence({
      code: 'expense.sheet',
      prefix: 'EXP/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
    orm.defineSequence({
      code: 'expense.advance',
      prefix: 'ADV/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
  ],
  models: [ExpenseCategory, ExpenseExpense, ExpenseSheet, ExpenseAdvance],
  data: [
    record(
      'expense.category',
      'category_travel',
      { name: 'Travel', kind: 'amount', receiptAbove: '500' },
      { noupdate: true },
    ),
    record(
      'expense.category',
      'category_meals',
      {
        name: 'Meals',
        kind: 'amount',
        limitPerExpense: '1500',
        limitPerMonth: '6000',
        receiptAbove: '300',
      },
      { noupdate: true },
    ),
    record(
      'expense.category',
      'category_per_diem',
      { name: 'Daily allowance', kind: 'per_diem', rate: '800' },
      { noupdate: true },
    ),
    record(
      'expense.category',
      'category_mileage',
      { name: 'Own vehicle', kind: 'mileage', rate: '25' },
      { noupdate: true },
    ),
    record(
      'expense.category',
      'category_office',
      { name: 'Office supplies', kind: 'amount' },
      { noupdate: true },
    ),
  ],
});
