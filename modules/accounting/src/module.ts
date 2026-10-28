/**
 * The data layer of Accounting (RFC 0009), steps 1 and 2: the ledger core and the documents. Accounts typed for the reports, journals,
 * fiscal years with lock dates, currency rates, and journal entries (`account.move`) whose lines carry debit and
 * credit in the company currency as exact money, with the document-currency amount beside them. Posting checks
 * the lock dates, balances the entry to the paisa, converts foreign-currency lines at the entry's rate, takes the
 * number from the journal type's sequence (gapless, yearly) and freezes the entry: a posted entry is never edited
 * or deleted, only reversed. Everything is per company. Documents (invoices, bills, credit notes) are entries
 * of a `kind` whose product lines (`lineKind: 'product'`) carry quantities, prices, discounts and taxes; posting
 * generates the tax lines (one per tax, rounded per document) and the receivable / payable counterpart (one per
 * payment term line, with its due date), then settles every line's company-currency side. Vendor bills above
 * the policy's threshold wait for approval (`submit` → `to_approve`; the last approval posts). Payments (step 3)
 * are entries in a cash or bank journal whose receivable / payable line is **reconciled** with the documents'
 * counterpart lines: partial matches are records, residuals are computed from them, and a document is paid when
 * its counterpart lines are settled (`payments.ts` holds the matching).
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { approvalGuard, permissionsShutro, requestApprovals } from '@kosh/permissions';
import { computeTaxes, productShutro, taxRule } from '@kosh/product';
import { reportingShutro } from '@kosh/reporting';
import { type Decimal, type Money, orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  onchange,
  record,
  records,
  ref,
} from './.kosh/bindings.js';
import { postPayments } from './payments.js';

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
  out_debit: 'Customer debit note',
  in_debit: 'Vendor debit note',
} as const;
export type MoveKind = keyof typeof MOVE_KINDS;

/** Documents the partner owes the company for: customer invoices and debit notes, vendor credit notes. */
export function owedToUs(kind: MoveKind): boolean {
  return kind === 'out_invoice' || kind === 'out_debit' || kind === 'in_refund';
}

/** Credit notes (they post the other way round from the invoice they correct). */
export function isRefund(kind: MoveKind): boolean {
  return kind === 'out_refund' || kind === 'in_refund';
}

/** Within the state (`intra`) or between states and abroad (`inter`): which components of a tax post (RFC 0016). */
export type SupplyScope = 'intra' | 'inter';

/**
 * The scope of a document: `inter` for a partner in another country, otherwise the place of supply against the
 * company's state (`intra` when either is unknown: a country without states).
 */
export function supplyScope(
  company: { readonly country: string | null; readonly state: string | null },
  partnerCountry: string | null,
  placeOfSupply: string | null,
): SupplyScope {
  if (partnerCountry !== null && company.country !== null && partnerCountry !== company.country)
    return 'inter';
  if (placeOfSupply === null || company.state === null) return 'intra';
  return placeOfSupply === company.state ? 'intra' : 'inter';
}

/** The kind of the entry that reverses one of each kind. */
export const REVERSED_KIND: Readonly<Record<MoveKind, MoveKind>> = {
  entry: 'entry',
  out_invoice: 'out_refund',
  out_refund: 'out_invoice',
  in_invoice: 'in_refund',
  in_refund: 'in_invoice',
  out_debit: 'out_refund',
  in_debit: 'in_refund',
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
  archivable: true,
  companyScoped: { required: true },
  access: { 'account.invoicing': READ, 'account.user': READ, 'account.manager': ALL },
  fields: {
    code: f.char({ required: true, size: 32, index: true }),
    name: f.char({ required: true, translate: true }),
    /** Shown everywhere as "1100 Accounts receivable". */
    displayName: f.char({
      ...compute('account.account', 'displayName', ['code', 'name'], (accounts) => {
        for (const a of accounts) a.displayName = `${a.code} ${a.name}`;
      }),
    }),
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

/** A bank account of the company: shown on its invoices and in the portal, where customers pay (RFC 0016 §5.1). */
export const ResBankAccount = defineModel('res.bank.account', {
  label: 'Bank account',
  order: ['sequence asc', 'id asc'],
  recName: 'number',
  archivable: true,
  companyScoped: { required: true },
  // The company's payment details are not secret: every user (and the portal, through it) may read them.
  access: { 'base.user': READ, 'account.manager': ALL },
  fields: {
    sequence: f.integer({ required: true, default: 10 }),
    bank: f.char({ required: true, label: 'Bank' }),
    branch: f.char(),
    number: f.char({ required: true, label: 'Account number' }),
    holder: f.char({ label: 'Account holder' }),
    /** Routing number (Bangladesh), IFSC (India), sort code… */
    routing: f.char({ label: 'Routing number' }),
    swift: f.char({ label: 'SWIFT / BIC' }),
    /** Shown on invoices in this currency; on every invoice when empty. */
    currency: f.many2one('res.currency'),
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
    /** The entry that moved the year's result to retained earnings (closing.ts). */
    closingMove: f.many2one('account.move', { label: 'Closing entry' }),
    reopenReason: f.char({ label: 'Reopened because' }),
  },
  onchange: {
    // A year that starts on a date ends the day before the same date a year later.
    dateFrom: onchange('account.fiscal.year', (d) => {
      const from = d.get('dateFrom');
      if (typeof from !== 'string') return;
      const [y, m, day] = from.split('-').map(Number) as [number, number, number];
      d.set('dateTo', new Date(Date.UTC(y + 1, m - 1, day - 1)).toISOString().slice(0, 10));
      if (d.get('name') === null || d.get('name') === '')
        d.set('name', m === 1 && day === 1 ? String(y) : `${y}–${String(y + 1).slice(2)}`);
    }),
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

export const AccountPaymentTerm = defineModel('account.payment.term', {
  label: 'Payment term',
  order: ['name asc'],
  archivable: true,
  access: { 'account.invoicing': READ, 'account.user': READ, 'account.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    note: f.text({ label: 'Shown on documents' }),
    lines: f.one2many('account.payment.term.line', 'term'),
  },
});

/** A part of the amount due some days after the document date (the parts sum to 100 %). */
export const AccountPaymentTermLine = defineModel('account.payment.term.line', {
  label: 'Payment term line',
  order: ['days asc', 'id asc'],
  access: {
    'account.invoicing': READ,
    'account.user': READ,
    'account.manager': ['read', 'write', 'create', 'unlink'],
  },
  fields: {
    term: f.many2one('account.payment.term', { required: true, ondelete: 'cascade' }),
    days: f.integer({ required: true, default: 0 }),
    percent: f.decimal({ scale: 2, required: true, default: '100' }),
  },
  sqlConstraints: {
    percentRange: {
      check: orm.sql`percent > 0 AND percent <= 100`,
      message: 'A part is between 0 and 100 %.',
    },
    daysPositive: { check: orm.sql`days >= 0`, message: 'Days are zero or more.' },
  },
});

/** The fiscal year that `date` (ISO) falls in, for years starting in month `start` (1–12): its first and last day. */
export function fiscalYearOf(date: string, start: number): { dateFrom: string; dateTo: string } {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const year = m >= start ? y : y - 1;
  const from = new Date(Date.UTC(year, start - 1, 1));
  const to = new Date(Date.UTC(year + 1, start - 1, 0)); // the day before the next year starts
  return { dateFrom: from.toISOString().slice(0, 10), dateTo: to.toISOString().slice(0, 10) };
}

/** The company's accounting settings: lock dates and the accounts its documents post to. */
export const CompanyAccounting = extendModel('res.company', {
  fields: {
    /** The first month of its fiscal years (July in Bangladesh: July–June). */
    fiscalYearStart: f.integer({
      required: true,
      default: 1,
      label: 'Fiscal year starts in (month, 1–12)',
    }),
    /** The installed chart: `generic` or a localization's key (`bd`). */
    chartTemplate: f.char({ size: 32, label: 'Chart of accounts' }),
    /** Where the company is registered (ISO 3166): taxes split by place of supply compare against it. */
    country: f.char({ size: 2, label: 'Country' }),
    /** Its state or province (ISO 3166-2, `IN-MH`). */
    state: f.char({ size: 6, label: 'State' }),
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
  sqlConstraints: {
    fiscalYearMonth: {
      check: orm.sql`fiscal_year_start BETWEEN 1 AND 12`,
      message: 'A fiscal year starts in a month from 1 (January) to 12 (December).',
    },
  },
});

/** The accounts a tax posts to (the tax itself lives in the product module, shared by Sales and Purchase). */
export const TaxAccounts = extendModel('account.tax', {
  fields: {
    account: f.many2one('account.account', { label: 'Tax account' }),
    /** On credit notes, when different from the tax account. */
    refundAccount: f.many2one('account.account', { label: 'Tax account on credit notes' }),
    /** Reverse charge: where the tax the company owes the state goes (the tax account takes what it may claim). */
    reverseChargeAccount: f.many2one('account.account', {
      label: 'Tax account for reverse charge (payable)',
    }),
    /** Its parts (CGST and SGST, or IGST): posted instead of the tax, by the document's scope. */
    components: f.one2many('account.tax.component', 'tax'),
  },
});

/**
 * A part of a tax (RFC 0016 step 5): GST 18 % is CGST 9 % and SGST 9 % within a state, IGST 18 % between states.
 * Lines and totals keep the tax; posting writes a tax line per component of the document's scope, each with its
 * share of the amount, to its account. The shares of each scope add up to 1.
 */
export const AccountTaxComponent = defineModel('account.tax.component', {
  label: 'Tax component',
  order: ['sequence asc', 'id asc'],
  access: { 'account.invoicing': READ, 'account.user': READ, 'account.manager': ALL },
  fields: {
    tax: f.many2one('account.tax', { required: true, ondelete: 'cascade' }),
    sequence: f.integer({ required: true, default: 10 }),
    name: f.char({ required: true, translate: true }),
    /** Its part of the tax's amount: 0.5 for half. */
    share: f.decimal({ scale: 4, required: true, default: '1' }),
    scope: f.selection(
      { always: 'Always', intra: 'Within the state', inter: 'Between states or abroad' },
      { required: true, default: 'always' },
    ),
    /** What the returns call it: CGST, SGST, IGST, CESS. */
    code: f.char({ size: 16 }),
    account: f.many2one('account.account'),
    refundAccount: f.many2one('account.account', { label: 'Account on credit notes' }),
    reverseChargeAccount: f.many2one('account.account', {
      label: 'Account for reverse charge (payable)',
    }),
  },
  constraints: {
    shareRange: {
      ...check('account.tax.component', ['share'], (cs) =>
        cs.filter((c) => c.share.lte(0) || c.share.gt(1)),
      ),
      message: "A component's share is above 0 and at most 1 (0.5 for half).",
    },
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

const documentTotals = compute(
  'account.move',
  ['amountUntaxed', 'amountTax', 'amountTotal'],
  ['lines.subtotal', 'lines.taxAmount', 'lines.lineKind'],
  (moves) => {
    for (const m of moves) {
      let untaxed = orm.toDecimal(0);
      let tax = orm.toDecimal(0);
      for (const l of m.lines) {
        if (l.lineKind !== 'product') continue;
        untaxed = untaxed.plus(l.subtotal?.amount ?? 0);
        tax = tax.plus(l.taxAmount?.amount ?? 0);
      }
      m.amountUntaxed = untaxed;
      m.amountTax = tax;
      m.amountTotal = untaxed.plus(tax);
    }
  },
);

const moveResidual = compute(
  'account.move',
  ['amountResidual', 'paymentState'],
  ['kind', 'state', 'amountTotal', 'lines.lineKind', 'lines.amountResidualCurrency'],
  (moves) => {
    for (const m of moves) {
      if (m.kind === 'entry') {
        m.amountResidual = orm.toDecimal(0);
        m.paymentState = 'not_applicable';
        continue;
      }
      // The counterpart is a debit on outgoing documents (receivable) and a credit on incoming ones.
      const sign = owedToUs(m.kind) ? 1 : -1;
      let residual = orm.toDecimal(0);
      for (const l of m.lines)
        if (l.lineKind === 'counterpart')
          residual = residual.plus(l.amountResidualCurrency?.amount ?? 0);
      residual = residual.times(sign);
      m.amountResidual = residual;
      const total = m.amountTotal?.amount ?? orm.toDecimal(0);
      m.paymentState =
        m.state !== 'posted' || total.isZero()
          ? 'not_paid'
          : residual.isZero()
            ? 'paid'
            : residual.equals(total)
              ? 'not_paid'
              : 'partial';
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
    /** The product lines of a document (what was sold or bought), for the PDF and the reports. */
    invoiceLines: f.one2many('account.move.line', 'invoice'),
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
    // Documents
    dateDue: f.date({ label: 'Due date' }),
    /** Where to pay a customer invoice: the company's bank accounts in its currency, and the reference to quote. */
    paymentDetails: f.text({
      label: 'Payment details',
      ...compute(
        'account.move',
        'paymentDetails',
        ['kind', 'name', 'currency', 'company'],
        async (moves) => {
          for (const m of moves) {
            if (m.kind !== 'out_invoice') {
              m.paymentDetails = '';
              continue;
            }
            const banks = await moves.env.model('res.bank.account').search({
              where: {
                company: m.company.id,
                or: [{ currency: { isNull: true } }, { currency: m.currency.id }],
              },
            });
            const rows = await banks.load({});
            const lines = [...rows].map((b) =>
              [
                [b.bank, b.branch].filter((x) => x !== null && x !== '').join(', '),
                `A/C ${b.number}${b.holder === null ? '' : ` (${b.holder})`}`,
                b.routing === null ? null : `Routing ${b.routing}`,
                b.swift === null ? null : `SWIFT ${b.swift}`,
              ]
                .filter((x) => x !== null && x !== '')
                .join(' · '),
            );
            m.paymentDetails =
              lines.length === 0
                ? ''
                : [...lines, ...(m.name === '/' ? [] : [`Reference: ${m.name}`])].join('\n');
          }
        },
      ),
    }),
    paymentTerm: f.many2one('account.payment.term', { label: 'Payment terms' }),
    invoiceOrigin: f.char({ label: 'Source document' }),
    amountUntaxed: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Untaxed',
      ...documentTotals,
    }),
    amountTax: f.monetary({ currency: 'currency', store: true, label: 'Taxes', ...documentTotals }),
    amountTotal: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Total',
      ...documentTotals,
    }),
    /** What is still due on a posted document, in its currency. */
    amountResidual: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Amount due',
      ...moveResidual,
    }),
    paymentState: f.selection(
      {
        not_applicable: '—',
        not_paid: 'Not paid',
        partial: 'Partially paid',
        paid: 'Paid',
      },
      { store: true, label: 'Payment', ...moveResidual },
    ),
    payments: f.many2many('account.payment', { label: 'Paid by' }),
    state: f.state({
      states: {
        draft: 'Draft',
        to_approve: 'Waiting approval',
        posted: 'Posted',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      transitions: {
        /** Bills: ask the approvers the amount needs (none needed: post right after). */
        submit: {
          from: ['draft'],
          to: 'to_approve',
          after: records('account.move', (moves) => requestApprovals(moves)),
        },
        post: {
          from: ['draft', 'to_approve'],
          to: 'posted',
          requires: 'account.post',
          guard: records('account.move', (moves) => approvalGuard(moves)),
          message: 'Waiting for approvals.',
          before: records('account.move', (moves) => postMoves(moves)),
        },
        reject: { from: ['to_approve'], to: 'draft' },
        cancel: { from: ['draft', 'to_approve'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
      extensible: true,
      tracking: true,
    }),
    postedAt: f.datetime({ label: 'Posted at' }),
    /** The database transaction that posted the entry: the immutability checks let that one finish its writes. */
    postedTx: f.char({ size: 32 }),
    reversalOf: f.many2one('account.move', { label: 'Reversal of' }),
    /** A debit note: the invoice or bill it adds to. */
    debitOf: f.many2one('account.move', { label: 'Adds to' }),
    /**
     * The state where the supply takes place (ISO 3166-2, `IN-KA`): from the partner's state when posted, editable.
     * Decides whether a tax's within-state or between-states components post.
     */
    placeOfSupply: f.char({ size: 6, label: 'Place of supply' }),
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

const lineResiduals = compute(
  'account.move.line',
  ['amountResidual', 'amountResidualCurrency', 'reconciled'],
  [
    'debit',
    'credit',
    'amountCurrency',
    'account.reconcile',
    'move.state',
    'partialsAsDebit.amount',
    'partialsAsDebit.amountCurrency',
    'partialsAsCredit.amount',
    'partialsAsCredit.amountCurrency',
  ],
  (lines) => {
    for (const l of lines) {
      const open = l.account?.reconcile === true && l.move.state === 'posted';
      if (!open) {
        l.amountResidual = orm.toDecimal(0);
        l.amountResidualCurrency = orm.toDecimal(0);
        l.reconciled = false;
        continue;
      }
      let residual = (l.debit?.amount ?? orm.toDecimal(0)).minus(l.credit?.amount ?? 0);
      let inCurrency = l.amountCurrency?.amount ?? residual;
      for (const p of l.partialsAsDebit) {
        residual = residual.minus(p.amount);
        inCurrency = inCurrency.minus(p.amountCurrency ?? p.amount);
      }
      for (const p of l.partialsAsCredit) {
        residual = residual.plus(p.amount);
        inCurrency = inCurrency.plus(p.amountCurrency ?? p.amount);
      }
      l.amountResidual = residual;
      l.amountResidualCurrency = inCurrency;
      l.reconciled = residual.isZero() && inCurrency.isZero();
    }
  },
);

/** A match between a debit line and a credit line of one reconcilable account (RFC 0009 §4). */
export const AccountPartialReconcile = defineModel('account.partial.reconcile', {
  label: 'Partial reconciliation',
  order: ['id asc'],
  access: {
    'account.invoicing': READ,
    'account.user': ['read', 'write', 'create', 'unlink'],
    'account.manager': ALL,
  },
  fields: {
    debitLine: f.many2one('account.move.line', { required: true, ondelete: 'restrict' }),
    creditLine: f.many2one('account.move.line', { required: true, ondelete: 'restrict' }),
    /** Matched amount in the company currency. */
    amount: f.decimal({ scale: 6, required: true }),
    /** Matched amount in the lines' currency (the company currency's when they have none). */
    amountCurrency: f.decimal({ scale: 6 }),
    currency: f.many2one('res.currency'),
    /** The entry that posted the exchange difference this match created, when any. */
    exchangeMove: f.many2one('account.move', { label: 'Exchange difference entry' }),
    fullReconcile: f.many2one('account.full.reconcile', { ondelete: 'set null' }),
  },
  sqlConstraints: {
    amountPositive: { check: orm.sql`amount >= 0`, message: 'A match is zero or more.' },
  },
});

/** A set of lines settled together: every line's residual is zero (RFC 0009 §4). */
export const AccountFullReconcile = defineModel('account.full.reconcile', {
  label: 'Reconciliation',
  order: ['id desc'],
  access: {
    'account.invoicing': READ,
    'account.user': ['read', 'write', 'create', 'unlink'],
    'account.manager': ALL,
  },
  fields: {
    name: f.char({ required: true }),
    lines: f.one2many('account.move.line', 'fullReconcile'),
    partials: f.one2many('account.partial.reconcile', 'fullReconcile'),
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
    /** Required at posting (a document's product lines take the journal's default account). */
    account: f.many2one('account.account', { ondelete: 'restrict' }),
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
    /** What the line is: an entry line, a document's product line, or a generated tax / counterpart line. */
    lineKind: f.selection(
      {
        entry: 'Entry',
        product: 'Product',
        tax: 'Tax',
        counterpart: 'Receivable / payable',
      },
      { required: true, default: 'entry', label: 'Kind' },
    ),
    /** The document this is a product line of (null on entry lines and generated lines). */
    invoice: f.many2one('account.move', {
      store: true,
      readonly: true,
      ...compute('account.move.line', 'invoice', ['move', 'lineKind'], (lines) => {
        for (const l of lines) l.invoice = l.lineKind === 'product' ? l.move.id : null;
      }),
    }),
    product: f.many2one('product.product'),
    quantity: f.decimal({ scale: 3, default: '1' }),
    priceUnit: f.decimal({ scale: 2, default: '0', label: 'Unit price' }),
    /** Percent off the unit price (0–100). */
    discount: f.decimal({ scale: 2, default: '0', label: 'Discount %' }),
    /** A product line's taxes, applied in order (RFC 0016): supplementary duty, then VAT on price + SD. */
    taxes: f.many2many('account.tax'),
    /** Before 0.2.0, one tax per line: copied into `taxes` by the migration; dropped later. */
    tax: f.many2one('account.tax', { label: 'Tax (before 0.2.0)', readonly: true }),
    /** Tax-excluded amount of a product line in the document currency. */
    subtotal: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Subtotal',
      ...compute(
        'account.move.line',
        'subtotal',
        [
          'lineKind',
          'quantity',
          'priceUnit',
          'discount',
          'taxes.rate',
          'taxes.sequence',
          'taxes.amountType',
          'taxes.fixedAmount',
          'taxes.affectsBase',
          'taxes.priceIncluded',
          'taxes.reverseCharge',
        ],
        (lines) => {
          for (const l of lines)
            l.subtotal = l.lineKind === 'product' ? taxesOfLine(l).untaxed : null;
        },
      ),
    }),
    /** The taxes of a product line in the document currency (summed and rounded per tax at posting). */
    taxAmount: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Tax',
      ...compute(
        'account.move.line',
        'taxAmount',
        [
          'lineKind',
          'quantity',
          'priceUnit',
          'discount',
          'taxes.rate',
          'taxes.sequence',
          'taxes.amountType',
          'taxes.fixedAmount',
          'taxes.affectsBase',
          'taxes.priceIncluded',
          'taxes.reverseCharge',
        ],
        (lines) => {
          for (const l of lines)
            l.taxAmount = l.lineKind === 'product' ? taxesOfLine(l).taxTotal : null;
        },
      ),
    }),
    /** Set on the generated tax lines: the tax this line is the amount of. */
    taxLineOf: f.many2one('account.tax', { label: 'Tax line for' }),
    /** On the generated tax lines of a tax with components: which one (CGST, SGST, IGST). */
    taxComponent: f.many2one('account.tax.component', { label: 'Tax component' }),
    /** On the generated lines of a reverse-charge tax: claimable and payable, net zero. */
    taxReverseCharge: f.boolean({ required: true, default: false, label: 'Reverse charge' }),
    /** On the generated tax lines: what the tax was computed on, in the document currency (the tax reports). */
    taxBase: f.monetary({ currency: 'currency', label: 'Tax base' }),
    /** Debit minus credit, for the reports (trial balance, ledgers, P&L, balance sheet). */
    balance: f.monetary({
      currency: 'companyCurrency',
      store: true,
      // companyCurrency too: money reads are null until it is stored, and the sides may never change again.
      ...compute(
        'account.move.line',
        'balance',
        ['debit', 'credit', 'companyCurrency'],
        (lines) => {
          for (const l of lines)
            l.balance = (l.debit?.amount ?? orm.toDecimal(0)).minus(l.credit?.amount ?? 0);
        },
      ),
    }),
    /** The entry is posted: the reports read posted lines only. */
    posted: f.boolean({
      store: true,
      index: true,
      ...compute('account.move.line', 'posted', ['move.state'], (lines) => {
        for (const l of lines) l.posted = l.move.state === 'posted';
      }),
    }),
    /** The account's type, on the line for grouping (P&L, balance sheet, aging). */
    accountType: f.selection(ACCOUNT_TYPES, {
      store: true,
      label: 'Account type',
      ...compute('account.move.line', 'accountType', ['account.type'], (lines) => {
        for (const l of lines) l.accountType = l.account?.type ?? null;
      }),
    }),
    /** The tax a generated tax line reports under (its amount, with its base in `taxBase`). */
    taxReport: f.many2one('account.tax', {
      store: true,
      label: 'Tax (report)',
      ...compute('account.move.line', 'taxReport', ['taxLineOf', 'lineKind'], (lines) => {
        for (const l of lines)
          l.taxReport = l.lineKind === 'tax' ? (l.taxLineOf?.id ?? null) : null;
      }),
    }),
    /** Partial matches this line takes part in, on its debit or its credit side (`payments.ts`). */
    partialsAsDebit: f.one2many('account.partial.reconcile', 'debitLine'),
    partialsAsCredit: f.one2many('account.partial.reconcile', 'creditLine'),
    fullReconcile: f.many2one('account.full.reconcile', { ondelete: 'set null', label: 'Matched' }),
    /** What is still open on a reconcilable account's line, in the company currency (debit positive). */
    amountResidual: f.monetary({
      currency: 'companyCurrency',
      store: true,
      label: 'Residual',
      ...lineResiduals,
    }),
    amountResidualCurrency: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Residual in currency',
      ...lineResiduals,
    }),
    reconciled: f.boolean({ store: true, ...lineResiduals }),
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
        [
          'move',
          'account',
          'partner',
          'name',
          'debit',
          'credit',
          'amountCurrency',
          'dateMaturity',
          'lineKind',
          'product',
          'quantity',
          'priceUnit',
          'discount',
          'taxes',
        ],
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

/** What the tax engine needs of a product line. */
interface TaxedLine {
  readonly quantity: Decimal | null;
  readonly priceUnit: Decimal | null;
  readonly discount: Decimal | null;
  readonly taxes: Iterable<Parameters<typeof taxRule>[0]>;
}

/** A product line's taxes (RFC 0016): its amount after discount through the engine. */
function taxesOfLine(l: TaxedLine) {
  const quantity = l.quantity ?? orm.toDecimal(1);
  const amount = quantity
    .times(l.priceUnit ?? 0)
    .times(orm.toDecimal(100).minus(l.discount ?? 0))
    .div(100);
  return computeTaxes(amount, quantity, [...l.taxes].map(taxRule));
}

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
    lines: { taxes: { components: true } },
    partner: true,
    journal: true,
    company: { currency: true },
    currency: true,
    paymentTerm: { lines: true },
  });
  for (const m of loaded) {
    const fail = (fields: string[], problem: string, hint: string) =>
      new orm.ValidationError('account.move', fields, problem, hint);
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
    const linesOf = env.model('account.move.line');

    // Documents: the generated lines (taxes, the counterpart with its due dates).
    if (m.kind !== 'entry') {
      const generated = m.lines.filter((l) => l.lineKind === 'tax' || l.lineKind === 'counterpart');
      if (generated.length > 0) await linesOf.browse(generated.map((l) => l.id)).unlink();
      const products = m.lines.filter((l) => l.lineKind === 'product');
      if (products.length === 0)
        throw fail(['lines'], 'The document has no product lines.', 'Add at least one line.');
      if (m.partner === null)
        throw fail(
          ['partner'],
          'The document has no partner.',
          'Choose the customer or the vendor.',
        );
      const outgoing = owedToUs(m.kind);
      // Product and tax lines of an outgoing document are credits (income), the counterpart a debit.
      const sign = outgoing ? -1 : 1;
      const refund = isRefund(m.kind);
      const customer = m.kind.startsWith('out_');
      const unit = m.currency.rounding;
      const round = (d: Decimal) =>
        d.div(unit).toDecimalPlaces(0, orm.Decimal.ROUND_HALF_UP).times(unit);
      const currency = orm.defineCurrency({
        code: m.currency.name,
        rounding: m.currency.rounding,
        decimalPlaces: m.currency.decimalPlaces ?? 2,
        id: m.currency.id,
      });
      // The place of supply: the partner's state unless set; it decides which components of a tax post.
      const placeOfSupply = m.placeOfSupply ?? m.partner.state ?? null;
      if (placeOfSupply !== m.placeOfSupply) await one.write({ placeOfSupply });
      const scope = supplyScope(m.company, m.partner.country ?? null, placeOfSupply);
      let total = orm.toDecimal(0);
      type Item<T> = T extends Iterable<infer E> ? E : never;
      type Tax = Item<Item<typeof products>['taxes']>;
      const byTax = new Map<number, { amount: Decimal; base: Decimal; tax: Tax }>();
      for (const l of products) {
        const account = l.account?.id ?? m.journal.defaultAccount?.id ?? null;
        if (account === null)
          throw fail(
            ['lines'],
            `Line "${l.name ?? ''}" has no account and the journal ${m.journal.code} has no default account.`,
            'Set the account on the line, or a default account on the journal.',
          );
        const subtotal = round(l.subtotal?.amount ?? orm.toDecimal(0));
        total = total.plus(subtotal);
        await linesOf.browse([l.id]).write({
          account: orm.asId(account, 'account.account'),
          partner: m.partner.id,
          amountCurrency: subtotal.times(sign),
          debit: '0',
          credit: '0',
        });
        // Each tax of the line, in order, with its own base (SD in the VAT's base).
        for (const t of taxesOfLine(l).taxes) {
          const tax = [...l.taxes].find((x) => x.id === t.tax);
          if (tax === undefined) continue;
          const entry = byTax.get(t.tax) ?? {
            amount: orm.toDecimal(0),
            base: orm.toDecimal(0),
            tax,
          };
          entry.amount = entry.amount.plus(t.amount);
          entry.base = entry.base.plus(t.base);
          byTax.set(t.tax, entry);
        }
      }
      for (const [taxId, { amount: exact, base, tax }] of byTax) {
        // A reverse-charge tax is the buyer's to pay to the state: the seller posts nothing.
        if (tax.reverseCharge && customer) continue;
        const amount = round(exact);
        if (amount.isZero()) continue;
        // The tax itself, or its components of the document's scope, the amount allocated by share.
        const components = [...tax.components].filter(
          (c) => c.scope === 'always' || c.scope === scope,
        );
        const parts =
          components.length === 0
            ? [
                {
                  component: null,
                  name: tax.name,
                  account:
                    (refund ? (tax.refundAccount?.id ?? tax.account?.id) : tax.account?.id) ?? null,
                  payable: tax.reverseChargeAccount?.id ?? null,
                  share: orm.toDecimal(1),
                },
              ]
            : components.map((c) => ({
                component: c.id,
                name: c.name,
                account: (refund ? (c.refundAccount?.id ?? c.account?.id) : c.account?.id) ?? null,
                payable: c.reverseChargeAccount?.id ?? null,
                share: c.share,
              }));
        const shares = parts.reduce((sum, p) => sum.plus(p.share), orm.toDecimal(0));
        if (!shares.eq(1))
          throw fail(
            ['lines'],
            `The components of ${tax.name} ${scope === 'intra' ? 'within the state' : 'between states'} add up to ${shares.toString()}, not 1.`,
            'Fix their shares (Accounting › Configuration › Taxes).',
          );
        const amounts =
          parts.length === 1
            ? [amount]
            : orm.Money.of(amount, currency)
                .allocate(parts.map((p) => p.share))
                .map((money) => (money as Money).amount);
        for (const [i, part] of parts.entries()) {
          if (part.account === null)
            throw fail(
              ['lines'],
              `Tax ${part.name} has no account.`,
              'Set the tax account on the tax (Accounting › Configuration › Taxes).',
            );
          const value = amounts[i] as Decimal;
          const line = {
            move: m.id,
            lineKind: 'tax' as const,
            partner: m.partner.id,
            name: part.name,
            taxLineOf: orm.asId(taxId, 'account.tax'),
            ...(part.component === null
              ? {}
              : { taxComponent: orm.asId(part.component, 'account.tax.component') }),
            taxBase: round(base),
            debit: '0',
            credit: '0',
          };
          if (!tax.reverseCharge) {
            total = total.plus(value);
            await linesOf.create([
              {
                ...line,
                account: orm.asId(part.account, 'account.account'),
                amountCurrency: value.times(sign),
              },
            ]);
            continue;
          }
          // Reverse charge: what the company may claim, and what it owes the state; not in the total.
          if (part.payable === null)
            throw fail(
              ['lines'],
              `Tax ${part.name} is a reverse charge without a payable account.`,
              'Set its reverse-charge account (Accounting › Configuration › Taxes).',
            );
          await linesOf.create([
            {
              ...line,
              taxReverseCharge: true,
              account: orm.asId(part.account, 'account.account'),
              amountCurrency: value.times(sign),
            },
            {
              ...line,
              taxReverseCharge: true,
              account: orm.asId(part.payable, 'account.account'),
              amountCurrency: value.times(-sign),
            },
          ]);
        }
      }
      // Customers' documents settle on the receivable account, vendors' on the payable one.
      const counterpart = customer ? m.company.accountReceivable : m.company.accountPayable;
      if (counterpart === null)
        throw fail(
          ['partner'],
          `The company has no ${customer ? 'receivable' : 'payable'} account.`,
          'Install a chart of accounts (Accounting › Configuration), or set the account on the company.',
        );
      // One counterpart line per payment term part, the whole rounded total allocated between them.
      // Without payment terms, one part due on the document's due date (or its date).
      const parts =
        m.paymentTerm === null || m.paymentTerm.lines.length === 0
          ? [
              {
                days: m.dateDue === null ? 0 : daysBetween(m.date, m.dateDue),
                percent: orm.toDecimal(100),
              },
            ]
          : m.paymentTerm.lines.map((pl) => ({ days: pl.days, percent: pl.percent }));
      const totalMoney = orm.Money.of(total, currency);
      const amounts =
        parts.length === 1 ? [totalMoney] : totalMoney.allocate(parts.map((pt) => pt.percent));
      let latest = m.date;
      for (const [i, part] of parts.entries()) {
        const due = addDays(m.date, part.days);
        if (due > latest) latest = due;
        await linesOf.create([
          {
            move: m.id,
            lineKind: 'counterpart',
            account: counterpart.id,
            partner: m.partner.id,
            name: m.ref ?? m.invoiceOrigin ?? m.name,
            dateMaturity: due,
            amountCurrency: (amounts[i] as Money).amount.times(-sign),
            debit: '0',
            credit: '0',
          },
        ]);
      }
      await one.write({ dateDue: m.dateDue ?? latest });
    } else if (m.lines.length === 0)
      throw fail(['lines'], 'The entry has no lines.', 'Add at least one line before posting.');
    else
      for (const l of m.lines) {
        if (l.account === null)
          throw fail(
            ['lines'],
            `Line "${l.name ?? ''}" has no account.`,
            'Every line of an entry needs an account.',
          );
        // The entry's partner is the lines' partner unless a line says otherwise (ledgers, aging).
        if (l.partner === null && m.partner !== null)
          await linesOf.browse([l.id]).write({ partner: m.partner.id });
      }

    // Every line's company-currency side, at the entry's rate.
    let rate = m.rate;
    if (foreign && rate === null) {
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
    if (!foreign) rate = orm.toDecimal(1);
    if (m.rate === null) await one.write({ rate });
    const unitCompany = companyCurrency.rounding;
    let debit = orm.toDecimal(0);
    let credit = orm.toDecimal(0);
    const current = await linesOf.search({ where: { move: m.id } });
    for (const l of await current.load({})) {
      const sides = l.debit.isZero() && l.credit.isZero();
      if (sides && l.amountCurrency !== null && !l.amountCurrency.isZero()) {
        // Entered in the entry's currency: the company-currency side at the rate.
        const converted = l.amountCurrency.amount.div(rate as Decimal);
        const rounded = converted
          .abs()
          .div(unitCompany)
          .toDecimalPlaces(0, orm.Decimal.ROUND_HALF_UP)
          .times(unitCompany);
        const side = converted.isNegative()
          ? { debit: '0', credit: rounded }
          : { debit: rounded, credit: '0' };
        await linesOf.browse([l.id]).write(side);
        debit = debit.plus(side.debit);
        credit = credit.plus(side.credit);
        continue;
      }
      debit = debit.plus(l.debit.amount);
      credit = credit.plus(l.credit.amount);
      if (l.amountCurrency === null)
        await linesOf.browse([l.id]).write({
          amountCurrency: l.debit.amount.minus(l.credit.amount).times(rate as Decimal),
        });
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
    // For whoever acts on posted documents (e-invoicing, automation), through the outbox: after the commit.
    await env.emit('account.move.posted', { id: m.id, kind: m.kind });
  }
}

/** Whole days from `from` to `to` (YYYY-MM-DD), negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** `date` (YYYY-MM-DD) plus `days`, as YYYY-MM-DD. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A payment: money received from a customer or sent to a vendor through a cash or bank journal. Posting creates
 * and posts its entry (the journal's account against the receivable / payable) and matches the receivable /
 * payable line with the documents it pays (`payments.ts`).
 */
/**
 * A withholding at payment (RFC 0016 §5.1): VAT or income tax that the payer keeps back and pays to the state, such as
 * Bangladesh's VDS and TDS. `vendor`: we withhold when paying a vendor's bill (the account is a liability to the
 * state). `customer`: a customer withholds from us when paying our invoice (the account is a receivable from the
 * state). The base is the documents' untaxed amount, their tax or their total; it applies from a document total.
 */
export const AccountWithholding = defineModel('account.withholding', {
  label: 'Withholding',
  order: ['sequence asc', 'name asc'],
  archivable: true,
  companyScoped: { required: true },
  access: { 'account.invoicing': READ, 'account.user': READ, 'account.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    sequence: f.integer({ required: true, default: 10 }),
    direction: f.selection(
      { vendor: 'We withhold when paying vendors', customer: 'Customers withhold from us' },
      { required: true, default: 'vendor' },
    ),
    base: f.selection(
      { untaxed: 'Untaxed amount', tax: 'Tax amount', total: 'Total' },
      { required: true, default: 'untaxed', label: 'Computed on' },
    ),
    /** 0.05 for 5 %. */
    rate: f.decimal({ scale: 4, required: true, default: '0' }),
    /** A document whose total is below it is not withheld from. */
    threshold: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Applies from (document total)',
    }),
    account: f.many2one('account.account', { required: true, checkCompany: true }),
  },
  constraints: {
    rateRange: {
      ...check('account.withholding', ['rate'], (ws) =>
        ws.filter((w) => w.rate.lte(0) || w.rate.gt(1)),
      ),
      message: 'A withholding rate is above 0 and at most 1 (0.05 for 5 %).',
    },
  },
});

/** The withholdings that apply to a partner (vendor or customer): what a payment of their documents proposes. */
export const PartnerWithholdings = extendModel('res.partner', {
  fields: {
    withholdings: f.many2many('account.withholding', {
      relation: 'res_partner_withholding_rel',
      label: 'Withholdings',
    }),
  },
});

/** What a payment withheld: the withholding, the base and the amount, in the payment's currency. */
export const AccountPaymentWithholding = defineModel('account.payment.withholding', {
  label: 'Payment withholding',
  access: { 'account.invoicing': WRITE, 'account.user': ALL, 'account.manager': ALL },
  fields: {
    payment: f.many2one('account.payment', { required: true, ondelete: 'cascade' }),
    withholding: f.many2one('account.withholding', { required: true, ondelete: 'restrict' }),
    currency: f.many2one('res.currency', {
      store: true,
      ...compute('account.payment.withholding', 'currency', ['payment.currency'], (lines) => {
        for (const l of lines) l.currency = l.payment.currency.id;
      }),
    }),
    base: f.monetary({ currency: 'currency', label: 'Base' }),
    amount: f.monetary({ currency: 'currency', required: true }),
  },
});

export const AccountPayment = defineModel('account.payment', {
  label: 'Payment',
  order: ['date desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'amount', 'partner'],
  access: { 'account.invoicing': WRITE, 'account.user': ALL, 'account.manager': ALL },
  rules: {
    all: {
      groups: ['account.invoicing', 'account.user', 'account.manager'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: {},
    },
  },
  fields: {
    /** The entry's number once posted. */
    name: f.char({
      required: true,
      store: true,
      label: 'Number',
      ...compute('account.payment', 'name', ['move.name'], (payments) => {
        for (const p of payments) p.name = p.move?.name ?? orm.UNNUMBERED;
      }),
    }),
    kind: f.selection(
      { inbound: 'Receive', outbound: 'Send' },
      { required: true, default: 'inbound', label: 'Direction' },
    ),
    partner: f.many2one('res.partner', { required: true, checkCompany: true }),
    journal: f.many2one('account.journal', { required: true, checkCompany: true }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    currency: f.many2one('res.currency', { required: true }),
    amount: f.monetary({ currency: 'currency', required: true }),
    memo: f.char(),
    /** The documents this payment settles (oldest due first); none: an open payment to match later. */
    documents: f.many2many('account.move', { label: 'Pays' }),
    /** Kept back from the documents (VDS, TDS): the documents are settled by `amount` plus these. */
    withholdings: f.one2many('account.payment.withholding', 'payment'),
    amountWithheld: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Withheld',
      ...compute('account.payment', 'amountWithheld', ['withholdings.amount'], (payments) => {
        for (const p of payments) p.amountWithheld = p.withholdings.sum('amount', p.currency);
      }),
    }),
    move: f.many2one('account.move', { label: 'Entry' }),
    state: f.state({
      states: { draft: 'Draft', posted: 'Posted', cancel: 'Cancelled' },
      initial: 'draft',
      transitions: {
        post: {
          from: ['draft'],
          to: 'posted',
          before: records('account.payment', (payments) => postPayments(payments)),
        },
        cancel: { from: ['draft'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
      tracking: true,
    }),
  },
  sqlConstraints: {
    amountPositive: { check: orm.sql`amount > 0`, message: 'A payment amount is positive.' },
  },
});

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
  version: '0.3.0',
  migrations: [
    {
      version: '0.2.0',
      description: 'Several taxes per line: the single tax of each line becomes its first',
      up: async (ctx) => {
        await ctx.sql`INSERT INTO account_move_line_account_tax_rel (account_move_line_id, account_tax_id)
          SELECT id, tax_id FROM account_move_line WHERE tax_id IS NOT NULL ON CONFLICT DO NOTHING`;
      },
    },
  ],
  depends: [contactsShutro, productShutro, messagingShutro, permissionsShutro, reportingShutro],
  groups: [
    orm.defineGroup({
      code: 'account.invoicing',
      label: 'Invoicing',
      implies: ['contacts.user', 'product.user', 'messaging.user', 'reporting.user'],
    }),
    orm.defineGroup({ code: 'account.user', label: 'Accountant', implies: ['account.invoicing'] }),
    orm.defineGroup({
      code: 'account.manager',
      label: 'Accounting manager',
      implies: ['account.user', 'product.manager'],
    }),
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
    ResBankAccount,
    AccountWithholding,
    AccountAccount,
    AccountJournal,
    AccountFiscalYear,
    AccountPaymentTerm,
    AccountPaymentTermLine,
    AccountMove,
    AccountMoveLine,
    AccountPartialReconcile,
    AccountFullReconcile,
    AccountPayment,
    AccountPaymentWithholding,
    AccountTaxComponent,
  ],
  permissions: [
    orm.definePermission({ code: 'account.post', label: 'Post entries', groups: ['account.user'] }),
    orm.definePermission({
      code: 'account.reconcile',
      label: 'Reconcile and unreconcile',
      groups: ['account.user'],
    }),
    orm.definePermission({
      code: 'account.close',
      label: 'Close and reopen fiscal years',
      groups: ['account.manager'],
    }),
    orm.definePermission({
      code: 'account.settings',
      label: 'Change the accounting settings',
      groups: ['account.manager'],
    }),
  ],
  // Payment terms every installation starts with (shared; theirs to change afterwards).
  data: [
    record(
      'account.payment.term',
      'term_immediate',
      { name: 'Immediate payment' },
      { noupdate: true },
    ),
    record(
      'account.payment.term.line',
      'term_immediate_line',
      { term: ref('account.payment.term', 'accounting.term_immediate'), days: 0, percent: '100' },
      { noupdate: true },
    ),
    record('account.payment.term', 'term_15', { name: '15 days' }, { noupdate: true }),
    record(
      'account.payment.term.line',
      'term_15_line',
      { term: ref('account.payment.term', 'accounting.term_15'), days: 15, percent: '100' },
      { noupdate: true },
    ),
    record('account.payment.term', 'term_30', { name: '30 days' }, { noupdate: true }),
    record(
      'account.payment.term.line',
      'term_30_line',
      { term: ref('account.payment.term', 'accounting.term_30'), days: 30, percent: '100' },
      { noupdate: true },
    ),
    record(
      'account.payment.term',
      'term_half',
      { name: '50 % now, 50 % in 30 days' },
      { noupdate: true },
    ),
    record(
      'account.payment.term.line',
      'term_half_now',
      { term: ref('account.payment.term', 'accounting.term_half'), days: 0, percent: '50' },
      { noupdate: true },
    ),
    record(
      'account.payment.term.line',
      'term_half_later',
      { term: ref('account.payment.term', 'accounting.term_half'), days: 30, percent: '50' },
      { noupdate: true },
    ),
  ],
  extensions: [CompanyAccounting, TaxAccounts, PartnerWithholdings],
});
