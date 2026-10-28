/**
 * @packageDocumentation
 * `@kosh/l10n_in` (RFC 0016 step 5): Kosh for a company in India. Installing it sets each company without a chart up
 * for the country: the chart of accounts (CGST, SGST, IGST and cess payable and input credit, GST under reverse
 * charge, TDS), the accounts of the GST taxes and their components, the TDS withholdings, an April–March fiscal
 * year and lakh / crore grouping. Contacts and companies get their GSTIN and PAN, products their HSN / SAC code.
 * The company's state (Accounting › Settings) decides which invoices are within the state.
 *
 * Rates are those of the GST slabs and the income tax TDS sections as commonly applied; rates and thresholds change
 * with GST Council decisions and each Finance Act: check them in Accounting › Configuration.
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
import { GST_DOCUMENTS } from './documents.js';
import { CESS_RATES, GST_RATES, l10nInShutro } from './module.js';

export { GST_DOCUMENTS } from './documents.js';
export {
  CESS_RATES,
  CompanyGst,
  GST_RATES,
  GST_STATE_CODES,
  GST_TREATMENTS,
  type GstAmounts,
  gstAmounts,
  gstinCheckDigit,
  gstinProblem,
  LineGst,
  l10nInShutro,
  MoveGst,
  PartnerGst,
  ProductHsn,
  TAXES,
  TaxGst,
} from './module.js';

const id = (rate: string) => rate.replace('.', '_');

/** The accounts of every GST component: output tax on sales, input credit on purchases, both under reverse charge. */
function componentAccounts(): Record<string, string | { account: string; reverseCharge: string }> {
  const out: Record<string, string | { account: string; reverseCharge: string }> = {};
  const heads = [
    ['cgst', '2310', '1310', '2320'],
    ['sgst', '2311', '1311', '2321'],
    ['igst', '2312', '1312', '2322'],
  ] as const;
  for (const rate of GST_RATES)
    for (const [head, output, input] of heads) {
      out[`l10n_in.gst_sale_${id(rate)}_${head}`] = output;
      out[`l10n_in.gst_purchase_${id(rate)}_${head}`] = input;
    }
  for (const rate of ['5', '12', '18', '28'])
    for (const [head, , input, payable] of heads)
      out[`l10n_in.gst_rc_${id(rate)}_${head}`] = { account: input, reverseCharge: payable };
  return out;
}

/** India, as Accounting installs it for a company. */
export const INDIA: LocalizationSpec = {
  key: 'in',
  country: 'IN',
  label: 'India',
  chart: {
    accounts: [
      ...COMMON_ACCOUNTS,
      { code: '2310', name: 'CGST payable', type: 'liability_current' },
      { code: '2311', name: 'SGST / UTGST payable', type: 'liability_current' },
      { code: '2312', name: 'IGST payable', type: 'liability_current' },
      { code: '2313', name: 'Compensation cess payable', type: 'liability_current' },
      { code: '1310', name: 'CGST input credit', type: 'asset_current' },
      { code: '1311', name: 'SGST / UTGST input credit', type: 'asset_current' },
      { code: '1312', name: 'IGST input credit', type: 'asset_current' },
      { code: '1313', name: 'Compensation cess input credit', type: 'asset_current' },
      { code: '2320', name: 'CGST payable under reverse charge', type: 'liability_current' },
      { code: '2321', name: 'SGST payable under reverse charge', type: 'liability_current' },
      { code: '2322', name: 'IGST payable under reverse charge', type: 'liability_current' },
      { code: '2330', name: 'TDS payable', type: 'liability_current' },
      { code: '1330', name: 'TDS receivable', type: 'asset_current' },
    ],
    defaults: DEFAULT_ACCOUNTS,
    taxAccounts: { sale: '2312', purchase: '1312' },
  },
  taxes: Object.fromEntries(
    CESS_RATES.flatMap((r) => [
      [`l10n_in.cess_sale_${id(r)}`, '2313'],
      [`l10n_in.cess_purchase_${id(r)}`, '1313'],
    ]),
  ),
  components: componentAccounts(),
  withholdings: [
    // Income tax deducted at source when paying vendors (sections of the Income-tax Act; thresholds are annual or
    // per payment by section: check them, they are not applied per document here).
    {
      name: 'TDS 194C 1% (contractors, individuals)',
      direction: 'vendor',
      base: 'untaxed',
      rate: '0.01',
      account: '2330',
    },
    {
      name: 'TDS 194C 2% (contractors, others)',
      direction: 'vendor',
      base: 'untaxed',
      rate: '0.02',
      account: '2330',
    },
    {
      name: 'TDS 194J 10% (professional fees)',
      direction: 'vendor',
      base: 'untaxed',
      rate: '0.10',
      account: '2330',
    },
    {
      name: 'TDS 194J 2% (technical services)',
      direction: 'vendor',
      base: 'untaxed',
      rate: '0.02',
      account: '2330',
    },
    {
      name: 'TDS 194H 2% (commission)',
      direction: 'vendor',
      base: 'untaxed',
      rate: '0.02',
      account: '2330',
    },
    {
      name: 'TDS 194-I 10% (rent of buildings)',
      direction: 'vendor',
      base: 'untaxed',
      rate: '0.10',
      account: '2330',
    },
    // What customers deduct from our invoices (claimed against our income tax).
    {
      name: 'TDS deducted by customers 2%',
      direction: 'customer',
      base: 'untaxed',
      rate: '0.02',
      account: '1330',
    },
  ],
  fiscalYearStart: 4,
  grouping: 'lakh',
};

/** Sets up the company of `env` for India when it has no chart yet, or completes an India setup. */
async function localize(raw: unknown): Promise<string | undefined> {
  // Accounting's environment: the installer reads Accounting's models.
  const env = raw as Parameters<typeof installLocalization>[0];
  const companies = await env
    .model('res.company')
    .search({ where: { id: env.companyRef }, limit: 1 });
  if (companies.length === 0) return undefined; // no company yet (before installBase)
  const chart = await installedChart(env);
  if (chart !== null && chart !== INDIA.key) return undefined; // another chart: the company's choice
  const done = await installLocalization(env, INDIA);
  return done.chart === null
    ? undefined
    : `the India chart (${done.chart.accounts} accounts), ${done.taxes} taxes, ${done.withholdings} withholdings`;
}

export const l10nIn: KoshModule = defineModule({
  shutro: l10nInShutro,
  kosh: '^0.1.0',
  depends: [accounting, contacts],
  accessLevels: {
    manager: { label: 'India localization', groups: ['account.manager'] },
  },
  localization: INDIA,
  hooks: { defaults: (env) => localize(env) },
  // The tax invoice, the credit and debit notes (printed when Reporting is installed).
  documents: GST_DOCUMENTS,
  viewExtensions: [
    // The GSTIN and PAN with a contact's identity, for contacts in India.
    {
      view: 'res.partner.form',
      operations: [
        {
          append: 'identity',
          nodes: [
            field({ field: 'gstin', id: 'gstin', visibleWhen: { country: 'IN' } }),
            field({ field: 'pan', id: 'pan', visibleWhen: { country: 'IN' } }),
          ],
        },
      ],
    },
    // A product's HSN / SAC code.
    {
      view: 'product.product.form',
      operations: [{ append: 'identity', nodes: [field({ field: 'hsnCode', id: 'hsn_code' })] }],
    },
    // Where a tax goes in the GST returns.
    {
      view: 'account.tax.form',
      operations: [
        { append: 'main', nodes: [field({ field: 'gstTreatment', id: 'gst_treatment' })] },
      ],
    },
  ],
});
