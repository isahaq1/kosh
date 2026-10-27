/**
 * Charts of accounts (RFC 0009 §5.6) and localizations (RFC 0016 §5.2): the generic template lives here; a country's
 * comes with its localization module (`l10n_bd`). Installing a template for a company creates its accounts and
 * journals, links the company's default accounts, and points the taxes at their accounts; installing a
 * localization also sets the accounts of its own taxes, its withholdings, the fiscal year and the number grouping.
 * Each is applied once per company. Also here: the database triggers that keep posted entries immutable below the
 * ORM (raw SQL, deletes), created idempotently with the module's defaults.
 */
import type { KoshModule, LocalizationSpec } from '@kosh/modules-sdk';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { type AccountType, fiscalYearOf, type JournalType } from './module.js';

/** A chart's code: `generic`, or a localization's key (`bd`). */
export type ChartTemplate = string;

export interface AccountSpec {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly reconcile?: boolean;
}

/** Which accounts the company's defaults point to, by code. */
export interface Defaults {
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

export interface Chart {
  readonly label: string;
  readonly accounts: readonly AccountSpec[];
  readonly defaults: Defaults;
  /** Tax accounts by tax use: collected on sales, paid on purchases. */
  readonly taxAccounts: { readonly sale: string; readonly purchase: string };
}

/** The accounts every chart starts from (a localization adds its own). */
export const COMMON_ACCOUNTS: readonly AccountSpec[] = [
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

/** The default accounts of the common set, by code. */
export const DEFAULT_ACCOUNTS: Defaults = {
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

/** The charts Accounting ships: the generic one. Countries bring theirs (`chartsOf`). */
export const CHARTS: Readonly<Record<string, Chart>> = {
  generic: {
    label: 'Generic',
    accounts: [
      ...COMMON_ACCOUNTS,
      { code: '2200', name: 'VAT collected', type: 'liability_current' },
      { code: '1300', name: 'VAT paid', type: 'asset_current' },
    ],
    defaults: DEFAULT_ACCOUNTS,
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

/** Every chart the installed modules offer: the generic one and the localizations'. */
export function chartsOf(modules: readonly KoshModule[]): ReadonlyMap<string, Chart> {
  const out = new Map<string, Chart>(Object.entries(CHARTS));
  for (const m of modules) {
    const l = m.localization;
    if (l !== undefined)
      out.set(l.key, { ...(l.chart as unknown as Omit<Chart, 'label'>), label: l.label });
  }
  return out;
}

/** The localizations of the installed modules, by key. */
export function localizationsOf(
  modules: readonly KoshModule[],
): ReadonlyMap<string, LocalizationSpec> {
  return new Map(
    modules.flatMap((m) =>
      m.localization === undefined ? [] : [[m.localization.key, m.localization]],
    ),
  );
}

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
export async function installChart(
  env: Env,
  template: ChartTemplate,
  chart: Chart = CHARTS[template] as Chart,
): Promise<ChartInstalled> {
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

export interface LocalizationInstalled {
  readonly localization: string;
  /** The chart, when the company had none yet. */
  readonly chart: ChartInstalled | null;
  readonly taxes: number;
  readonly withholdings: number;
  readonly fiscalYear: string | null;
}

/**
 * Sets a company up for a country (RFC 0016 §5.2), once and idempotently: its chart (unless it has one), the
 * accounts of the localization's taxes, its withholdings (those it lacks, by name), the fiscal year's first month and
 * the number grouping, and the current fiscal year when there is none. Everything is the company's data afterwards.
 */
export async function installLocalization(
  env: Env,
  localization: LocalizationSpec,
): Promise<LocalizationInstalled> {
  const company = env.companyRef;
  const chartSpec = {
    ...(localization.chart as unknown as Omit<Chart, 'label'>),
    label: localization.label,
  };
  const chart =
    (await installedChart(env)) === null
      ? await installChart(env, localization.key, chartSpec)
      : null;
  const accountOf = async (code: string) => {
    const found = await env.model('account.account').search({ where: { code, company }, limit: 1 });
    const id = found.ids[0];
    if (id === undefined)
      throw new Error(`The ${localization.label} chart has no account ${code}.`);
    return id;
  };
  let taxes = 0;
  for (const [externalId, code] of Object.entries(localization.taxes ?? {})) {
    let tax: number;
    try {
      tax = Number(await env.refId('account.tax', externalId));
    } catch (error) {
      if (error instanceof orm.UnknownExternalIdError) continue; // removed by the users
      throw error;
    }
    await env
      .model('account.tax')
      .browse([orm.asId(tax, 'account.tax')])
      .write({ account: await accountOf(code) });
    taxes += 1;
  }
  let withholdings = 0;
  for (const w of localization.withholdings ?? []) {
    const exists = await env
      .model('account.withholding')
      .search({ where: { name: w.name, company }, limit: 1 });
    if (exists.length > 0) continue;
    await env.model('account.withholding').create([
      {
        name: w.name,
        direction: w.direction,
        base: w.base,
        rate: w.rate,
        threshold: w.threshold ?? '0',
        account: await accountOf(w.account),
        company,
      },
    ]);
    withholdings += 1;
  }
  const start = localization.fiscalYearStart ?? 1;
  await env.asSuperuser({ reason: `localize the company for ${localization.label}` }, (su) =>
    su
      .model('res.company')
      .browse([company])
      .write({ fiscalYearStart: start, numberGrouping: localization.grouping ?? 'international' }),
  );
  let fiscalYear: string | null = null;
  const years = await env.model('account.fiscal.year').search({ where: { company }, limit: 1 });
  if (years.length === 0) {
    const { dateFrom, dateTo } = fiscalYearOf(env.today(), start);
    const [y, m] = dateFrom.split('-').map(Number) as [number, number];
    fiscalYear = m === 1 ? String(y) : `${y}–${String(y + 1).slice(2)}`;
    await env
      .model('account.fiscal.year')
      .create([{ name: fiscalYear, dateFrom, dateTo, company }]);
  }
  await env.flush(); // the checks run in the caller's scope, not at commit (Shutro request #11)
  return { localization: localization.key, chart, taxes, withholdings, fiscalYear };
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
