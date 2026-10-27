/**
 * The data layer of the Bangladesh localization (RFC 0016 §5.3): the taxes under the VAT and Supplementary Duty Act
 * 2012 (VAT at the standard and reduced rates, exempt and zero-rated, supplementary duty charged before VAT, advance
 * tax on imports), and the tax identifiers of companies and contacts — the 13-digit BIN and the 12-digit TIN —
 * checked when saved. The taxes are data (`noupdate`: the company's to change); their accounts are set for each
 * company when the localization is installed.
 */
import { accountingShutro } from '@kosh/accounting';
import { contactsShutro } from '@kosh/contacts';
import { check, defineModule, extendModel, f, record } from './.kosh/bindings.js';

const BIN = /^\d{13}$/;
const TIN = /^\d{12}$/;

export const PartnerIdentifiers = extendModel('res.partner', {
  fields: {
    /** Business Identification Number (VAT registration, 13 digits): on the tax invoice (Mushak 6.3). */
    bin: f.char({ size: 13, label: 'BIN' }),
    /** Taxpayer Identification Number (income tax, 12 digits). */
    tin: f.char({ size: 12, label: 'TIN' }),
  },
  constraints: {
    binFormat: {
      ...check('res.partner', ['bin'], (ps) =>
        ps.filter((p) => p.bin !== null && !BIN.test(p.bin)),
      ),
      message: 'A BIN has 13 digits.',
    },
    tinFormat: {
      ...check('res.partner', ['tin'], (ps) =>
        ps.filter((p) => p.tin !== null && !TIN.test(p.tin)),
      ),
      message: 'A TIN has 12 digits.',
    },
  },
});

export const CompanyIdentifiers = extendModel('res.company', {
  fields: {
    bin: f.char({ size: 13, label: 'BIN' }),
    tin: f.char({ size: 12, label: 'TIN' }),
  },
  constraints: {
    companyBinFormat: {
      ...check('res.company', ['bin'], (cs) =>
        cs.filter((c) => c.bin !== null && !BIN.test(c.bin)),
      ),
      message: 'A BIN has 13 digits.',
    },
    companyTinFormat: {
      ...check('res.company', ['tin'], (cs) =>
        cs.filter((c) => c.tin !== null && !TIN.test(c.tin)),
      ),
      message: 'A TIN has 12 digits.',
    },
  },
});

const tax = (
  id: string,
  name: string,
  use: 'sale' | 'purchase',
  rate: string,
  extra: { readonly sequence?: number; readonly affectsBase?: boolean } = {},
) => record('account.tax', id, { name, use, rate, ...extra }, { noupdate: true });

/** The ids the taxes keep from before 0.2.0, when Products shipped them (moved here by its migration). */
export const TAXES = [
  // VAT: the standard 15 % and the reduced rates.
  tax('tax_sale_vat15', 'VAT 15%', 'sale', '0.15'),
  tax('tax_sale_vat10', 'VAT 10%', 'sale', '0.10'),
  tax('tax_sale_vat7_5', 'VAT 7.5%', 'sale', '0.075'),
  tax('tax_sale_vat5', 'VAT 5%', 'sale', '0.05'),
  tax('tax_sale_exempt', 'VAT exempt', 'sale', '0'),
  tax('tax_sale_zero', 'VAT 0% (exports)', 'sale', '0'),
  tax('tax_purchase_vat15', 'VAT 15% (purchases)', 'purchase', '0.15'),
  tax('tax_purchase_vat5', 'VAT 5% (purchases)', 'purchase', '0.05'),
  tax('tax_purchase_exempt', 'VAT exempt (purchases)', 'purchase', '0'),
  // Supplementary duty: before VAT, which is charged on the price plus SD.
  tax('tax_sale_sd10', 'SD 10%', 'sale', '0.10', { sequence: 1, affectsBase: true }),
  tax('tax_sale_sd20', 'SD 20%', 'sale', '0.20', { sequence: 1, affectsBase: true }),
  tax('tax_sale_sd30', 'SD 30%', 'sale', '0.30', { sequence: 1, affectsBase: true }),
  tax('tax_sale_sd45', 'SD 45%', 'sale', '0.45', { sequence: 1, affectsBase: true }),
  // Advance tax on imports, recoverable against the VAT due.
  tax('tax_purchase_at5', 'AT 5% (imports)', 'purchase', '0.05', { sequence: 20 }),
];

export const l10nBdShutro = defineModule({
  name: 'l10n_bd',
  version: '0.1.0',
  depends: [accountingShutro, contactsShutro],
  models: [],
  extensions: [PartnerIdentifiers, CompanyIdentifiers],
  data: TAXES,
});
