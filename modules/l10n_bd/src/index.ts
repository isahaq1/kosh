/**
 * @packageDocumentation
 * `@kosh/l10n_bd` (RFC 0016 §5.3): Kosh for a company in Bangladesh. Installing it sets each company without a chart
 * up for the country: the chart of accounts (output and input VAT, VAT payable, advance tax, supplementary duty,
 * AIT, TDS and VDS), the accounts of the VAT, SD and AT taxes, the VDS and TDS withholdings, a July–June fiscal year
 * and lakh / crore grouping. Contacts and companies get their BIN and TIN, checked.
 *
 * Rates are those of the VAT and Supplementary Duty Act 2012 and the income tax rules as commonly applied; the
 * withholding rates in particular change with each Finance Act: check them in Accounting › Configuration.
 */
import {
  accounting,
  COMMON_ACCOUNTS,
  DEFAULT_ACCOUNTS,
  installedChart,
  installLocalization,
} from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
import { defineModule, type KoshModule, type LocalizationSpec } from '@kosh/modules-sdk';
import { field } from '@kosh/views';
import { MUSHAK_DOCUMENTS } from './documents.js';
import { l10nBdShutro } from './module.js';
import { registerMushakRoutes } from './routes.js';

export { MUSHAK_DOCUMENTS } from './documents.js';
export {
  CompanyIdentifiers,
  LineMushak,
  l10nBdShutro,
  MUSHAK_KINDS,
  type MushakKind,
  mushakAmounts,
  PartnerIdentifiers,
  TAXES,
  TaxMushak,
} from './module.js';
export {
  type Band,
  MonthError,
  monthRange,
  type RegisterRow,
  type Return91,
  register,
  return91,
  type Side,
  VAT_CATEGORIES,
  type VatCategory,
} from './mushak.js';
export { type MushakForm, registerMushakRoutes } from './routes.js';

/** Bangladesh, as Accounting installs it for a company. */
export const BANGLADESH: LocalizationSpec = {
  key: 'bd',
  country: 'BD',
  label: 'Bangladesh',
  chart: {
    accounts: [
      ...COMMON_ACCOUNTS,
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
    defaults: DEFAULT_ACCOUNTS,
    taxAccounts: { sale: '2200', purchase: '1300' },
  },
  taxes: {
    'l10n_bd.tax_sale_vat15': '2200',
    'l10n_bd.tax_sale_vat10': '2200',
    'l10n_bd.tax_sale_vat7_5': '2200',
    'l10n_bd.tax_sale_vat5': '2200',
    'l10n_bd.tax_sale_exempt': '2200',
    'l10n_bd.tax_sale_zero': '2200',
    'l10n_bd.tax_purchase_vat15': '1300',
    'l10n_bd.tax_purchase_vat5': '1300',
    'l10n_bd.tax_purchase_exempt': '1300',
    'l10n_bd.tax_sale_sd10': '2220',
    'l10n_bd.tax_sale_sd20': '2220',
    'l10n_bd.tax_sale_sd30': '2220',
    'l10n_bd.tax_sale_sd45': '2220',
    'l10n_bd.tax_purchase_at5': '1310',
  },
  withholdings: [
    // VDS: a withholding entity keeps back the VAT of a bill and pays it to the NBR (Mushak 6.6).
    { name: 'VDS (the full VAT)', direction: 'vendor', base: 'tax', rate: '1', account: '2240' },
    // TDS (income tax at source) on payments to suppliers and for services: typical rates.
    {
      name: 'TDS 5% (supplies)',
      direction: 'vendor',
      base: 'untaxed',
      rate: '0.05',
      account: '2230',
    },
    {
      name: 'TDS 10% (services)',
      direction: 'vendor',
      base: 'untaxed',
      rate: '0.10',
      account: '2230',
    },
    // What customers deduct from our invoices as advance income tax.
    {
      name: 'AIT deducted by customers 3%',
      direction: 'customer',
      base: 'untaxed',
      rate: '0.03',
      account: '1320',
    },
  ],
  fiscalYearStart: 7,
  grouping: 'lakh',
};

/** Sets up the company of `env` for Bangladesh when it has no chart yet, or completes a Bangladesh setup. */
async function localize(raw: unknown): Promise<string | undefined> {
  // Accounting's environment: the installer reads Accounting's models.
  const env = raw as Parameters<typeof installLocalization>[0];
  const companies = await env
    .model('res.company')
    .search({ where: { id: env.companyRef }, limit: 1 });
  if (companies.length === 0) return undefined; // no company yet (before installBase)
  const chart = await installedChart(env);
  if (chart !== null && chart !== BANGLADESH.key) return undefined; // another chart: the company's choice
  const done = await installLocalization(env, BANGLADESH);
  return done.chart === null
    ? undefined
    : `the Bangladesh chart (${done.chart.accounts} accounts), ${done.taxes} taxes, ${done.withholdings} withholdings`;
}

export const l10nBd: KoshModule = defineModule({
  shutro: l10nBdShutro,
  kosh: '^0.1.0',
  depends: [accounting, contacts],
  accessLevels: {
    manager: { label: 'Bangladesh localization', groups: ['account.manager'] },
  },
  localization: BANGLADESH,
  // The tax invoice, the credit note and the VDS certificate (printed when Reporting is installed).
  documents: MUSHAK_DOCUMENTS,
  hooks: { defaults: (env) => localize(env) },
  routes: registerMushakRoutes,
  // Accounting › Reporting › Mushak returns: the registers and the monthly return.
  actions: {
    'l10n_bd.action_mushak': {
      type: 'client',
      page: 'l10n_bd.Mushak',
      label: 'Mushak returns',
      visibleTo: ['account.user'],
    },
  },
  menus: [
    {
      id: 'l10n_bd.mushak',
      parent: 'accounting.reporting',
      label: 'Mushak returns',
      action: 'l10n_bd.action_mushak',
      sequence: 8,
    },
  ],
  // The BIN and TIN with a contact's identity, for contacts in Bangladesh.
  viewExtensions: [
    // Where a tax goes in the Mushak returns.
    {
      view: 'account.tax.form',
      operations: [{ append: 'main', nodes: [field({ field: 'mushak', id: 'mushak' })] }],
    },
    {
      view: 'res.partner.form',
      operations: [
        {
          append: 'identity',
          nodes: [
            field({ field: 'bin', id: 'bin', visibleWhen: { country: 'BD' } }),
            field({ field: 'tin', id: 'tin', visibleWhen: { country: 'BD' } }),
          ],
        },
      ],
    },
  ],
});
