/**
 * The data layer of the India localization (RFC 0016 step 5): GST at its rates as one tax per rate whose components
 * post CGST and SGST within a state or IGST between states and abroad (Accounting's tax components); compensation
 * cess; nil-rated, exempt, non-GST and zero-rated (exports under LUT) supplies; purchase taxes under reverse charge.
 * GSTIN and PAN on companies and contacts, checked (the GSTIN's check digit, its state against the contact's state,
 * its PAN); HSN and SAC codes on products. Product lines store their CGST, SGST, IGST and cess for the tax invoice.
 * The taxes are data (`noupdate`: the company's to change); their accounts are set when the localization installs.
 */
import { accountingShutro, supplyScope } from '@kosh/accounting';
import { contactsShutro } from '@kosh/contacts';
import { computeTaxes, productShutro, taxRule } from '@kosh/product';
import { orm } from '@kosh/server/orm';
import { check, compute, defineModule, extendModel, f, record, ref } from './.kosh/bindings.js';

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;

/** The GST state codes (the first two digits of a GSTIN) of each state's ISO 3166-2 code (old and new codes). */
export const GST_STATE_CODES: Readonly<Record<string, string>> = {
  'IN-JK': '01',
  'IN-HP': '02',
  'IN-PB': '03',
  'IN-CH': '04',
  'IN-UT': '05',
  'IN-UK': '05',
  'IN-HR': '06',
  'IN-DL': '07',
  'IN-RJ': '08',
  'IN-UP': '09',
  'IN-BR': '10',
  'IN-SK': '11',
  'IN-AR': '12',
  'IN-NL': '13',
  'IN-MN': '14',
  'IN-MZ': '15',
  'IN-TR': '16',
  'IN-ML': '17',
  'IN-AS': '18',
  'IN-WB': '19',
  'IN-JH': '20',
  'IN-OR': '21',
  'IN-OD': '21',
  'IN-CT': '22',
  'IN-CG': '22',
  'IN-MP': '23',
  'IN-GJ': '24',
  'IN-DH': '26',
  'IN-DN': '26',
  'IN-DD': '26',
  'IN-MH': '27',
  'IN-KA': '29',
  'IN-GA': '30',
  'IN-LD': '31',
  'IN-KL': '32',
  'IN-TN': '33',
  'IN-PY': '34',
  'IN-AN': '35',
  'IN-TG': '36',
  'IN-TS': '36',
  'IN-AP': '37',
  'IN-LA': '38',
};

/** The check digit of a GSTIN's first 14 characters (Luhn mod 36). */
export function gstinCheckDigit(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = CHARS.indexOf(first14[i] ?? '') * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36] as string;
}

/** Why a GSTIN is wrong for a party in `state`, or null. */
export function gstinProblem(gstin: string, state: string | null): string | null {
  if (!GSTIN.test(gstin))
    return 'A GSTIN has 15 characters: state code, PAN, entity number, Z, check digit.';
  if (gstinCheckDigit(gstin.slice(0, 14)) !== gstin[14]) return "The GSTIN's check digit is wrong.";
  const expected = state === null ? undefined : GST_STATE_CODES[state];
  if (expected !== undefined && gstin.slice(0, 2) !== expected)
    return `The GSTIN starts with ${gstin.slice(0, 2)}, but ${state} is state code ${expected}.`;
  return null;
}

export const PartnerGst = extendModel('res.partner', {
  fields: {
    /** GST identification number (15 characters): on the tax invoice and in GSTR-1. */
    gstin: f.char({ size: 15, label: 'GSTIN' }),
    /** Permanent account number (income tax, 10 characters). */
    pan: f.char({ size: 10, label: 'PAN' }),
  },
  constraints: {
    gstinValid: {
      ...check('res.partner', ['gstin', 'state'], (ps) =>
        ps.filter((p) => p.gstin !== null && gstinProblem(p.gstin, p.state) !== null),
      ),
      message: "The GSTIN is not valid (format, check digit, or a state other than the contact's).",
    },
    panFormat: {
      ...check('res.partner', ['pan'], (ps) =>
        ps.filter((p) => p.pan !== null && !PAN.test(p.pan)),
      ),
      message: 'A PAN is five letters, four digits and a letter (ABCDE1234F).',
    },
  },
});

export const CompanyGst = extendModel('res.company', {
  fields: {
    gstin: f.char({ size: 15, label: 'GSTIN' }),
    pan: f.char({ size: 10, label: 'PAN' }),
  },
  constraints: {
    companyGstinValid: {
      ...check('res.company', ['gstin', 'state'], (cs) =>
        cs.filter((c) => c.gstin !== null && gstinProblem(c.gstin, c.state) !== null),
      ),
      message: "The GSTIN is not valid (format, check digit, or a state other than the company's).",
    },
    companyPanFormat: {
      ...check('res.company', ['pan'], (cs) =>
        cs.filter((c) => c.pan !== null && !PAN.test(c.pan)),
      ),
      message: 'A PAN is five letters, four digits and a letter (ABCDE1234F).',
    },
  },
});

export const ProductHsn = extendModel('product.product', {
  fields: {
    /** HSN (goods: 4, 6 or 8 digits) or SAC (services: 6 digits from 99): on lines of the tax invoice and in GSTR-1. */
    hsnCode: f.char({ size: 8, label: 'HSN / SAC' }),
  },
  constraints: {
    hsnFormat: {
      ...check('product.product', ['hsnCode'], (ps) =>
        ps.filter((p) => p.hsnCode !== null && !/^(\d{4}|\d{6}|\d{8})$/.test(p.hsnCode)),
      ),
      message: 'An HSN code has 4, 6 or 8 digits; a SAC code 6 (from 99).',
    },
  },
});

/** How the returns treat a tax (GSTR-1, GSTR-3B). */
export const GST_TREATMENTS = {
  taxable: 'GST (taxable)',
  nil: 'Nil-rated',
  exempt: 'Exempt',
  non_gst: 'Non-GST',
  zero_rated: 'Zero-rated (export under LUT)',
  cess: 'Compensation cess',
} as const;

export const TaxGst = extendModel('account.tax', {
  fields: {
    /** Where the returns put the tax; a tax without it is not in them. */
    gstTreatment: f.selection(GST_TREATMENTS, { label: 'GST treatment' }),
  },
});

type Decimal = ReturnType<typeof orm.toDecimal>;
const ZERO = orm.toDecimal(0);

const GST_DEPENDS = [
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
  'taxes.gstTreatment',
  'taxes.components.share',
  'taxes.components.scope',
  'taxes.components.code',
  'move.placeOfSupply',
  'move.partner.state',
  'move.partner.country',
  'move.company.state',
  'move.company.country',
] as const;

interface GstLine {
  readonly lineKind: string | null;
  readonly quantity: Decimal | null;
  readonly priceUnit: Decimal | null;
  readonly discount: Decimal | null;
  readonly taxes: Iterable<
    Parameters<typeof taxRule>[0] & {
      readonly gstTreatment: string | null;
      readonly components: Iterable<{
        readonly share: Decimal;
        readonly scope: string;
        readonly code: string | null;
      }>;
    }
  >;
  readonly move: {
    readonly placeOfSupply: string | null;
    readonly partner: { readonly state: string | null; readonly country: string | null } | null;
    readonly company: { readonly state: string | null; readonly country: string | null };
  };
}

export interface GstAmounts {
  readonly cgst: Decimal;
  readonly sgst: Decimal;
  readonly igst: Decimal;
  readonly cess: Decimal;
  /** The GST rate in percent (18 for GST 18 %). */
  readonly rate: Decimal;
  /** The line with the taxes the supplier charges. */
  readonly total: Decimal;
}

/** A product line's GST by head, split as posting splits it (by the document's place of supply). */
export function gstAmounts(l: GstLine): GstAmounts | null {
  if (l.lineKind !== 'product') return null;
  const taxes = [...l.taxes];
  const quantity = l.quantity ?? orm.toDecimal(1);
  const amount = quantity
    .times(l.priceUnit ?? 0)
    .times(orm.toDecimal(100).minus(l.discount ?? 0))
    .div(100);
  const result = computeTaxes(amount, quantity, taxes.map(taxRule));
  const partner = l.move.partner;
  const scope = supplyScope(
    l.move.company,
    partner?.country ?? null,
    l.move.placeOfSupply ?? partner?.state ?? null,
  );
  const heads = { cgst: ZERO, sgst: ZERO, igst: ZERO, cess: ZERO };
  let rate = ZERO;
  for (const t of result.taxes) {
    const tax = taxes.find((x) => x.id === t.tax);
    if (tax === undefined) continue;
    if (tax.gstTreatment === 'cess') {
      heads.cess = heads.cess.plus(t.amount);
      continue;
    }
    if (tax.gstTreatment === 'taxable') rate = rate.plus((tax.rate ?? ZERO).times(100));
    for (const c of tax.components) {
      if (c.scope !== 'always' && c.scope !== scope) continue;
      const head = (c.code ?? '').toLowerCase();
      if (head === 'cgst' || head === 'sgst' || head === 'igst')
        heads[head] = heads[head].plus(t.amount.times(c.share));
    }
  }
  const round = (d: Decimal) => d.toDecimalPlaces(2, orm.Decimal.ROUND_HALF_UP);
  return {
    cgst: round(heads.cgst),
    sgst: round(heads.sgst),
    igst: round(heads.igst),
    cess: round(heads.cess),
    rate,
    total: round(result.total),
  };
}

const head = (field: 'cgst' | 'sgst' | 'igst' | 'cess' | 'total', label: string) => {
  const name = (
    {
      cgst: 'cgstAmount',
      sgst: 'sgstAmount',
      igst: 'igstAmount',
      cess: 'cessAmount',
      total: 'totalWithGst',
    } as const
  )[field];
  return f.monetary({
    currency: 'currency',
    store: true,
    label,
    ...compute('account.move.line', name, [...GST_DEPENDS], (lines) => {
      for (const l of lines) l[name] = gstAmounts(l)?.[field] ?? null;
    }),
  });
};

export const LineGst = extendModel('account.move.line', {
  fields: {
    cgstAmount: head('cgst', 'CGST'),
    sgstAmount: head('sgst', 'SGST'),
    igstAmount: head('igst', 'IGST'),
    cessAmount: head('cess', 'Cess'),
    totalWithGst: head('total', 'Total with GST'),
    /** The line's GST rate, in percent. */
    gstRate: f.decimal({
      scale: 2,
      store: true,
      label: 'GST %',
      ...compute('account.move.line', 'gstRate', [...GST_DEPENDS], (lines) => {
        for (const l of lines) l.gstRate = gstAmounts(l)?.rate ?? null;
      }),
    }),
  },
});

export const MoveGst = extendModel('account.move', {
  fields: {
    /** A tax of the document is paid by the recipient (reverse charge): printed on the tax invoice. */
    gstReverseCharge: f.boolean({
      store: true,
      label: 'Reverse charge',
      ...compute(
        'account.move',
        'gstReverseCharge',
        ['lines.lineKind', 'lines.taxes.reverseCharge'],
        (moves) => {
          for (const m of moves)
            m.gstReverseCharge = [...m.lines].some(
              (l) => l.lineKind === 'product' && [...l.taxes].some((t) => t.reverseCharge),
            );
        },
      ),
    }),
  },
});

/** The GST rates (percent) of India's slabs. */
export const GST_RATES = ['0.25', '3', '5', '12', '18', '28'] as const;
/** Compensation cess rates (percent) commonly applied. */
export const CESS_RATES = ['1', '3', '12', '15', '22'] as const;

const pct = (rate: string) => `${rate}%`;
const half = (rate: string) => orm.toDecimal(rate).div(2).toString();
const fraction = (rate: string) => orm.toDecimal(rate).div(100).toString();
const idOf = (rate: string) => rate.replace('.', '_');

type Use = 'sale' | 'purchase';

/** One GST tax with its components: CGST and SGST within the state, IGST between states. */
function gst(use: Use, rate: string, options: { readonly reverseCharge?: boolean } = {}) {
  const kind = options.reverseCharge === true ? 'rc' : use;
  const id = `gst_${kind}_${idOf(rate)}`;
  const suffix =
    options.reverseCharge === true ? ' (reverse charge)' : use === 'purchase' ? ' (purchases)' : '';
  const tax = record(
    'account.tax',
    id,
    {
      name: `GST ${pct(rate)}${suffix}`,
      use,
      rate: fraction(rate),
      gstTreatment: 'taxable',
      reverseCharge: options.reverseCharge === true,
    },
    { noupdate: true },
  );
  const component = (code: 'CGST' | 'SGST' | 'IGST', share: string, scope: 'intra' | 'inter') =>
    record(
      'account.tax.component',
      `${id}_${code.toLowerCase()}`,
      {
        tax: ref('account.tax', `l10n_in.${id}`),
        name: `${code} ${pct(code === 'IGST' ? rate : half(rate))}${suffix}`,
        code,
        share,
        scope,
        sequence: code === 'CGST' ? 1 : code === 'SGST' ? 2 : 3,
      },
      { noupdate: true },
    );
  return [
    tax,
    component('CGST', '0.5', 'intra'),
    component('SGST', '0.5', 'intra'),
    component('IGST', '1', 'inter'),
  ];
}

const plain = (
  id: string,
  name: string,
  use: Use,
  treatment: keyof typeof GST_TREATMENTS,
  rate = '0',
) =>
  record(
    'account.tax',
    id,
    { name, use, rate, gstTreatment: treatment, ...(treatment === 'cess' ? { sequence: 20 } : {}) },
    { noupdate: true },
  );

export const TAXES = [
  ...GST_RATES.flatMap((r) => [...gst('sale', r), ...gst('purchase', r)]),
  // Purchases where the recipient pays the GST (services of advocates, goods transport, from unregistered suppliers…).
  ...(['5', '12', '18', '28'] as const).flatMap((r) => gst('purchase', r, { reverseCharge: true })),
  ...CESS_RATES.flatMap((r) => [
    plain(`cess_sale_${idOf(r)}`, `Cess ${pct(r)}`, 'sale', 'cess', fraction(r)),
    plain(
      `cess_purchase_${idOf(r)}`,
      `Cess ${pct(r)} (purchases)`,
      'purchase',
      'cess',
      fraction(r),
    ),
  ]),
  plain('gst_sale_nil', 'GST 0% (nil-rated)', 'sale', 'nil'),
  plain('gst_sale_exempt', 'GST exempt', 'sale', 'exempt'),
  plain('gst_sale_non_gst', 'Non-GST supply', 'sale', 'non_gst'),
  plain('gst_sale_lut', 'IGST 0% (export under LUT)', 'sale', 'zero_rated'),
  plain('gst_purchase_nil', 'GST 0% (nil-rated purchases)', 'purchase', 'nil'),
  plain('gst_purchase_exempt', 'GST exempt (purchases)', 'purchase', 'exempt'),
  plain('gst_purchase_non_gst', 'Non-GST purchase', 'purchase', 'non_gst'),
];

export const l10nInShutro = defineModule({
  name: 'l10n_in',
  version: '0.1.0',
  depends: [accountingShutro, contactsShutro, productShutro],
  models: [],
  extensions: [PartnerGst, CompanyGst, ProductHsn, TaxGst, LineGst, MoveGst],
  data: TAXES,
});
