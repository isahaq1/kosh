/**
 * The data layer of the Bangladesh localization (RFC 0016 §5.3): the taxes under the VAT and Supplementary Duty Act
 * 2012 (VAT at the standard and reduced rates, exempt and zero-rated, supplementary duty charged before VAT, advance
 * tax on imports), and the tax identifiers of companies and contacts — the 13-digit BIN and the 12-digit TIN —
 * checked when saved. The taxes are data (`noupdate`: the company's to change); their accounts are set for each
 * company when the localization is installed.
 */
import { accountingShutro } from '@kosh/accounting';
import { contactsShutro } from '@kosh/contacts';
import { computeTaxes, taxRule } from '@kosh/product';
import { orm } from '@kosh/server/orm';
import { check, compute, defineModule, extendModel, f, record } from './.kosh/bindings.js';

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

/** What a tax is in the Mushak returns: the VAT's rate band, supplementary duty or advance tax. */
export const MUSHAK_KINDS = {
  standard: 'VAT, standard rate',
  reduced: 'VAT, reduced rate',
  zero: 'VAT, zero-rated',
  exempt: 'VAT exempt',
  sd: 'Supplementary duty',
  at: 'Advance tax',
} as const;
export type MushakKind = keyof typeof MUSHAK_KINDS;

export const TaxMushak = extendModel('account.tax', {
  fields: {
    /** Where the tax goes in the Mushak 6.1, 6.2 and 9.1 (RFC 0016 §5.3); a tax without it is not reported. */
    mushak: f.selection(MUSHAK_KINDS, { label: 'Mushak' }),
  },
});

const TAX_DEPENDS = [
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
  'taxes.mushak',
] as const;

type Decimal = ReturnType<typeof orm.toDecimal>;
interface MushakLine {
  readonly lineKind: string | null;
  readonly quantity: Decimal | null;
  readonly priceUnit: Decimal | null;
  readonly discount: Decimal | null;
  readonly taxes: Iterable<Parameters<typeof taxRule>[0] & { readonly mushak: string | null }>;
}

/** A product line's taxes, summed by Mushak kind (as Accounting computes them: after discount, in order). */
export function mushakAmounts(l: MushakLine): { sd: Decimal; vat: Decimal; total: Decimal } | null {
  if (l.lineKind !== 'product') return null;
  const taxes = [...l.taxes];
  const quantity = l.quantity ?? orm.toDecimal(1);
  const amount = quantity
    .times(l.priceUnit ?? 0)
    .times(orm.toDecimal(100).minus(l.discount ?? 0))
    .div(100);
  const result = computeTaxes(amount, quantity, taxes.map(taxRule));
  const kindOf = new Map(taxes.map((t) => [t.id, t.mushak]));
  let sd = orm.toDecimal(0);
  let vat = orm.toDecimal(0);
  for (const t of result.taxes) {
    const kind = kindOf.get(t.tax);
    if (kind === 'sd') sd = sd.plus(t.amount);
    else if (kind === 'standard' || kind === 'reduced' || kind === 'zero' || kind === 'exempt')
      vat = vat.plus(t.amount);
  }
  return { sd, vat, total: result.total };
}

export const LineMushak = extendModel('account.move.line', {
  fields: {
    /** A product line's supplementary duty (Mushak 6.3 and the registers). */
    sdAmount: f.monetary({
      currency: 'currency',
      store: true,
      label: 'SD',
      ...compute('account.move.line', 'sdAmount', [...TAX_DEPENDS], (lines) => {
        for (const l of lines) l.sdAmount = mushakAmounts(l)?.sd ?? null;
      }),
    }),
    /** A product line's VAT, on its price plus SD. */
    vatAmount: f.monetary({
      currency: 'currency',
      store: true,
      label: 'VAT',
      ...compute('account.move.line', 'vatAmount', [...TAX_DEPENDS], (lines) => {
        for (const l of lines) l.vatAmount = mushakAmounts(l)?.vat ?? null;
      }),
    }),
    /** A product line's price with all its taxes. */
    totalWithTaxes: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Total with taxes',
      ...compute('account.move.line', 'totalWithTaxes', [...TAX_DEPENDS], (lines) => {
        for (const l of lines) l.totalWithTaxes = mushakAmounts(l)?.total ?? null;
      }),
    }),
  },
});

const tax = (
  id: string,
  name: string,
  use: 'sale' | 'purchase',
  rate: string,
  mushak: MushakKind,
  extra: { readonly sequence?: number; readonly affectsBase?: boolean } = {},
) => record('account.tax', id, { name, use, rate, mushak, ...extra }, { noupdate: true });

/** The ids the taxes keep from before 0.2.0, when Products shipped them (moved here by its migration). */
export const TAXES = [
  // VAT: the standard 15 % and the reduced rates.
  tax('tax_sale_vat15', 'VAT 15%', 'sale', '0.15', 'standard'),
  tax('tax_sale_vat10', 'VAT 10%', 'sale', '0.10', 'reduced'),
  tax('tax_sale_vat7_5', 'VAT 7.5%', 'sale', '0.075', 'reduced'),
  tax('tax_sale_vat5', 'VAT 5%', 'sale', '0.05', 'reduced'),
  tax('tax_sale_exempt', 'VAT exempt', 'sale', '0', 'exempt'),
  tax('tax_sale_zero', 'VAT 0% (exports)', 'sale', '0', 'zero'),
  tax('tax_purchase_vat15', 'VAT 15% (purchases)', 'purchase', '0.15', 'standard'),
  tax('tax_purchase_vat5', 'VAT 5% (purchases)', 'purchase', '0.05', 'reduced'),
  tax('tax_purchase_exempt', 'VAT exempt (purchases)', 'purchase', '0', 'exempt'),
  // Supplementary duty: before VAT, which is charged on the price plus SD.
  tax('tax_sale_sd10', 'SD 10%', 'sale', '0.10', 'sd', { sequence: 1, affectsBase: true }),
  tax('tax_sale_sd20', 'SD 20%', 'sale', '0.20', 'sd', { sequence: 1, affectsBase: true }),
  tax('tax_sale_sd30', 'SD 30%', 'sale', '0.30', 'sd', { sequence: 1, affectsBase: true }),
  tax('tax_sale_sd45', 'SD 45%', 'sale', '0.45', 'sd', { sequence: 1, affectsBase: true }),
  // Advance tax on imports, recoverable against the VAT due.
  tax('tax_purchase_at5', 'AT 5% (imports)', 'purchase', '0.05', 'at', { sequence: 20 }),
];

export const l10nBdShutro = defineModule({
  name: 'l10n_bd',
  version: '0.1.0',
  depends: [accountingShutro, contactsShutro],
  models: [],
  extensions: [PartnerIdentifiers, CompanyIdentifiers, TaxMushak, LineMushak],
  data: TAXES,
});
