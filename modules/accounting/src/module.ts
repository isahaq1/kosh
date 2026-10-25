/**
 * The data layer of Accounting (RFC 0009), step 1: the ledger core. Accounts typed for the reports, journals,
 * fiscal years with lock dates, currency rates, and journal entries (`account.move`) whose lines carry debit and
 * credit in the company currency as exact money, with the document-currency amount beside them. Posting checks
 * the lock dates, balances the entry to the paisa, converts foreign-currency lines at the entry's rate, takes the
 * number from the journal type's sequence (gapless, yearly) and freezes the entry: a posted entry is never edited
 * or deleted, only reversed. Everything is per company.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { productShutro } from '@kosh/product';
import { orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  records,
} from './.kosh/bindings.js';

const READ = ['read'] as const;
const WRITE = ['read', 'write', 'create'] as const;
const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

/** Account types: the reports (P&L, balance sheet, aging) group accounts by them. */
export const ACCOUNT_TYPES = {
  asset_receivable: 'Receivable',
  asset_cash: 'Bank and cash',
  asset_current: 'Current assets',
  asset_prepayments: 'Prepayments',
  asset_fixed: 'Fixed assets',
  asset_non_current: 'Non-current assets',
  liability_payable: 'Payable',
  liability_current: 'Current liabilities',
  liability_non_current: 'Non-current liabilities',
  equity: 'Equity',
  equity_unaffected: 'Current year earnings',
  income: 'Income',
  income_other: 'Other income',
  expense: 'Expenses',
  expense_direct_cost: 'Cost of revenue',
  expense_depreciation: 'Depreciation',
  off_balance: 'Off-balance sheet',
} as const;
export type AccountType = keyof typeof ACCOUNT_TYPES;

export const JOURNAL_TYPES = {
  sale: 'Sales',
  purchase: 'Purchases',
  cash: 'Cash',
  bank: 'Bank',
  general: 'Miscellaneous',
} as const;
export type JournalType = keyof typeof JOURNAL_TYPES;

export const MOVE_KINDS = {
  entry: 'Journal entry',
  out_invoice: 'Customer invoice',
  out_refund: 'Customer credit note',
  in_invoice: 'Vendor bill',
  in_refund: 'Vendor credit note',
} as const;
export type MoveKind = keyof typeof MOVE_KINDS;

/** The kind of the entry that reverses one of each kind. */
export const REVERSED_KIND: Readonly<Record<MoveKind, MoveKind>> = {
  entry: 'entry',
  out_invoice: 'out_refund',
  out_refund: 'out_invoice',
  in_invoice: 'in_refund',
  in_refund: 'in_invoice',
};

/**
 * The sequence field numbering each journal type (Shutro numbers one field per sequence code, and a sequence's
 * prefix cannot read the journal: docs/shutro-requests.md #22). One journal per type per company is numbered in
 * version 1.
 */
export const NUMBER_FIELD: Readonly<
  Record<
    JournalType,
    'numberSale' | 'numberPurchase' | 'numberCash' | 'numberBank' | 'numberGeneral'
  >
> = {
  sale: 'numberSale',
  purchase: 'numberPurchase',
  cash: 'numberCash',
  bank: 'numberBank',
  general: 'numberGeneral',
};

/** Rates per currency and date: units of the currency per one unit of the company currency (shared or per company). */
export const ResCurrencyRate = defineModel('res.currency.rate', {
  label: 'Currency rate',
  order: ['date desc', 'id desc'],
  access: { 'account.invoicing': READ, 'account.user': READ, 'account.manager': ALL },
  fields: {
    currency: f.many2one('res.currency', { required: true, ondelete: 'cascade' }),
    company: f.many2one('res.company', {
      ondelete: 'cascade',
      help: 'Empty: shared by every company.',
    }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    /** Units of the currency for one unit of the company currency (0.0085 USD per BDT). */
    rate: f.decimal({ scale: 12, required: true }),
  },
  sqlConstraints: {
    ratePositive: { check: orm.sql`rate > 0`, message: 'A rate is positive.' },
    oneRatePerDay: {
      unique: ['currency', 'company', 'date'],
      message: 'One rate per currency, company and day.',
    },
  },
});

export const AccountAccount = defineModel('account.account', {
  label: 'Account',
  order: ['code asc'],
  recName: 'name',
  archivable: true,
  companyScoped: { required: true },
  access: { 'account.invoicing': READ, 'account.user': READ, 'account.manager': ALL },
  fields: {
    code: f.char({ required: true, size: 32, index: true }),
    name: f.char({ required: true, translate: true }),
    type: f.selection(ACCOUNT_TYPES, { required: true }),
    /** Lines on this account are matched against each other (receivables, payables, suspense). */
    reconcile: f.boolean({ default: false, label: 'Allow reconciliation' }),
    currency: f.many2one('res.currency', { label: 'Account currency' }),
    note: f.text(),
  },
  sqlConstraints: {
    codeUnique: {
      unique: ['company', 'code'],
      message: 'An account code is used once per company.',
    },
  },
});

export const AccountJournal = defineModel('account.journal', {
  label: 'Journal',
  order: ['type asc', 'code asc'],
  archivable: true,
  companyScoped: { required: true },
  access: { 'account.invoicing': READ, 'account.user': READ, 'account.manager': ALL },
  fields: {
    code: f.char({ required: true, size: 8 }),
    name: f.char({ required: true, translate: true }),
    type: f.selection(JOURNAL_TYPES, { required: true, default: 'general' }),
    /** Cash and bank journals: the account of the money; sales and purchases: the default income / expense. */
    defaultAccount: f.many2one('account.account', { checkCompany: true, label: 'Default account' }),
  },
  sqlConstraints: {
    codeUnique: {
      unique: ['company', 'code'],
      message: 'A journal code is used once per company.',
    },
  },
});

export const AccountFiscalYear = defineModel('account.fiscal.year', {
  label: 'Fiscal year',
  order: ['dateFrom desc'],
  companyScoped: { required: true },
  access: { 'account.invoicing': READ, 'account.user': READ, 'account.manager': ALL },
  fields: {
    name: f.char({ required: true }),
    dateFrom: f.date({ required: true, label: 'From' }),
    dateTo: f.date({ required: true, label: 'To' }),
    state: f.selection({ open: 'Open', closed: 'Closed' }, { required: true, default: 'open' }),
    /** Set when the year closes: nothing is posted on or before it. */
    lockDate: f.date({ label: 'Lock date' }),
  },
  sqlConstraints: {
    datesOrdered: {
      check: orm.sql`date_to > date_from`,
      message: 'A fiscal year ends after it starts.',
    },
  },
  constraints: {
    noOverlap: {
      ...check('account.fiscal.year', ['dateFrom', 'dateTo', 'company'], async (years) => {
        const failing: number[] = [];
        for (const y of years) {
          const others = await years.env.model('account.fiscal.year').search({
            where: {
              company: y.company.id,
              id: { ne: y.id },
              dateFrom: { lte: y.dateTo },
              dateTo: { gte: y.dateFrom },
            },
            limit: 1,
          });
          if (others.length > 0) failing.push(y.id);
        }
        return failing;
      }),
      message: 'Fiscal years of a company do not overlap.',
    },
  },
});

/** The company's accounting settings: lock dates and the accounts its documents post to. */
export const CompanyAccounting = extendModel('res.company', {
  fields: {
    chartTemplate: f.selection(
      { generic: 'Generic', bd: 'Bangladesh' },
      { label: 'Chart of accounts' },
    ),
    /** Nothing is posted, reversed or reconciled on or before it (everyone). */
    lockDate: f.date({ label: 'Lock date' }),
    /** Tax returns filed up to this date: tax lines cannot change on or before it. */
    taxLockDate: f.date({ label: 'Tax lock date' }),
    accountReceivable: f.many2one('account.account', { label: 'Receivable account' }),
    accountPayable: f.many2one('account.account', { label: 'Payable account' }),
    accountExchangeGain: f.many2one('account.account', { label: 'Exchange gain account' }),
    accountExchangeLoss: f.many2one('account.account', { label: 'Exchange loss account' }),
    accountRetainedEarnings: f.many2one('account.account', { label: 'Retained earnings account' }),
  },
});

/** The accounts a tax posts to (the tax itself lives in the product module, shared by Sales and Purchase). */
export const TaxAccounts = extendModel('account.tax', {
  fields: {
    account: f.many2one('account.account', { label: 'Tax account' }),
    /** On credit notes, when different from the tax account. */
    refundAccount: f.many2one('account.account', { label: 'Tax account on credit notes' }),
    /** Taxes included in the unit price (the price is gross). */
    priceIncluded: f.boolean({ default: false, label: 'Included in price' }),
  },
});

const moveTotals = compute(
  'account.move',
  ['amountDebit', 'amountCredit'],
  ['lines.debit', 'lines.credit', 'lines.companyCurrency'],
  (moves) => {
    for (const m of moves) {
      let debit = orm.toDecimal(0);
      let credit = orm.toDecimal(0);
      // Money reads are null until the (computed) company currency is stored: count what is there.
      for (const l of m.lines) {
        debit = debit.plus(l.debit?.amount ?? 0);
        credit = credit.plus(l.credit?.amount ?? 0);
      }
      m.amountDebit = debit;
      m.amountCredit = credit;
    }
  },
);

const NUMBER_FIELDS = [
  'numberSale',
  'numberPurchase',
  'numberCash',
  'numberBank',
  'numberGeneral',
] as const;

export const AccountMove = defineModel('account.move', {
  label: 'Journal entry',
  order: ['date desc', 'name desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'date', 'journal', 'partner'],
  access: {
    'account.invoicing': WRITE,
    'account.user': ALL,
    'account.manager': ALL,
  },
  rules: {
    all: {
      groups: ['account.invoicing', 'account.user', 'account.manager'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: {},
    },
  },
  fields: {
    /** The number, taken from the journal type's sequence at posting ('/' until then: no gaps from drafts). */
    name: f.char({
      required: true,
      store: true,
      label: 'Number',
      ...compute('account.move', 'name', [...NUMBER_FIELDS], (moves) => {
        for (const m of moves)
          m.name =
            NUMBER_FIELDS.map((k) => m[k]).find((v) => v !== null && v !== orm.UNNUMBERED) ??
            orm.UNNUMBERED;
      }),
    }),
    numberSale: f.char({
      readonly: true,
      sequence: { code: 'account.move.sale', on: 'manual', dateField: 'date' },
    }),
    numberPurchase: f.char({
      readonly: true,
      sequence: { code: 'account.move.purchase', on: 'manual', dateField: 'date' },
    }),
    numberCash: f.char({
      readonly: true,
      sequence: { code: 'account.move.cash', on: 'manual', dateField: 'date' },
    }),
    numberBank: f.char({
      readonly: true,
      sequence: { code: 'account.move.bank', on: 'manual', dateField: 'date' },
    }),
    numberGeneral: f.char({
      readonly: true,
      sequence: { code: 'account.move.general', on: 'manual', dateField: 'date' },
    }),
    journal: f.many2one('account.journal', { required: true, checkCompany: true }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    kind: f.selection(MOVE_KINDS, { required: true, default: 'entry', label: 'Type' }),
    partner: f.many2one('res.partner', { checkCompany: true }),
    ref: f.char({ label: 'Reference' }),
    currency: f.many2one('res.currency', { required: true }),
    /** Units of the entry's currency per unit of the company currency at the entry's date; filled at posting. */
    rate: f.decimal({ scale: 12, label: 'Rate' }),
    companyCurrency: f.many2one('res.currency', {
      store: true,
      readonly: true,
      ...compute('account.move', 'companyCurrency', ['company.currency'], (moves) => {
        for (const m of moves) m.companyCurrency = m.company.currency.id;
      }),
    }),
    narration: f.text({ label: 'Notes' }),
    lines: f.one2many('account.move.line', 'move'),
    amountDebit: f.monetary({
      currency: 'companyCurrency',
      store: true,
      label: 'Debit',
      ...moveTotals,
    }),
    amountCredit: f.monetary({
      currency: 'companyCurrency',
      store: true,
      label: 'Credit',
      ...moveTotals,
    }),
    state: f.state({
      states: { draft: 'Draft', posted: 'Posted', cancel: 'Cancelled' },
      initial: 'draft',
      transitions: {
        post: {
          from: ['draft'],
          to: 'posted',
          requires: 'account.post',
          before: records('account.move', (moves) => postMoves(moves)),
        },
        cancel: { from: ['draft'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
      extensible: true,
      tracking: true,
    }),
    postedAt: f.datetime({ label: 'Posted at' }),
    /** The database transaction that posted the entry: the immutability checks let that one finish its writes. */
    postedTx: f.char({ size: 32 }),
    reversalOf: f.many2one('account.move', { label: 'Reversal of' }),
    reversedBy: f.many2one('account.move', { label: 'Reversed by' }),
  },
  constraints: {
    // A posted entry is frozen (the database triggers of chart.ts back this up for raw SQL and deletes).
    postedImmutable: {
      ...check(
        'account.move',
        ['journal', 'date', 'kind', 'partner', 'ref', 'currency', 'rate', 'state', 'postedTx'],
        async (moves) => {
          const tx = await currentTx(moves.env);
          return moves.filter(
            (m) => m.state === 'posted' && m.postedTx !== null && m.postedTx !== tx,
          );
        },
      ),
      message: 'A posted entry cannot be changed. Reverse it instead.',
    },
  },
});

export const AccountMoveLine = defineModel('account.move.line', {
  label: 'Journal item',
  order: ['date desc', 'move desc', 'id asc'],
  access: {
    'account.invoicing': WRITE,
    'account.user': ALL,
    'account.manager': ALL,
  },
  fields: {
    move: f.many2one('account.move', { required: true, ondelete: 'cascade', label: 'Entry' }),
    account: f.many2one('account.account', { required: true, ondelete: 'restrict' }),
    partner: f.many2one('res.partner'),
    name: f.char({ label: 'Label' }),
    /** The entry's date, kept on the line for the reports. */
    date: f.date({
      store: true,
      readonly: true,
      ...compute('account.move.line', 'date', ['move.date'], (lines) => {
        for (const l of lines) l.date = l.move.date;
      }),
    }),
    dateMaturity: f.date({ label: 'Due date' }),
    companyCurrency: f.many2one('res.currency', {
      store: true,
      readonly: true,
      ...compute('account.move.line', 'companyCurrency', ['move.companyCurrency'], (lines) => {
        for (const l of lines) l.companyCurrency = l.move.companyCurrency?.id ?? null;
      }),
    }),
    currency: f.many2one('res.currency', {
      store: true,
      readonly: true,
      ...compute('account.move.line', 'currency', ['move.currency'], (lines) => {
        for (const l of lines) l.currency = l.move.currency.id;
      }),
    }),
    debit: f.monetary({ currency: 'companyCurrency', required: true, default: '0' }),
    credit: f.monetary({ currency: 'companyCurrency', required: true, default: '0' }),
    /** Signed amount in the entry's currency (debit positive); equals debit − credit in the company currency. */
    amountCurrency: f.monetary({ currency: 'currency', label: 'Amount in currency' }),
    product: f.many2one('product.product'),
    quantity: f.decimal({ scale: 3 }),
    tax: f.many2one('account.tax'),
    /** Set on the generated tax lines: the tax this line is the amount of. */
    taxLineOf: f.many2one('account.tax', { label: 'Tax line for' }),
    reconciled: f.boolean({ default: false, readonly: true }),
  },
  sqlConstraints: {
    sides: {
      check: orm.sql`debit >= 0 AND credit >= 0 AND NOT (debit > 0 AND credit > 0)`,
      message: 'A line is a debit or a credit, never both, and never negative.',
    },
  },
  constraints: {
    postedImmutable: {
      ...check(
        'account.move.line',
        ['move', 'account', 'partner', 'name', 'debit', 'credit', 'amountCurrency', 'dateMaturity'],
        async (lines) => {
          const loaded = await lines.load({ move: true });
          const tx = await currentTx(lines.env);
          return loaded.filter(
            (l) => l.move.state === 'posted' && l.move.postedTx !== null && l.move.postedTx !== tx,
          );
        },
      ),
      message: 'The lines of a posted entry cannot be changed. Reverse the entry instead.',
    },
  },
});

type Moves = Parameters<Parameters<typeof records<'account.move'>>[1]>[0];

/** The current database transaction's id (assigned on first use; posting writes anyway). */
async function currentTx(env: Env): Promise<string> {
  const [row] = await env.sql<{ tx: string }>`SELECT pg_current_xact_id()::text AS tx`;
  return row?.tx ?? '';
}

/**
 * What posting does, in the transaction of the `post` transition and before the state changes: the lock dates,
 * the rate and the company-currency amounts of foreign-currency lines, the balance, the number.
 */
async function postMoves(moves: Moves): Promise<void> {
  const env = moves.env;
  const loaded = await moves.load({
    lines: true,
    journal: true,
    company: { currency: true },
    currency: true,
  });
  for (const m of loaded) {
    const fail = (fields: string[], problem: string, hint: string) =>
      new orm.ValidationError('account.move', fields, problem, hint);
    if (m.lines.length === 0)
      throw fail(['lines'], 'The entry has no lines.', 'Add at least one line before posting.');
    const lock = m.company.lockDate;
    if (lock !== null && m.date <= lock)
      throw fail(
        ['date'],
        `${m.date} is on or before the lock date ${lock}.`,
        'Post on a later date, or have an accounting manager move the lock date.',
      );
    const closed = await env.model('account.fiscal.year').search({
      where: {
        company: m.company.id,
        state: 'closed',
        dateFrom: { lte: m.date },
        dateTo: { gte: m.date },
      },
      limit: 1,
    });
    if (closed.length > 0)
      throw fail(['date'], `${m.date} is in a closed fiscal year.`, 'Post in an open year.');

    const companyCurrency = m.company.currency;
    const foreign = m.currency.id !== companyCurrency.id;
    const one = env.model('account.move').browse([m.id]);
    let debit = orm.toDecimal(0);
    let credit = orm.toDecimal(0);
    if (foreign) {
      let rate = m.rate;
      if (rate === null) {
        try {
          const rates = await env.fx.prepare({
            date: m.date,
            currencies: [m.currency.id],
            company: m.company.id,
          });
          rate = rates.rate(m.currency.id).rate;
        } catch (error) {
          throw fail(
            ['currency'],
            error instanceof Error ? error.message : String(error),
            "Add a currency rate for the entry's date, or set the rate on the entry.",
          );
        }
      }
      if (m.rate === null) await one.write({ rate });
      for (const l of m.lines) {
        // Lines entered in the entry's currency get their company-currency side at the entry's rate.
        if (
          l.debit.isZero() &&
          l.credit.isZero() &&
          l.amountCurrency !== null &&
          !l.amountCurrency.isZero()
        ) {
          const converted = l.amountCurrency.amount.div(rate);
          const unit = companyCurrency.rounding;
          const rounded = converted
            .abs()
            .div(unit)
            .toDecimalPlaces(0, orm.Decimal.ROUND_HALF_UP)
            .times(unit);
          const side = converted.isNegative()
            ? { debit: '0', credit: rounded }
            : { debit: rounded, credit: '0' };
          await env.model('account.move.line').browse([l.id]).write(side);
          debit = debit.plus(side.debit);
          credit = credit.plus(side.credit);
          continue;
        }
        debit = debit.plus(l.debit.amount);
        credit = credit.plus(l.credit.amount);
      }
    } else {
      for (const l of m.lines) {
        debit = debit.plus(l.debit.amount);
        credit = credit.plus(l.credit.amount);
        if (l.amountCurrency === null)
          await env
            .model('account.move.line')
            .browse([l.id])
            .write({ amountCurrency: l.debit.amount.minus(l.credit.amount) });
      }
      if (m.rate === null) await one.write({ rate: '1' });
    }
    const places = companyCurrency.decimalPlaces ?? 2;
    if (!debit.equals(credit))
      throw fail(
        ['lines'],
        `The entry does not balance: debit ${debit.toFixed(places)} and credit ${credit.toFixed(places)} differ by ${debit.minus(credit).abs().toFixed(places)}.`,
        'Make the debits and the credits equal before posting.',
      );
    await one.assignNumber(NUMBER_FIELD[m.journal.type], { date: m.date });
    await one.write({ postedAt: env.now(), postedTx: await currentTx(env) });
  }
}

const sequence = (type: JournalType, prefix: string) =>
  orm.defineSequence({
    code: `account.move.${type}`,
    prefix: `${prefix}/{year}/`,
    padding: 5,
    reset: 'yearly',
    gapless: true,
  });

export const accountingShutro = defineModule({
  name: 'accounting',
  version: '0.1.0',
  depends: [contactsShutro, productShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: 'account.invoicing',
      label: 'Invoicing',
      implies: ['contacts.user', 'product.user', 'messaging.user'],
    }),
    orm.defineGroup({ code: 'account.user', label: 'Accountant', implies: ['account.invoicing'] }),
    orm.defineGroup({
      code: 'account.manager',
      label: 'Accounting manager',
      implies: ['account.user', 'product.manager'],
    }),
  ],
  permissions: [
    orm.definePermission({ code: 'account.post', label: 'Post entries', groups: ['account.user'] }),
  ],
  sequences: [
    sequence('sale', 'INV'),
    sequence('purchase', 'BILL'),
    sequence('cash', 'CSH'),
    sequence('bank', 'BNK'),
    sequence('general', 'MISC'),
  ],
  models: [
    ResCurrencyRate,
    AccountAccount,
    AccountJournal,
    AccountFiscalYear,
    AccountMove,
    AccountMoveLine,
  ],
  extensions: [CompanyAccounting, TaxAccounts],
});
