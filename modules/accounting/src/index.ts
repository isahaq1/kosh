/**
 * @packageDocumentation
 * `@kosh/accounting` (RFC 0009): the Accounting app. The ledger core (step 1): chart of accounts (generic and
 * Bangladesh templates), journals, fiscal years and lock dates, currency rates, and journal entries posted in exact
 * money, numbered gaplessly per journal type, immutable once posted and corrected by reversal. The documents
 * (step 2): customer invoices, vendor bills and credit notes with product lines, taxes posting to their accounts,
 * payment terms and due dates, a PDF, and amount-based approvals of bills. Payments and reconciliation (step 3):
 * payments through cash and bank journals that settle documents, partial matches with residuals, exchange
 * differences, manual reconciliation and unreconciliation. The reports, year closing and the screens (step 4):
 * trial balance, ledgers, P&L, balance sheet and VAT as pivots over the journal items, aged balances, closing
 * and reopening a fiscal year, and the settings, reconciliation, aging and register-payment screens
 * (`@kosh/accounting/web`).
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { permissions } from '@kosh/permissions';
import { product } from '@kosh/product';
import { reporting } from '@kosh/reporting';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { action, field, form, list, pivot, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import {
  ChartInstalledError,
  type ChartTemplate,
  chartsOf,
  installChart,
  installedChart,
  installImmutability,
  installLocalization,
  localizationsOf,
} from './chart.js';
import {
  agingReport,
  closeFiscalYear,
  readSettings,
  reopenFiscalYear,
  updateSettings,
} from './closing.js';
import { accountingDemo } from './demo.js';
import {
  AccountAccount,
  AccountFiscalYear,
  AccountJournal,
  AccountMove,
  AccountMoveLine,
  AccountPayment,
  AccountPaymentTerm,
  AccountWithholding,
  accountingShutro,
  REVERSED_KIND,
  ResBankAccount,
  ResCurrencyRate,
} from './module.js';
import {
  openLines,
  proposeWithholdings,
  reconcile,
  registerPayment,
  unreconcile,
} from './payments.js';

export {
  type AccountSpec,
  CHARTS,
  type Chart,
  type ChartInstalled,
  ChartInstalledError,
  type ChartTemplate,
  COMMON_ACCOUNTS,
  chartsOf,
  DEFAULT_ACCOUNTS,
  type Defaults,
  installChart,
  installedChart,
  installImmutability,
  installLocalization,
  type LocalizationInstalled,
  localizationsOf,
} from './chart.js';
export {
  type AgingRow,
  agingReport,
  type Closed,
  closeFiscalYear,
  readSettings,
  reopenFiscalYear,
  type Settings,
  updateSettings,
} from './closing.js';
export {
  ACCOUNT_TYPES,
  AccountAccount,
  AccountFiscalYear,
  AccountFullReconcile,
  AccountJournal,
  AccountMove,
  AccountMoveLine,
  AccountPartialReconcile,
  AccountPayment,
  AccountPaymentTerm,
  AccountPaymentTermLine,
  AccountPaymentWithholding,
  AccountTaxComponent,
  type AccountType,
  AccountWithholding,
  accountingShutro,
  addDays,
  CompanyAccounting,
  fiscalYearOf,
  isRefund,
  JOURNAL_TYPES,
  type JournalType,
  MOVE_KINDS,
  type MoveKind,
  NUMBER_FIELD,
  owedToUs,
  PartnerWithholdings,
  REVERSED_KIND,
  ResBankAccount,
  ResCurrencyRate,
  type SupplyScope,
  supplyScope,
  TaxAccounts,
} from './module.js';
export {
  openLines,
  proposeWithholdings,
  type ReconcileResult,
  type RegisterInput,
  reconcile,
  registerPayment,
  unreconcile,
  type WithholdingProposal,
} from './payments.js';

export interface Reversed {
  readonly id: number;
  readonly name: string;
  readonly state: string;
}

/**
 * Reverses a posted entry: a new entry in the same journal with every line negated, linked both ways, posted when
 * asked. The original is never touched beyond its `reversedBy` link.
 */
export async function reverseMove(
  env: Env,
  id: number,
  options: { readonly date?: string | undefined; readonly post?: boolean | undefined } = {},
): Promise<Reversed> {
  const moves = env.model('account.move');
  const [m] = await moves.browse([id]).load({
    lines: { account: true, partner: true, product: true, taxes: true },
    journal: true,
    partner: true,
    currency: true,
    reversedBy: true,
  });
  if (m === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', `There is no entry ${id}.`);
  if (m.state !== 'posted')
    throw new HttpProblem(409, 'not-posted', 'Not posted', 'Only a posted entry is reversed.');
  if (m.reversedBy !== null)
    throw new HttpProblem(
      409,
      'already-reversed',
      'Already reversed',
      `Entry ${m.name} is reversed by ${m.reversedBy.name}.`,
    );
  const created = await moves.create([
    {
      journal: m.journal.id,
      date: options.date ?? env.today(),
      kind: REVERSED_KIND[m.kind],
      partner: m.partner?.id ?? null,
      currency: m.currency.id,
      rate: m.rate,
      ref: `Reversal of ${m.name}`,
      reversalOf: m.id,
      company: m.company.id,
      ...(m.kind === 'entry'
        ? {}
        : { invoiceOrigin: m.name, paymentTerm: m.paymentTerm?.id ?? null }),
      lines: {
        // An entry: every line negated. A document: its product lines as they were (the reversed kind flips the
        // sides, and posting generates the tax and counterpart lines again).
        create:
          m.kind === 'entry'
            ? m.lines.map((l) => ({
                account: l.account?.id ?? null,
                partner: l.partner?.id ?? null,
                name: l.name,
                debit: l.credit.amount,
                credit: l.debit.amount,
                amountCurrency:
                  l.amountCurrency === null ? null : l.amountCurrency.amount.negated(),
                dateMaturity: l.dateMaturity,
              }))
            : m.lines
                .filter((l) => l.lineKind === 'product')
                .map((l) => ({
                  lineKind: 'product' as const,
                  account: l.account?.id ?? null,
                  partner: l.partner?.id ?? null,
                  name: l.name,
                  product: l.product?.id ?? null,
                  quantity: l.quantity,
                  priceUnit: l.priceUnit,
                  discount: l.discount,
                  taxes: { set: [...l.taxes].map((t) => t.id) },
                  debit: '0',
                  credit: '0',
                })),
      },
    },
  ]);
  const reversalId = created.ids[0] as (typeof created.ids)[number];
  await moves.browse([m.id]).write({ reversedBy: reversalId });
  if (options.post === true) await created.post();
  const [reversal] = await created.load({});
  return {
    id: reversalId,
    name: reversal?.name ?? '/',
    state: reversal?.state ?? 'draft',
  };
}

export const accounting: ReturnType<typeof defineModule> = defineModule({
  shutro: accountingShutro,
  kosh: '^0.1.0',
  depends: [contacts, product, messaging, permissions, reporting],
  app: {
    code: 'accounting',
    label: 'Accounting',
    icon: 'accounting',
    sequence: 30,
    category: 'Finance',
    summary: 'Invoices, bills, journals and entries posted in exact money',
  },
  accessLevels: {
    invoicing: { label: 'Invoicing (invoices and their payments)', groups: ['account.invoicing'] },
    user: {
      label: 'Accountant (entries, reports)',
      groups: ['account.user'],
      implies: ['invoicing'],
    },
    manager: {
      label: 'Manager (chart, lock dates, closing)',
      groups: ['account.manager'],
      implies: ['user'],
    },
  },
  actions: {
    'accounting.action_customer_invoices': action(AccountMove, {
      label: 'Customer invoices',
      views: ['list', 'form'],
      viewIds: { list: 'account.move.invoice.list', form: 'account.move.invoice.form' },
      domain: { kind: { in: ['out_invoice', 'out_refund', 'out_debit'] } },
      defaults: { kind: 'out_invoice' },
    }),
    'accounting.action_vendor_bills': action(AccountMove, {
      label: 'Vendor bills',
      views: ['list', 'form'],
      viewIds: { list: 'account.move.invoice.list', form: 'account.move.invoice.form' },
      domain: { kind: { in: ['in_invoice', 'in_refund', 'in_debit'] } },
      defaults: { kind: 'in_invoice' },
    }),
    'accounting.action_moves': action(AccountMove, {
      label: 'Journal entries',
      views: ['list', 'form'],
      viewIds: { list: 'account.move.list', form: 'account.move.form' },
    }),
    'accounting.action_payments': action(AccountPayment, {
      label: 'Payments',
      views: ['list', 'form'],
    }),
    'accounting.action_trial_balance': action(AccountMoveLine, {
      label: 'Trial balance',
      views: ['pivot', 'list'],
      viewIds: { pivot: 'account.move.line.trial_balance' },
      domain: { posted: true },
    }),
    'accounting.action_general_ledger': action(AccountMoveLine, {
      label: 'General ledger',
      views: ['list', 'pivot'],
      viewIds: { pivot: 'account.move.line.trial_balance' },
      domain: { posted: true },
    }),
    'accounting.action_partner_ledger': action(AccountMoveLine, {
      label: 'Partner ledger',
      views: ['pivot', 'list'],
      viewIds: { pivot: 'account.move.line.partner_ledger' },
      domain: { posted: true, accountType: { in: ['asset_receivable', 'liability_payable'] } },
    }),
    'accounting.action_profit_loss': action(AccountMoveLine, {
      label: 'Profit and loss',
      views: ['pivot', 'graph', 'list'],
      viewIds: {
        pivot: 'account.move.line.profit_loss',
        graph: 'account.move.line.profit_loss_graph',
      },
      domain: {
        posted: true,
        accountType: {
          in: ['income', 'income_other', 'expense', 'expense_direct_cost', 'expense_depreciation'],
        },
      },
    }),
    'accounting.action_balance_sheet': action(AccountMoveLine, {
      label: 'Balance sheet',
      views: ['pivot', 'list'],
      viewIds: { pivot: 'account.move.line.balance_sheet' },
      domain: {
        posted: true,
        accountType: {
          in: [
            'asset_receivable',
            'asset_cash',
            'asset_current',
            'asset_prepayments',
            'asset_fixed',
            'asset_non_current',
            'liability_payable',
            'liability_current',
            'liability_non_current',
            'equity',
            'equity_unaffected',
          ],
        },
      },
    }),
    'accounting.action_vat': action(AccountMoveLine, {
      label: 'VAT',
      views: ['pivot', 'list'],
      viewIds: { pivot: 'account.move.line.vat' },
      domain: { posted: true, lineKind: { in: ['product', 'tax'] } },
    }),
    'accounting.action_aging': { type: 'client', page: 'accounting.Aging', label: 'Aged balances' },
    'accounting.action_reconcile': {
      type: 'client',
      page: 'accounting.Reconcile',
      label: 'Reconciliation',
    },
    'accounting.action_settings': {
      type: 'client',
      page: 'accounting.Settings',
      label: 'Settings',
      visibleTo: ['account.manager'],
    },
    'accounting.action_payment_terms': action(AccountPaymentTerm, {
      label: 'Payment terms',
      views: ['list', 'form'],
    }),
    'accounting.action_accounts': action(AccountAccount, {
      label: 'Chart of accounts',
      views: ['list', 'form'],
    }),
    'accounting.action_journals': action(AccountJournal, {
      label: 'Journals',
      views: ['list', 'form'],
    }),
    'accounting.action_fiscal_years': action(AccountFiscalYear, {
      label: 'Fiscal years',
      views: ['list', 'form'],
    }),
    'accounting.action_withholdings': action(AccountWithholding, {
      label: 'Withholdings',
      views: ['list', 'form'],
    }),
    'accounting.action_banks': action(ResBankAccount, {
      label: 'Bank accounts',
      views: ['list', 'form'],
    }),
    'accounting.action_rates': action(ResCurrencyRate, {
      label: 'Currency rates',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'accounting.root', label: 'Accounting', app: 'accounting' },
    {
      id: 'accounting.customer_invoices',
      parent: 'accounting.root',
      label: 'Customer invoices',
      action: 'accounting.action_customer_invoices',
      sequence: 1,
    },
    {
      id: 'accounting.vendor_bills',
      parent: 'accounting.root',
      label: 'Vendor bills',
      action: 'accounting.action_vendor_bills',
      sequence: 2,
    },
    {
      id: 'accounting.payments',
      parent: 'accounting.root',
      label: 'Payments',
      action: 'accounting.action_payments',
      sequence: 3,
    },
    {
      id: 'accounting.moves',
      parent: 'accounting.root',
      label: 'Journal entries',
      action: 'accounting.action_moves',
      sequence: 4,
    },
    {
      id: 'accounting.reconcile',
      parent: 'accounting.root',
      label: 'Reconciliation',
      action: 'accounting.action_reconcile',
      sequence: 5,
    },
    { id: 'accounting.reporting', parent: 'accounting.root', label: 'Reporting', sequence: 8 },
    {
      id: 'accounting.trial_balance',
      parent: 'accounting.reporting',
      label: 'Trial balance',
      action: 'accounting.action_trial_balance',
      sequence: 1,
    },
    {
      id: 'accounting.general_ledger',
      parent: 'accounting.reporting',
      label: 'General ledger',
      action: 'accounting.action_general_ledger',
      sequence: 2,
    },
    {
      id: 'accounting.partner_ledger',
      parent: 'accounting.reporting',
      label: 'Partner ledger',
      action: 'accounting.action_partner_ledger',
      sequence: 3,
    },
    {
      id: 'accounting.aging',
      parent: 'accounting.reporting',
      label: 'Aged balances',
      action: 'accounting.action_aging',
      sequence: 4,
    },
    {
      id: 'accounting.profit_loss',
      parent: 'accounting.reporting',
      label: 'Profit and loss',
      action: 'accounting.action_profit_loss',
      sequence: 5,
    },
    {
      id: 'accounting.balance_sheet',
      parent: 'accounting.reporting',
      label: 'Balance sheet',
      action: 'accounting.action_balance_sheet',
      sequence: 6,
    },
    {
      id: 'accounting.vat',
      parent: 'accounting.reporting',
      label: 'VAT',
      action: 'accounting.action_vat',
      sequence: 7,
    },
    {
      id: 'accounting.settings',
      parent: 'accounting.configuration',
      label: 'Settings',
      action: 'accounting.action_settings',
      sequence: 0,
    },
    {
      id: 'accounting.configuration',
      parent: 'accounting.root',
      label: 'Configuration',
      sequence: 9,
    },
    {
      id: 'accounting.accounts',
      parent: 'accounting.configuration',
      label: 'Chart of accounts',
      action: 'accounting.action_accounts',
      sequence: 1,
    },
    {
      id: 'accounting.journals',
      parent: 'accounting.configuration',
      label: 'Journals',
      action: 'accounting.action_journals',
      sequence: 2,
    },
    {
      id: 'accounting.fiscal_years',
      parent: 'accounting.configuration',
      label: 'Fiscal years',
      action: 'accounting.action_fiscal_years',
      sequence: 3,
    },
    {
      id: 'accounting.withholdings',
      parent: 'accounting.configuration',
      label: 'Withholdings',
      action: 'accounting.action_withholdings',
      sequence: 2.5,
    },
    {
      id: 'accounting.banks',
      parent: 'accounting.configuration',
      label: 'Bank accounts',
      action: 'accounting.action_banks',
      sequence: 3.5,
    },
    {
      id: 'accounting.rates',
      parent: 'accounting.configuration',
      label: 'Currency rates',
      action: 'accounting.action_rates',
      sequence: 4,
    },
    {
      id: 'accounting.payment_terms',
      parent: 'accounting.configuration',
      label: 'Payment terms',
      action: 'accounting.action_payment_terms',
      sequence: 5,
    },
  ],
  approvals: [
    {
      name: 'Vendor bill approvals',
      model: 'account.move',
      onApproved: 'post',
      onRejected: 'reject',
      levels: [
        {
          name: 'Accounting manager',
          condition: { kind: 'in_invoice', amountTotal: { gt: '100000' } },
          approverRole: 'account.manager',
        },
      ],
    },
  ],
  // Which withholdings apply to a contact (VDS, TDS), next to their roles (RFC 0016).
  viewExtensions: [
    // A tax's accounts, reverse charge's payable account, and its components (CGST / SGST / IGST).
    {
      view: 'account.tax.form',
      operations: [
        {
          insertAfter: 'amount',
          nodes: [
            {
              kind: 'group',
              id: 'tax_accounts',
              children: [
                field({ field: 'account', id: 'tax_account' }),
                field({ field: 'refundAccount', id: 'tax_refund_account' }),
                field({ field: 'reverseChargeAccount', id: 'tax_reverse_charge_account' }),
              ],
            },
            {
              kind: 'lines',
              id: 'components',
              field: 'components',
              columns: [
                field({ field: 'name', id: 'component_name' }),
                field({ field: 'code', id: 'component_code' }),
                field({ field: 'share', id: 'component_share' }),
                field({ field: 'scope', id: 'component_scope' }),
                field({ field: 'account', id: 'component_account' }),
                field({ field: 'refundAccount', id: 'component_refund_account' }),
                field({ field: 'reverseChargeAccount', id: 'component_reverse_charge_account' }),
              ],
            },
          ],
        },
      ],
    },
    {
      view: 'res.partner.form',
      operations: [
        { append: 'roles', nodes: [field({ field: 'withholdings', id: 'withholdings' })] },
      ],
    },
  ],
  documents: [
    {
      key: 'withholding_certificate',
      name: 'Withholding certificate',
      model: 'account.payment',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Certificate of withholding at source', level: 1 },
          {
            kind: 'fields',
            id: 'payment',
            items: [
              { label: 'Payment', bind: 'name' },
              { label: 'Date', bind: 'date' },
              { label: 'Paid to', bind: 'partner.name' },
              { label: 'Amount paid', bind: 'amount' },
              { label: 'Withheld', bind: 'amountWithheld' },
            ],
          },
          {
            kind: 'table',
            id: 'withheld',
            bind: 'withholdings',
            columns: [
              { label: 'Withholding', bind: 'withholding.name' },
              { label: 'Base', bind: 'base', align: 'end' },
              { label: 'Amount', bind: 'amount', align: 'end', sum: true },
            ],
          },
          { kind: 'text', id: 'in_words', text: 'Withheld: {{amountWithheld|words}}' },
        ],
      },
    },
    {
      key: 'invoice',
      name: 'Invoice',
      model: 'account.move',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: '{{kind}} {{name}}', level: 1 },
          {
            kind: 'columns',
            id: 'parties',
            left: [
              {
                kind: 'fields',
                id: 'partner',
                items: [
                  { label: 'Partner', bind: 'partner.name' },
                  { label: 'Reference', bind: 'ref' },
                  { label: 'Source', bind: 'invoiceOrigin' },
                ],
              },
            ],
            right: [
              {
                kind: 'fields',
                id: 'dates',
                items: [
                  { label: 'Date', bind: 'date' },
                  { label: 'Due date', bind: 'dateDue' },
                  { label: 'Payment terms', bind: 'paymentTerm.name' },
                ],
              },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'invoiceLines',
            columns: [
              { label: 'Description', bind: 'name' },
              { label: 'Quantity', bind: 'quantity', align: 'end' },
              { label: 'Unit price', bind: 'priceUnit', align: 'end' },
              { label: 'Discount %', bind: 'discount', align: 'end' },
              { label: 'Tax', bind: 'taxAmount', align: 'end' },
              { label: 'Subtotal', bind: 'subtotal', align: 'end', sum: true },
            ],
          },
          {
            kind: 'fields',
            id: 'totals',
            columns: 3,
            items: [
              { label: 'Untaxed', bind: 'amountUntaxed' },
              { label: 'Taxes', bind: 'amountTax' },
              { label: 'Total', bind: 'amountTotal' },
            ],
          },
          { kind: 'text', id: 'in_words', text: '{{amountTotal|words}}' },
          { kind: 'text', id: 'terms', text: '{{paymentTerm.note}}' },
          { kind: 'text', id: 'payment', text: '{{paymentDetails}}' },
          { kind: 'text', id: 'notes', text: '{{narration}}' },
        ],
      },
    },
  ],
  views: {
    'account.move.invoice.list': list(AccountMove, {
      columns: [
        'name',
        'partner',
        'date',
        'dateDue',
        'invoiceOrigin',
        { field: 'amountTotal', sum: true },
        { field: 'amountResidual', sum: true },
        { field: 'state', widget: 'badge' },
        { field: 'paymentState', widget: 'badge' },
      ],
      defaultOrder: ['date desc', 'name desc'],
    }),
    'account.move.invoice.form': form(AccountMove, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('submit', { label: 'Submit for approval' }),
          k.button('post', { primary: true, label: 'Confirm' }),
          k.button('reject', { label: 'Send back' }),
          k.button('cancel', { label: 'Cancel', confirm: 'Cancel this document?' }),
          k.button('redraft', { label: 'Set to draft' }),
        ],
      },
      sheet: [
        k.group('party', ['partner', 'kind', 'invoiceOrigin', 'ref', 'debitOf', 'placeOfSupply']),
        k.group('dates', ['date', 'dateDue', 'paymentTerm', 'journal']),
        k.lines(
          'lines',
          [
            'product',
            { field: 'name', id: 'line_name' },
            { field: 'account', id: 'line_account' },
            'quantity',
            'priceUnit',
            'discount',
            'taxes',
            'subtotal',
          ],
          { readonlyWhen: { state: { ne: 'draft' } } },
        ),
        k.group(
          'totals',
          [
            'amountUntaxed',
            'amountTax',
            'amountTotal',
            'amountResidual',
            { field: 'paymentState', widget: 'badge' },
            'payments',
          ],
          { label: 'Totals' },
        ),
        // The journal items of a document (taxes, the counterpart) are read in Journal entries.
        k.notebook('more', [
          k.page('money', 'Currency', ['currency', 'rate', 'reversalOf', 'reversedBy']),
          k.page('notes', 'Notes', ['narration']),
        ]),
        k.component('register_payment', 'accounting.RegisterPayment'),
        k.component('approvals', 'approvals.Panel'),
      ],
      readonlyWhen: { state: { ne: 'draft' } },
      chatter: true,
    })),
    'account.move.line.list': list(AccountMoveLine, {
      columns: [
        'date',
        'move',
        'account',
        'partner',
        'name',
        { field: 'debit', sum: true },
        { field: 'credit', sum: true },
        { field: 'balance', sum: true },
        'dateMaturity',
        'reconciled',
      ],
      defaultOrder: ['date asc', 'move asc', 'id asc'],
    }),
    'account.move.line.trial_balance': pivot(AccountMoveLine, {
      rows: ['account'],
      measures: [{ sum: 'debit' }, { sum: 'credit' }, { sum: 'balance' }],
      comparison: { field: 'date', mode: 'previous' },
    }),
    'account.move.line.partner_ledger': pivot(AccountMoveLine, {
      rows: ['partner', 'account'],
      measures: [
        { sum: 'debit' },
        { sum: 'credit' },
        { sum: 'balance' },
        { sum: 'amountResidual', label: 'Open' },
      ],
    }),
    'account.move.line.profit_loss': pivot(AccountMoveLine, {
      rows: ['accountType', 'account'],
      cols: ['date:month'],
      measures: [{ sum: 'balance' }],
      comparison: { field: 'date', mode: 'previous' },
    }),
    'account.move.line.profit_loss_graph': {
      type: 'graph',
      id: '',
      model: 'account.move.line',
      chart: 'bar',
      groupBy: ['date:month', 'accountType'],
      measure: { id: 'balance', measure: { sum: 'balance' } },
    },
    'account.move.line.balance_sheet': pivot(AccountMoveLine, {
      rows: ['accountType', 'account'],
      measures: [{ sum: 'balance' }],
      comparison: { field: 'date', mode: 'yoy' },
    }),
    // The tax lines of posted documents: each with the base its tax was computed on (SD in the VAT's base).
    'account.move.line.vat': pivot(AccountMoveLine, {
      rows: ['taxReport'],
      measures: [
        { sum: 'taxBase', label: 'Base' },
        { sum: 'balance', label: 'Amount' },
      ],
    }),
    'account.payment.list': list(AccountPayment, {
      columns: [
        'name',
        'date',
        'partner',
        'journal',
        { field: 'kind', widget: 'badge' },
        { field: 'amount', sum: true },
        { field: 'state', widget: 'badge' },
      ],
      defaultOrder: ['date desc', 'name desc'],
    }),
    'account.payment.form': form(AccountPayment, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('post', { primary: true, label: 'Confirm' }),
          k.button('cancel', { label: 'Cancel', confirm: 'Cancel this payment?' }),
          k.button('redraft', { label: 'Set to draft' }),
        ],
      },
      sheet: [
        k.group('who', ['partner', 'kind', 'journal', 'date']),
        k.group('how_much', ['currency', 'amount', 'amountWithheld', 'memo', 'move']),
        k.group('what', ['documents'], { label: 'Pays', columns: 1 }),
        k.lines(
          'withholdings',
          [
            { field: 'withholding', id: 'withheld_by' },
            { field: 'base', id: 'withheld_base' },
            { field: 'amount', id: 'withheld_amount' },
          ],
          {
            readonlyWhen: { state: { ne: 'draft' } },
          },
        ),
      ],
      readonlyWhen: { state: { ne: 'draft' } },
      chatter: true,
    })),
    'account.payment.term.list': list(AccountPaymentTerm, { columns: ['name'] }),
    'account.payment.term.form': form(AccountPaymentTerm, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name']),
        k.lines('lines', ['days', 'percent']),
        k.group('notes', ['note'], { columns: 1 }),
      ],
    })),
    'account.move.list': list(AccountMove, {
      columns: [
        'name',
        'date',
        'journal',
        'partner',
        'ref',
        { field: 'amountDebit', sum: true },
        { field: 'state', widget: 'badge' },
      ],
      defaultOrder: ['date desc', 'name desc'],
    }),
    'account.move.form': form(AccountMove, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('post', { primary: true, label: 'Post' }),
          k.button('cancel', { label: 'Cancel', confirm: 'Cancel this entry?' }),
          k.button('redraft', { label: 'Set to draft' }),
        ],
      },
      sheet: [
        k.group('main', ['journal', 'date', 'partner', 'ref']),
        k.group('money', ['currency', 'rate', 'kind', 'reversalOf', 'reversedBy']),
        k.lines(
          'lines',
          [
            'account',
            { field: 'partner', id: 'line_partner' },
            { field: 'name', id: 'line_name' },
            'debit',
            'credit',
            'amountCurrency',
            'dateMaturity',
          ],
          { readonlyWhen: { state: { ne: 'draft' } } },
        ),
        k.group('totals', ['amountDebit', 'amountCredit'], { label: 'Totals' }),
        k.group('notes', ['narration'], { columns: 1 }),
      ],
      readonlyWhen: { state: { ne: 'draft' } },
      chatter: true,
    })),
    'account.account.list': list(AccountAccount, {
      columns: ['code', 'name', 'type', 'reconcile', 'currency'],
      defaultOrder: ['code asc'],
      inlineEdit: ['name', 'reconcile'],
    }),
    'account.account.form': form(AccountAccount, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['code', 'name', 'type', 'reconcile', 'currency']),
        k.group('notes', ['note'], { columns: 1 }),
      ],
    })),
    'account.journal.list': list(AccountJournal, {
      columns: ['code', 'name', 'type', 'defaultAccount'],
    }),
    'account.journal.form': form(AccountJournal, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['code', 'name', 'type', 'defaultAccount'])],
    })),
    'account.fiscal.year.list': list(AccountFiscalYear, {
      columns: ['name', 'dateFrom', 'dateTo', { field: 'state', widget: 'badge' }, 'lockDate'],
    }),
    'account.fiscal.year.form': form(AccountFiscalYear, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'dateFrom', 'dateTo', 'state', 'lockDate'])],
    })),
    'account.withholding.list': list(AccountWithholding, {
      columns: ['name', 'direction', 'base', 'rate', 'threshold', 'account'],
    }),
    'account.withholding.form': form(AccountWithholding, (k) => ({
      sheet: [
        k.group('withholding', ['name', 'direction', 'sequence']),
        k.group('amount', ['base', 'rate', 'threshold', 'account']),
      ],
    })),
    'res.bank.account.list': list(ResBankAccount, {
      columns: ['bank', 'branch', 'number', 'routing', 'currency'],
    }),
    'res.bank.account.form': form(ResBankAccount, (k) => ({
      sheet: [
        k.group('bank_details', ['bank', 'branch', 'routing', 'swift']),
        k.group('account_details', ['number', 'holder', 'currency', 'sequence']),
      ],
    })),
    'res.currency.rate.list': list(ResCurrencyRate, {
      columns: ['date', 'currency', 'rate', 'company'],
      defaultOrder: ['date desc'],
      inlineEdit: ['rate'],
    }),
    'res.currency.rate.form': form(ResCurrencyRate, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['currency', 'date', 'rate', 'company'])],
    })),
  },
  search: {
    'account.move': search(AccountMove, {
      fields: ['name', 'ref', 'partner.name'],
      filters: {
        draft: { label: 'Draft', domain: { state: 'draft' }, group: 'state' },
        posted: { label: 'Posted', domain: { state: 'posted' }, group: 'state' },
        entries: { label: 'Journal entries', domain: { kind: 'entry' }, group: 'kind' },
        invoices: {
          label: 'Invoices and bills',
          domain: {
            kind: {
              in: ['out_invoice', 'out_refund', 'out_debit', 'in_invoice', 'in_refund', 'in_debit'],
            },
          },
          group: 'kind',
        },
      },
      groupBy: ['journal', 'state', 'partner', 'date:month', 'kind'],
    }),
    'account.move.line': search(AccountMoveLine, {
      fields: ['name', 'partner.name', 'account.code', 'account.name'],
      filters: {
        receivable: {
          label: 'Receivable',
          domain: { accountType: 'asset_receivable' },
          group: 'type',
        },
        payable: { label: 'Payable', domain: { accountType: 'liability_payable' }, group: 'type' },
        open: {
          label: 'Open items',
          domain: {
            reconciled: false,
            accountType: { in: ['asset_receivable', 'liability_payable'] },
          },
        },
      },
      groupBy: [
        'account',
        'partner',
        'accountType',
        'date:month',
        'date:year',
        'taxReport',
        'move',
      ],
    }),
    'account.payment': search(AccountPayment, {
      fields: ['name', 'memo', 'partner.name'],
      filters: {
        inbound: { label: 'Received', domain: { kind: 'inbound' }, group: 'kind' },
        outbound: { label: 'Sent', domain: { kind: 'outbound' }, group: 'kind' },
        posted: { label: 'Posted', domain: { state: 'posted' }, group: 'state' },
      },
      groupBy: ['journal', 'partner', 'state', 'date:month'],
    }),
    'account.account': search(AccountAccount, {
      fields: ['code', 'name'],
      filters: {
        receivable: { label: 'Receivable', domain: { type: 'asset_receivable' } },
        payable: { label: 'Payable', domain: { type: 'liability_payable' } },
      },
      groupBy: ['type'],
    }),
  },
  hooks: {
    // The immutability triggers, idempotent (with every seed and app install).
    defaults: async (env) => {
      await installImmutability(env as Env);
      return undefined;
    },
    demo: accountingDemo,
  },
  routes: (context: ModuleContext) => {
    // The charts: the generic one and the installed localizations' (RFC 0016).
    const charts = chartsOf(context.registry.loaded.modules);
    const localizations = localizationsOf(context.registry.loaded.modules);
    context.app.post('/api/v1/accounting/charts/install', async (request) => {
      const template = (request.body as { template?: unknown } | null)?.template;
      if (typeof template !== 'string' || !charts.has(template))
        throw new HttpProblem(
          400,
          'invalid-template',
          'Unknown chart template',
          `template must be one of ${[...charts.keys()].join(', ')}.`,
        );
      return request.env(
        async (env) => {
          try {
            const localization = localizations.get(template);
            if (localization === undefined)
              return await installChart(env as Env, template, charts.get(template));
            // A country's chart comes with the rest of its localization (taxes, withholdings, fiscal year).
            if ((await installedChart(env as Env)) !== null)
              throw new ChartInstalledError((await installedChart(env as Env)) as ChartTemplate);
            const done = await installLocalization(env as Env, localization);
            return { ...(done.chart as object), localization: done };
          } catch (error) {
            if (error instanceof ChartInstalledError)
              throw new HttpProblem(
                409,
                'chart-installed',
                'Chart already installed',
                error.message,
              );
            throw error;
          }
        },
        { write: true },
      );
    });
    context.app.get('/api/v1/accounting/charts', async (request) =>
      request.env(async (env) => ({
        installed: await installedChart(env as Env),
        templates: [...charts].map(([code, chart]) => ({ code, label: chart.label })),
      })),
    );
    // What a payment of these documents should withhold (RFC 0016): the register-payment dialog shows it first.
    const withholdingsOf = (input: unknown) => {
      if (input === undefined) return undefined;
      if (!Array.isArray(input))
        throw new HttpProblem(400, 'invalid-body', 'Invalid request', 'withholdings is a list.');
      return input.map((w) => {
        const row = (w ?? {}) as { withholding?: unknown; amount?: unknown };
        const withholding = Number(row.withholding);
        const amount = String(row.amount ?? '');
        if (!Number.isInteger(withholding) || withholding <= 0 || !/^\d+(\.\d+)?$/.test(amount))
          throw new HttpProblem(
            400,
            'invalid-body',
            'Invalid request',
            'Each withholding is { withholding: id, amount: "decimal" }.',
          );
        return { withholding, amount };
      });
    };
    context.app.post('/api/v1/accounting/payments/propose', async (request) => {
      const moves = (request.body as { moves?: unknown } | null)?.moves;
      const ids = Array.isArray(moves) ? moves.map(Number) : [];
      if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id <= 0))
        throw new HttpProblem(
          400,
          'invalid-body',
          'Invalid request',
          'moves is a list of document ids.',
        );
      return request.env((env) => proposeWithholdings(env as Env, ids));
    });
    context.app.post('/api/v1/accounting/payments/register', async (request) => {
      const body = (request.body ?? {}) as {
        moves?: unknown;
        journal?: unknown;
        date?: unknown;
        amount?: unknown;
        memo?: unknown;
        withholdings?: unknown;
      };
      const moves = Array.isArray(body.moves) ? body.moves.map(Number) : [];
      if (moves.length === 0 || moves.some((m) => !Number.isInteger(m) || m <= 0))
        throw new HttpProblem(
          400,
          'invalid-body',
          'Invalid request',
          'moves is a list of document ids.',
        );
      const journal = Number(body.journal);
      if (!Number.isInteger(journal) || journal <= 0)
        throw new HttpProblem(
          400,
          'invalid-body',
          'Invalid request',
          'journal is a cash or bank journal id.',
        );
      if (body.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date)))
        throw new HttpProblem(400, 'invalid-date', 'Invalid date', 'date is YYYY-MM-DD.');
      if (body.amount !== undefined && !/^\d+(\.\d+)?$/.test(String(body.amount)))
        throw new HttpProblem(
          400,
          'invalid-body',
          'Invalid request',
          'amount is a positive decimal string.',
        );
      return request.env(
        (env) =>
          registerPayment(env as Env, {
            moves,
            journal,
            date: body.date === undefined ? undefined : String(body.date),
            amount: body.amount === undefined ? undefined : String(body.amount),
            memo: body.memo === undefined ? undefined : String(body.memo),
            withholdings: withholdingsOf(body.withholdings),
          }),
        { write: true },
      );
    });
    const lineIds = (body: unknown): number[] => {
      const lines = (body as { lines?: unknown } | null)?.lines;
      const ids = Array.isArray(lines) ? lines.map(Number) : [];
      if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id <= 0))
        throw new HttpProblem(
          400,
          'invalid-body',
          'Invalid request',
          'lines is a list of journal item ids.',
        );
      return ids;
    };
    context.app.post('/api/v1/accounting/reconcile', async (request) => {
      const ids = lineIds(request.body);
      const writeOff = (request.body as { writeOff?: { account?: unknown; label?: unknown } })
        .writeOff;
      const options =
        writeOff === undefined
          ? {}
          : {
              writeOff: {
                account: Number(writeOff.account),
                ...(writeOff.label === undefined ? {} : { label: String(writeOff.label) }),
              },
            };
      if (options.writeOff !== undefined && !Number.isInteger(options.writeOff.account))
        throw new HttpProblem(
          400,
          'invalid-body',
          'Invalid request',
          'writeOff.account is an account id.',
        );
      return request.env((env) => reconcile(env as Env, ids, options), { write: true });
    });
    context.app.post('/api/v1/accounting/unreconcile', async (request) =>
      request.env((env) => unreconcile(env as Env, lineIds(request.body)), { write: true }),
    );
    context.app.get('/api/v1/accounting/open-items', async (request) => {
      const query = request.query as { account?: unknown; partner?: unknown };
      const account = Number(query.account);
      if (!Number.isInteger(account) || account <= 0)
        throw new HttpProblem(400, 'invalid-query', 'Invalid request', 'account is an account id.');
      const partner = query.partner === undefined ? undefined : Number(query.partner);
      return request.env(async (env) => {
        const found = await (env as Env).model('account.move.line').search({
          where: {
            account: account as never,
            reconciled: false,
            ...(partner === undefined ? {} : { partner: partner as never }),
          },
          order: ['dateMaturity asc', 'id asc'],
        });
        const posted = (await found.load({ move: true })).filter((l) => l.move.state === 'posted');
        const { lines } =
          posted.length === 0 ? { lines: [] } : await openLines(env as Env, posted.ids);
        return {
          items: lines.map((l) => ({
            id: l.id,
            partner: l.partner,
            dateMaturity: l.dateMaturity,
            residual: l.residual.toString(),
            residualCurrency: l.residualCurrency.toString(),
            currency: l.currency,
          })),
        };
      });
    });
    context.app.get('/api/v1/accounting/settings', async (request) =>
      request.env((env) => readSettings(env as Env)),
    );
    context.app.put('/api/v1/accounting/settings', async (request) => {
      const body = (request.body ?? {}) as {
        lockDate?: unknown;
        taxLockDate?: unknown;
        country?: unknown;
        state?: unknown;
      };
      const code = (v: unknown, name: string, pattern: RegExp, example: string) => {
        if (v === undefined) return undefined;
        if (v === null || v === '') return null;
        const value = String(v).toUpperCase();
        if (!pattern.test(value))
          throw new HttpProblem(
            400,
            'invalid-body',
            'Invalid request',
            `${name} is like ${example}.`,
          );
        return value;
      };
      const country = code(body.country, 'country', /^[A-Z]{2}$/, 'IN');
      const state = code(body.state, 'state', /^[A-Z]{2}-[A-Z0-9]{1,3}$/, 'IN-MH');
      const date = (v: unknown, name: string): string | null | undefined => {
        if (v === undefined) return undefined;
        if (v === null || v === '') return null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)))
          throw new HttpProblem(400, 'invalid-date', 'Invalid date', `${name} is YYYY-MM-DD.`);
        return String(v);
      };
      const lockDate = date(body.lockDate, 'lockDate');
      const taxLockDate = date(body.taxLockDate, 'taxLockDate');
      return request.env(
        (env) =>
          updateSettings(env as Env, {
            ...(lockDate === undefined ? {} : { lockDate }),
            ...(taxLockDate === undefined ? {} : { taxLockDate }),
            ...(country === undefined ? {} : { country }),
            ...(state === undefined ? {} : { state }),
          }),
        { write: true },
      );
    });
    context.app.post('/api/v1/accounting/fiscal-years/:id/close', async (request) => {
      const id = Number((request.params as { id: string }).id);
      if (!Number.isInteger(id))
        throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'The fiscal year id is an integer.');
      return request.env((env) => closeFiscalYear(env as Env, id), { write: true });
    });
    context.app.post('/api/v1/accounting/fiscal-years/:id/reopen', async (request) => {
      const id = Number((request.params as { id: string }).id);
      const reason = String((request.body as { reason?: unknown } | null)?.reason ?? '');
      if (!Number.isInteger(id))
        throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'The fiscal year id is an integer.');
      return request.env((env) => reopenFiscalYear(env as Env, id, reason), { write: true });
    });
    context.app.get('/api/v1/accounting/reports/aging', async (request) => {
      const query = request.query as { type?: unknown; date?: unknown };
      const type = query.type === 'payable' ? 'payable' : 'receivable';
      if (query.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(query.date)))
        throw new HttpProblem(400, 'invalid-date', 'Invalid date', 'date is YYYY-MM-DD.');
      return request.env((env) =>
        agingReport(env as Env, {
          type,
          date: query.date === undefined ? undefined : String(query.date),
        }),
      );
    });
    context.app.post('/api/v1/accounting/moves/:id/reverse', async (request) => {
      const id = Number((request.params as { id: string }).id);
      const body = (request.body ?? {}) as { date?: unknown; post?: unknown };
      if (!Number.isInteger(id))
        throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'The entry id is an integer.');
      if (body.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date)))
        throw new HttpProblem(400, 'invalid-date', 'Invalid date', 'date is YYYY-MM-DD.');
      return request.env(
        (env) =>
          reverseMove(env as Env, id, {
            date: body.date === undefined ? undefined : String(body.date),
            post: body.post === true,
          }),
        { write: true },
      );
    });
  },
});
