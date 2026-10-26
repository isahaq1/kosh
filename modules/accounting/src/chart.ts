/**
 * Charts of accounts (RFC 0009 §5.6): the generic template and the Bangladesh one (RFC 0008 decision 2; VAT accounts
 * follow the Mushak structure: output VAT, input VAT, VAT payable, AT, SD). Installing a template for a company
 * creates its accounts and journals, links the company's default accounts, and points the taxes at their accounts.
 * A template is applied once per company. Also here: the database triggers that keep posted entries immutable
 * below the ORM (raw SQL, deletes), created idempotently with the module's defaults.
 */
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import type { AccountType, JournalType } from './module.js';

export type ChartTemplate = 'generic' | 'bd';

interface AccountSpec {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly reconcile?: boolean;
}

/** Which accounts the company's defaults point to, by code. */
interface Defaults {
  readonly receivable: string;
  readonly payable: string;
  readonly exchangeGain: string;
  readonly exchangeLoss: string;
  readonly retainedEarnings: string;
  readonly bank: string;
  readonly cash: string;
  readonly income: string;
  readonly expense: string;
}

interface Chart {
  readonly label: string;
  readonly accounts: readonly AccountSpec[];
  readonly defaults: Defaults;
  /** Tax accounts by tax use: collected on sales, paid on purchases. */
  readonly taxAccounts: { readonly sale: string; readonly purchase: string };
}

const COMMON: readonly AccountSpec[] = [
  { code: '1000', name: 'Cash', type: 'asset_cash' },
  { code: '1010', name: 'Bank', type: 'asset_cash' },
  { code: '1100', name: 'Accounts receivable', type: 'asset_receivable', reconcile: true },
  { code: '1150', name: 'Prepayments', type: 'asset_prepayments' },
  { code: '1200', name: 'Inventory', type: 'asset_current' },
  { code: '1500', name: 'Property, plant and equipment', type: 'asset_fixed' },
  { code: '1590', name: 'Accumulated depreciation', type: 'asset_fixed' },
  { code: '2000', name: 'Accounts payable', type: 'liability_payable', reconcile: true },
  { code: '2100', name: 'Accrued liabilities', type: 'liability_current' },
  { code: '2500', name: 'Long-term loans', type: 'liability_non_current' },
  { code: '3000', name: 'Share capital', type: 'equity' },
  { code: '3100', name: 'Retained earnings', type: 'equity' },
  { code: '3200', name: 'Current year earnings', type: 'equity_unaffected' },
  { code: '4000', name: 'Sales', type: 'income' },
  { code: '4100', name: 'Service revenue', type: 'income' },
  { code: '4900', name: 'Other income', type: 'income_other' },
  { code: '4910', name: 'Exchange gain', type: 'income_other' },
  { code: '5000', name: 'Cost of goods sold', type: 'expense_direct_cost' },
  { code: '6000', name: 'Salaries', type: 'expense' },
  { code: '6100', name: 'Rent', type: 'expense' },
  { code: '6200', name: 'Utilities', type: 'expense' },
  { code: '6300', name: 'Office expenses', type: 'expense' },
  { code: '6400', name: 'Travel', type: 'expense' },
  { code: '6500', name: 'Bank charges', type: 'expense' },
  { code: '6600', name: 'Depreciation', type: 'expense_depreciation' },
  { code: '6900', name: 'Exchange loss', type: 'expense' },
  { code: '9999', name: 'Suspense', type: 'asset_current', reconcile: true },
];

const DEFAULTS: Defaults = {
  receivable: '1100',
  payable: '2000',
  exchangeGain: '4910',
  exchangeLoss: '6900',
  retainedEarnings: '3100',
  bank: '1010',
  cash: '1000',
  income: '4000',
  expense: '6300',
};

export const CHARTS: Readonly<Record<ChartTemplate, Chart>> = {
  generic: {
    label: 'Generic',
    accounts: [
      ...COMMON,
      { code: '2200', name: 'VAT collected', type: 'liability_current' },
      { code: '1300', name: 'VAT paid', type: 'asset_current' },
    ],
    defaults: DEFAULTS,
    taxAccounts: { sale: '2200', purchase: '1300' },
  },
  bd: {
    label: 'Bangladesh',
    accounts: [
      ...COMMON,
      // VAT and SD Act 2012 (Mushak): output and input VAT, the net payable, advance tax, supplementary duty.
      { code: '2200', name: 'Output VAT (Mushak)', type: 'liability_current' },
      { code: '1300', name: 'Input VAT (Mushak)', type: 'asset_current' },
      { code: '2210', name: 'VAT payable', type: 'liability_current' },
      { code: '1310', name: 'Advance tax (AT) receivable', type: 'asset_current' },
      { code: '2220', name: 'Supplementary duty (SD) payable', type: 'liability_current' },
      { code: '1320', name: 'Advance income tax (AIT) receivable', type: 'asset_current' },
      { code: '2230', name: 'Tax deducted at source (TDS) payable', type: 'liability_current' },
      { code: '2240', name: 'VAT deducted at source (VDS) payable', type: 'liability_current' },
    ],
    defaults: DEFAULTS,
    taxAccounts: { sale: '2200', purchase: '1300' },
  },
};

const JOURNALS: readonly {
  code: string;
  name: string;
  type: JournalType;
  account: keyof Defaults | null;
}[] = [
  { code: 'INV', name: 'Customer invoices', type: 'sale', account: 'income' },
  { code: 'BILL', name: 'Vendor bills', type: 'purchase', account: 'expense' },
  { code: 'CSH', name: 'Cash', type: 'cash', account: 'cash' },
  { code: 'BNK', name: 'Bank', type: 'bank', account: 'bank' },
  { code: 'MISC', name: 'Miscellaneous', type: 'general', account: null },
];

export interface ChartInstalled {
  readonly template: ChartTemplate;
  readonly accounts: number;
  readonly journals: number;
  readonly taxes: number;
}

/** Already-installed template of the environment's company, or null. */
export async function installedChart(env: Env): Promise<ChartTemplate | null> {
  const [company] = await env.model('res.company').browse([env.companyId]).load({});
  return company?.chartTemplate ?? null;
}

/**
 * Installs a template for the environment's company (once): accounts, journals, the company's default accounts,
 * and the tax accounts of the product module's taxes.
 * @throws {Error} when the company already has a chart (the caller turns it into a 409)
 */
export async function installChart(env: Env, template: ChartTemplate): Promise<ChartInstalled> {
  const chart = CHARTS[template];
  const company = env.companyRef;
  const existing = await installedChart(env);
  if (existing !== null) throw new ChartInstalledError(existing);
  const accounts = await env.model('account.account').create(
    chart.accounts.map((a) => ({
      code: a.code,
      name: a.name,
      type: a.type,
      reconcile: a.reconcile ?? false,
      company,
    })),
  );
  const byCode = new Map<string, number>();
  const rows = (await accounts.load({})).read(['id', 'code']);
  for (const r of rows) byCode.set(String(r['code']), r['id'] as number);
  const account = (code: string) => {
    const id = byCode.get(code);
    if (id === undefined) throw new Error(`Template ${template} names no account ${code}.`);
    return orm.asId(id, 'account.account');
  };
  const journals = await env.model('account.journal').create(
    JOURNALS.map((j) => ({
      code: j.code,
      name: j.name,
      type: j.type,
      company,
      defaultAccount: j.account === null ? null : account(chart.defaults[j.account]),
    })),
  );
  // The company's settings: the manager just proved the right to create the chart; companies are read-only to
  // everyone (base), so the link is written in system scope, audited with its reason.
  await env.asSuperuser({ reason: `install the ${template} chart of accounts` }, (su) =>
    su
      .model('res.company')
      .browse([company])
      .write({
        chartTemplate: template,
        accountReceivable: account(chart.defaults.receivable),
        accountPayable: account(chart.defaults.payable),
        accountExchangeGain: account(chart.defaults.exchangeGain),
        accountExchangeLoss: account(chart.defaults.exchangeLoss),
        accountRetainedEarnings: account(chart.defaults.retainedEarnings),
      }),
  );
  // The taxes (product module, shared by every company) get their accounts when they have none yet.
  const taxes = await env.model('account.tax').search({ where: { account: { isNull: true } } });
  let linked = 0;
  for (const t of await taxes.load({})) {
    await env
      .model('account.tax')
      .browse([t.id])
      .write({
        account: account(t.use === 'sale' ? chart.taxAccounts.sale : chart.taxAccounts.purchase),
      });
    linked += 1;
  }
  return { template, accounts: accounts.length, journals: journals.length, taxes: linked };
}

export class ChartInstalledError extends Error {
  readonly template: ChartTemplate;
  constructor(template: ChartTemplate) {
    super(`This company already has the ${template} chart of accounts.`);
    this.name = 'ChartInstalledError';
    this.template = template;
  }
}

/**
 * Posted entries and their lines are immutable at the database too: no delete, no change of the ledger columns,
 * by any transaction but the one that posted (`posted_tx`, recorded at posting). Columns outside the ledger (the
 * reversal link, reconciliation marks) stay open.
 */
export async function installImmutability(env: Env): Promise<void> {
  await env.sql`
    CREATE OR REPLACE FUNCTION account_move_immutable() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.state = 'posted' THEN
          RAISE EXCEPTION 'A posted entry cannot be deleted; reverse it instead.' USING ERRCODE = 'P0001';
        END IF;
        RETURN OLD;
      END IF;
      IF OLD.state = 'posted' AND OLD.posted_tx IS DISTINCT FROM pg_current_xact_id()::text AND (
        NEW.state IS DISTINCT FROM OLD.state OR NEW.name IS DISTINCT FROM OLD.name
        OR NEW.journal_id IS DISTINCT FROM OLD.journal_id OR NEW.date IS DISTINCT FROM OLD.date
        OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
        OR NEW.currency_id IS DISTINCT FROM OLD.currency_id OR NEW.rate IS DISTINCT FROM OLD.rate
        OR NEW.ref IS DISTINCT FROM OLD.ref OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
        OR NEW.posted_tx IS DISTINCT FROM OLD.posted_tx
      ) THEN
        RAISE EXCEPTION 'A posted entry cannot be changed; reverse it instead.' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`;
  await env.sql`
    CREATE OR REPLACE FUNCTION account_move_line_immutable() RETURNS trigger AS $$
    DECLARE move_state text; move_tx text;
    BEGIN
      SELECT state, posted_tx INTO move_state, move_tx FROM account_move WHERE id = OLD.move_id;
      IF move_state = 'posted' AND move_tx IS DISTINCT FROM pg_current_xact_id()::text THEN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'The lines of a posted entry cannot be deleted; reverse the entry instead.' USING ERRCODE = 'P0001';
        END IF;
        IF NEW.move_id IS DISTINCT FROM OLD.move_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
          OR NEW.partner_id IS DISTINCT FROM OLD.partner_id OR NEW.name IS DISTINCT FROM OLD.name
          OR NEW.debit IS DISTINCT FROM OLD.debit OR NEW.credit IS DISTINCT FROM OLD.credit
          OR NEW.amount_currency IS DISTINCT FROM OLD.amount_currency
          OR NEW.date_maturity IS DISTINCT FROM OLD.date_maturity THEN
          RAISE EXCEPTION 'The lines of a posted entry cannot be changed; reverse the entry instead.' USING ERRCODE = 'P0001';
        END IF;
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`;
  await env.sql`DROP TRIGGER IF EXISTS account_move_immutable ON account_move`;
  await env.sql`CREATE TRIGGER account_move_immutable BEFORE UPDATE OR DELETE ON account_move
    FOR EACH ROW EXECUTE FUNCTION account_move_immutable()`;
  await env.sql`DROP TRIGGER IF EXISTS account_move_line_immutable ON account_move_line`;
  await env.sql`CREATE TRIGGER account_move_line_immutable BEFORE UPDATE OR DELETE ON account_move_line
    FOR EACH ROW EXECUTE FUNCTION account_move_line_immutable()`;
}
