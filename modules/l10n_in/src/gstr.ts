/**
 * The GST returns of a month (RFC 0016 step 5, part 3), from the posted documents: GSTR-1 (outward supplies by the
 * portal's sections — B2B by recipient GSTIN, B2C large and small, exports, credit and debit notes, nil-rated /
 * exempt / non-GST, the HSN summary) and GSTR-3B (3.1 outward and reverse-charge inward supplies, 4 input tax credit,
 * 5 exempt inward supplies, 6.1 the tax payable by head). Filing stays on the GST portal: GSTR-1 also comes as the
 * portal's offline JSON. Amounts are in rupees: a foreign-currency line converts through its posted balance, as its
 * taxes do. A line's band is the GST treatment of its GST tax; a line without one is listed as unclassified.
 */
import { supplyScope } from '@kosh/accounting';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { GST_STATE_CODES } from './module.js';

type Decimal = ReturnType<typeof orm.toDecimal>;
const ZERO = orm.toDecimal(0);
const round = (d: Decimal) => d.toDecimalPlaces(2, orm.Decimal.ROUND_HALF_UP);

/** B2C invoices between states above this total are reported one by one (B2CL), in rupees. */
export const B2CL_THRESHOLD: Decimal = orm.toDecimal(100000);

export class MonthError extends Error {}

/** The first and last day of `month` (`2026-10`). */
export function monthRange(month: string): { readonly from: string; readonly to: string } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (match === null) throw new MonthError('A month is written 2026-10.');
  const last = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** The taxable value and each head of tax. */
export interface Heads {
  readonly txval: Decimal;
  readonly iamt: Decimal;
  readonly camt: Decimal;
  readonly samt: Decimal;
  readonly csamt: Decimal;
}
const NONE: Heads = { txval: ZERO, iamt: ZERO, camt: ZERO, samt: ZERO, csamt: ZERO };
const add = (a: Heads, b: Heads): Heads => ({
  txval: a.txval.plus(b.txval),
  iamt: a.iamt.plus(b.iamt),
  camt: a.camt.plus(b.camt),
  samt: a.samt.plus(b.samt),
  csamt: a.csamt.plus(b.csamt),
});
const neg = (h: Heads): Heads => ({
  txval: h.txval.neg(),
  iamt: h.iamt.neg(),
  camt: h.camt.neg(),
  samt: h.samt.neg(),
  csamt: h.csamt.neg(),
});

type Treatment = 'taxable' | 'nil' | 'exempt' | 'non_gst' | 'zero_rated' | 'unclassified';

/** One product line of a posted document, in rupees. */
interface Line extends Heads {
  readonly treatment: Treatment;
  readonly rate: Decimal;
  readonly reverseCharge: boolean;
  readonly hsn: string | null;
  readonly description: string;
  readonly quantity: Decimal;
}

/** A posted invoice, debit or credit note with its lines. */
interface Doc {
  readonly kind: string;
  readonly number: string;
  readonly date: string;
  readonly partner: string;
  readonly gstin: string | null;
  readonly export: boolean;
  readonly inter: boolean;
  /** The place of supply (ISO 3166-2) and its GST state code ("96": other countries). */
  readonly pos: string | null;
  readonly posCode: string;
  readonly original: { readonly number: string; readonly date: string } | null;
  readonly lines: readonly Line[];
  readonly value: Decimal;
}

/** The company of `env`: its GSTIN, country and state. */
async function companyOf(env: Env) {
  const [c] = await env.model('res.company').search({ where: { id: env.companyRef }, limit: 1 });
  return {
    gstin: c?.gstin ?? null,
    country: c?.country ?? null,
    state: c?.state ?? null,
  };
}

async function documents(env: Env, kinds: readonly string[], month: string): Promise<Doc[]> {
  const { from, to } = monthRange(month);
  const company = await companyOf(env);
  const moves = await env.model('account.move').search({
    where: {
      kind: { in: kinds as ('out_invoice' | 'out_refund')[] },
      state: 'posted',
      date: { gte: from, lte: to },
    },
    order: ['date asc', 'name asc'],
  });
  const loaded = await moves.load({
    partner: ['name', 'gstin', 'country', 'state'],
    reversalOf: ['name', 'date'],
    debitOf: ['name', 'date'],
    invoiceLines: { taxes: ['gstTreatment', 'reverseCharge'], product: ['hsnCode'] },
  });
  const out: Doc[] = [];
  for (const m of loaded) {
    const partnerCountry = m.partner?.country ?? null;
    const pos = m.placeOfSupply ?? m.partner?.state ?? null;
    const exported =
      partnerCountry !== null && company.country !== null && partnerCountry !== company.country;
    const lines: Line[] = [];
    for (const l of m.invoiceLines) {
      if (l.lineKind !== 'product') continue;
      const subtotal = l.subtotal?.amount ?? ZERO;
      // Rupees: the posted balance, and the taxes at its rate.
      const txval = (l.balance?.amount ?? ZERO).abs();
      const rate = subtotal.isZero() ? orm.toDecimal(1) : txval.div(subtotal.abs());
      const head = (d: Decimal | undefined) => round((d ?? ZERO).times(rate));
      const treatments = [...l.taxes]
        .map((t) => t.gstTreatment)
        .filter((t) => t !== null && t !== 'cess');
      lines.push({
        txval,
        iamt: head(l.igstAmount?.amount),
        camt: head(l.cgstAmount?.amount),
        samt: head(l.sgstAmount?.amount),
        csamt: head(l.cessAmount?.amount),
        treatment: (treatments[0] as Treatment | undefined) ?? 'unclassified',
        rate: l.gstRate ?? ZERO,
        reverseCharge: [...l.taxes].some((t) => t.reverseCharge),
        hsn: l.product?.hsnCode ?? null,
        description: l.name ?? '',
        quantity: l.quantity ?? ZERO,
      });
    }
    const original = m.reversalOf ?? m.debitOf;
    out.push({
      kind: m.kind,
      number: m.name ?? '',
      date: String(m.date),
      partner: m.partner?.name ?? '',
      gstin: m.partner?.gstin ?? null,
      export: exported,
      inter: supplyScope(company, partnerCountry, pos) === 'inter',
      pos,
      posCode: exported ? '96' : ((pos === null ? undefined : GST_STATE_CODES[pos]) ?? ''),
      original:
        original === null ? null : { number: original.name ?? '', date: String(original.date) },
      lines,
      value: lines.reduce(
        (s, l) => s.plus(l.txval).plus(l.iamt).plus(l.camt).plus(l.samt).plus(l.csamt),
        ZERO,
      ),
    });
  }
  return out;
}

/** An invoice or note in a GSTR-1 section: its items summed by rate. */
export interface Gstr1Document {
  readonly number: string;
  readonly date: string;
  readonly partner: string;
  readonly gstin: string | null;
  readonly pos: string;
  readonly value: Decimal;
  readonly reverseCharge: boolean;
  /** For notes: credit (C) or debit (D), and the invoice they correct. */
  readonly noteType?: 'C' | 'D';
  readonly original?: { readonly number: string; readonly date: string } | null;
  /** For exports: with IGST paid (WPAY) or under LUT (WOPAY). */
  readonly exportType?: 'WPAY' | 'WOPAY';
  readonly items: readonly (Heads & { readonly rate: Decimal })[];
}

export interface Gstr1 {
  readonly month: string;
  readonly gstin: string | null;
  readonly b2b: readonly Gstr1Document[];
  readonly b2cl: readonly Gstr1Document[];
  readonly b2cs: readonly (Heads & {
    readonly supply: 'INTRA' | 'INTER';
    readonly pos: string;
    readonly rate: Decimal;
  })[];
  readonly exp: readonly Gstr1Document[];
  readonly cdnr: readonly Gstr1Document[];
  readonly cdnur: readonly Gstr1Document[];
  readonly nil: readonly {
    readonly supply: 'INTRB2B' | 'INTRAB2B' | 'INTRB2C' | 'INTRAB2C';
    readonly nil: Decimal;
    readonly exempt: Decimal;
    readonly nonGst: Decimal;
  }[];
  readonly hsn: readonly (Heads & {
    readonly hsn: string;
    readonly description: string;
    readonly quantity: Decimal;
    readonly rate: Decimal;
  })[];
  /** Lines whose GST tax has no treatment: they are in no section. */
  readonly unclassified: number;
}

function itemsByRate(lines: readonly Line[]): (Heads & { rate: Decimal })[] {
  const byRate = new Map<string, Heads & { rate: Decimal }>();
  for (const l of lines) {
    const key = l.rate.toString();
    const prev = byRate.get(key) ?? { ...NONE, rate: l.rate };
    byRate.set(key, { ...add(prev, l), rate: l.rate });
  }
  return [...byRate.values()];
}

/** GSTR-1 of `month`. */
export async function gstr1(env: Env, month: string): Promise<Gstr1> {
  const company = await companyOf(env);
  const docs = await documents(env, ['out_invoice', 'out_debit', 'out_refund'], month);
  const b2b: Gstr1Document[] = [];
  const b2cl: Gstr1Document[] = [];
  const exp: Gstr1Document[] = [];
  const cdnr: Gstr1Document[] = [];
  const cdnur: Gstr1Document[] = [];
  const b2cs = new Map<string, Heads & { supply: 'INTRA' | 'INTER'; pos: string; rate: Decimal }>();
  const nil = new Map<
    string,
    { supply: Gstr1['nil'][number]['supply']; nil: Decimal; exempt: Decimal; nonGst: Decimal }
  >();
  const hsn = new Map<
    string,
    Heads & { hsn: string; description: string; quantity: Decimal; rate: Decimal }
  >();
  let unclassified = 0;
  for (const d of docs) {
    const note = d.kind === 'out_refund' ? 'C' : d.kind === 'out_debit' ? 'D' : undefined;
    const sign = note === 'C' ? -1 : 1;
    const taxable = d.lines.filter(
      (l) => l.treatment === 'taxable' || l.treatment === 'zero_rated',
    );
    unclassified += d.lines.filter((l) => l.treatment === 'unclassified').length;
    // Nil-rated, exempt and non-GST supplies: summed by inter / intra and registered / not.
    for (const l of d.lines) {
      if (l.treatment !== 'nil' && l.treatment !== 'exempt' && l.treatment !== 'non_gst') continue;
      const supply =
        `${d.inter ? 'INTR' : 'INTRA'}${d.gstin === null ? 'B2C' : 'B2B'}` as Gstr1['nil'][number]['supply'];
      const row = nil.get(supply) ?? { supply, nil: ZERO, exempt: ZERO, nonGst: ZERO };
      const v = l.txval.times(sign);
      if (l.treatment === 'nil') row.nil = row.nil.plus(v);
      else if (l.treatment === 'exempt') row.exempt = row.exempt.plus(v);
      else row.nonGst = row.nonGst.plus(v);
      nil.set(supply, row);
    }
    // The HSN summary: every taxable line, notes against it.
    for (const l of taxable) {
      const code = l.hsn ?? '';
      const key = `${code}|${l.rate.toString()}`;
      const prev = hsn.get(key) ?? {
        ...NONE,
        hsn: code,
        description: l.description,
        quantity: ZERO,
        rate: l.rate,
      };
      const signed = sign === 1 ? l : neg(l);
      hsn.set(key, {
        ...add(prev, signed),
        hsn: code,
        description: prev.description,
        quantity: prev.quantity.plus(l.quantity.times(sign)),
        rate: l.rate,
      });
    }
    if (taxable.length === 0) continue;
    const doc: Gstr1Document = {
      number: d.number,
      date: d.date,
      partner: d.partner,
      gstin: d.gstin,
      pos: d.posCode,
      value: d.value,
      reverseCharge: taxable.some((l) => l.reverseCharge),
      items: itemsByRate(taxable),
      ...(note === undefined ? {} : { noteType: note, original: d.original }),
      ...(d.export
        ? {
            exportType: taxable.some((l) => l.treatment === 'taxable' && !l.iamt.isZero())
              ? 'WPAY'
              : 'WOPAY',
          }
        : {}),
    } as Gstr1Document;
    if (note !== undefined) {
      if (d.gstin !== null) cdnr.push(doc);
      else if (d.export || (d.inter && d.value.gt(B2CL_THRESHOLD))) cdnur.push(doc);
      else for (const item of doc.items) addB2cs(b2cs, d, sign, item);
    } else if (d.gstin !== null) b2b.push(doc);
    else if (d.export) exp.push(doc);
    else if (d.inter && d.value.gt(B2CL_THRESHOLD)) b2cl.push(doc);
    else for (const item of doc.items) addB2cs(b2cs, d, sign, item);
  }
  return {
    month,
    gstin: company.gstin,
    b2b,
    b2cl,
    b2cs: [...b2cs.values()],
    exp,
    cdnr,
    cdnur,
    nil: [...nil.values()],
    hsn: [...hsn.values()],
    unclassified,
  };
}

function addB2cs(
  into: Map<string, Heads & { supply: 'INTRA' | 'INTER'; pos: string; rate: Decimal }>,
  d: Doc,
  sign: number,
  item: Heads & { rate: Decimal },
): void {
  const supply = d.inter ? 'INTER' : 'INTRA';
  const key = `${supply}|${d.posCode}|${item.rate.toString()}`;
  const prev = into.get(key) ?? { ...NONE, supply, pos: d.posCode, rate: item.rate };
  into.set(key, {
    ...add(prev, sign === 1 ? item : neg(item)),
    supply,
    pos: d.posCode,
    rate: item.rate,
  });
}

/** GSTR-3B of `month`. */
export interface Gstr3b {
  readonly month: string;
  readonly gstin: string | null;
  /** 3.1 (a) outward taxable supplies (other than zero-rated, nil-rated and exempt). */
  readonly outwardTaxable: Heads;
  /** 3.1 (b) outward zero-rated supplies (exports). */
  readonly outwardZeroRated: Heads;
  /** 3.1 (c) other outward supplies: nil-rated, exempt. */
  readonly outwardNilExempt: Heads;
  /** 3.1 (d) inward supplies liable to reverse charge. */
  readonly inwardReverseCharge: Heads;
  /** 3.1 (e) non-GST outward supplies. */
  readonly outwardNonGst: Heads;
  /** 4 (A)(3) input tax credit on inward supplies liable to reverse charge. */
  readonly itcReverseCharge: Heads;
  /** 4 (A)(5) all other input tax credit. */
  readonly itcOther: Heads;
  /** 5: exempt, nil-rated and non-GST inward supplies, from another state and within it. */
  readonly inwardExempt: { readonly inter: Decimal; readonly intra: Decimal };
  /** 6.1: by head, the tax payable, the credit and what is left to pay (negative: carried forward). */
  readonly payable: Readonly<
    Record<
      'igst' | 'cgst' | 'sgst' | 'cess',
      { readonly tax: Decimal; readonly credit: Decimal; readonly net: Decimal }
    >
  >;
}

/** GSTR-3B of `month`. */
export async function gstr3b(env: Env, month: string): Promise<Gstr3b> {
  const company = await companyOf(env);
  let outwardTaxable = NONE;
  let outwardZeroRated = NONE;
  let outwardNilExempt = NONE;
  let outwardNonGst = NONE;
  let inwardReverseCharge = NONE;
  let itcOther = NONE;
  let inwardInter = ZERO;
  let inwardIntra = ZERO;
  for (const d of await documents(env, ['out_invoice', 'out_debit', 'out_refund'], month)) {
    const sign = d.kind === 'out_refund' ? -1 : 1;
    for (const l of d.lines) {
      const signed = sign === 1 ? l : neg(l);
      if (l.treatment === 'zero_rated' || (l.treatment === 'taxable' && d.export))
        outwardZeroRated = add(outwardZeroRated, signed);
      else if (l.treatment === 'taxable' && !l.reverseCharge)
        outwardTaxable = add(outwardTaxable, signed);
      else if (l.treatment === 'nil' || l.treatment === 'exempt')
        outwardNilExempt = add(outwardNilExempt, { ...NONE, txval: signed.txval });
      else if (l.treatment === 'non_gst')
        outwardNonGst = add(outwardNonGst, { ...NONE, txval: signed.txval });
    }
  }
  for (const d of await documents(env, ['in_invoice', 'in_debit', 'in_refund'], month)) {
    const sign = d.kind === 'in_refund' ? -1 : 1;
    for (const l of d.lines) {
      const signed = sign === 1 ? l : neg(l);
      if (l.treatment === 'taxable' && l.reverseCharge)
        inwardReverseCharge = add(inwardReverseCharge, signed);
      else if (l.treatment === 'taxable') itcOther = add(itcOther, signed);
      else if (l.treatment === 'nil' || l.treatment === 'exempt' || l.treatment === 'non_gst') {
        if (d.inter) inwardInter = inwardInter.plus(signed.txval);
        else inwardIntra = inwardIntra.plus(signed.txval);
      }
    }
  }
  const itcReverseCharge = { ...inwardReverseCharge, txval: ZERO };
  const head = (key: 'iamt' | 'camt' | 'samt' | 'csamt') => {
    const tax = outwardTaxable[key].plus(outwardZeroRated[key]).plus(inwardReverseCharge[key]);
    const credit = itcReverseCharge[key].plus(itcOther[key]);
    return { tax, credit, net: tax.minus(credit) };
  };
  return {
    month,
    gstin: company.gstin,
    outwardTaxable,
    outwardZeroRated,
    outwardNilExempt,
    inwardReverseCharge,
    outwardNonGst,
    itcReverseCharge,
    itcOther: { ...itcOther, txval: ZERO },
    inwardExempt: { inter: inwardInter, intra: inwardIntra },
    payable: { igst: head('iamt'), cgst: head('camt'), sgst: head('samt'), cess: head('csamt') },
  };
}

const money = (d: Decimal) => Number(d.toFixed(2));
const portalDate = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const portalItems = (items: Gstr1Document['items'], exportOnly = false) =>
  items.map((it, i) => ({
    num: i + 1,
    itm_det: exportOnly
      ? {
          txval: money(it.txval),
          rt: Number(it.rate.toString()),
          iamt: money(it.iamt),
          csamt: money(it.csamt),
        }
      : {
          txval: money(it.txval),
          rt: Number(it.rate.toString()),
          iamt: money(it.iamt),
          camt: money(it.camt),
          samt: money(it.samt),
          csamt: money(it.csamt),
        },
  }));

/**
 * GSTR-1 as the GST portal's offline JSON (the sections b2b, b2cl, b2cs, exp, cdnr, cdnur, nil, hsn). Check it against
 * the current offline tool's schema before uploading: the portal changes it from time to time.
 */
export function gstr1PortalJson(r: Gstr1): Record<string, unknown> {
  const [y, m] = r.month.split('-') as [string, string];
  const byGstin = (docs: readonly Gstr1Document[], key: 'inv' | 'nt', note: boolean) => {
    const out = new Map<string, unknown[]>();
    for (const d of docs) {
      const list = out.get(d.gstin ?? '') ?? [];
      list.push(
        note
          ? {
              ntty: d.noteType,
              nt_num: d.number,
              nt_dt: portalDate(d.date),
              val: money(d.value),
              pos: d.pos,
              rchrg: d.reverseCharge ? 'Y' : 'N',
              inv_typ: 'R',
              itms: portalItems(d.items),
            }
          : {
              inum: d.number,
              idt: portalDate(d.date),
              val: money(d.value),
              pos: d.pos,
              rchrg: d.reverseCharge ? 'Y' : 'N',
              inv_typ: 'R',
              itms: portalItems(d.items),
            },
      );
      out.set(d.gstin ?? '', list);
    }
    return [...out.entries()].map(([ctin, list]) => ({ ctin, [key]: list }));
  };
  const b2clByPos = new Map<string, unknown[]>();
  for (const d of r.b2cl) {
    const list = b2clByPos.get(d.pos) ?? [];
    list.push({
      inum: d.number,
      idt: portalDate(d.date),
      val: money(d.value),
      itms: portalItems(d.items),
    });
    b2clByPos.set(d.pos, list);
  }
  const expByType = new Map<string, unknown[]>();
  for (const d of r.exp) {
    const list = expByType.get(d.exportType ?? 'WOPAY') ?? [];
    list.push({
      inum: d.number,
      idt: portalDate(d.date),
      val: money(d.value),
      itms: portalItems(d.items, true),
    });
    expByType.set(d.exportType ?? 'WOPAY', list);
  }
  return {
    gstin: r.gstin ?? '',
    fp: `${m}${y}`,
    b2b: byGstin(r.b2b, 'inv', false),
    b2cl: [...b2clByPos.entries()].map(([pos, inv]) => ({ pos, inv })),
    b2cs: r.b2cs.map((s) => ({
      sply_ty: s.supply,
      pos: s.pos,
      typ: 'OE',
      rt: Number(s.rate.toString()),
      txval: money(s.txval),
      iamt: money(s.iamt),
      camt: money(s.camt),
      samt: money(s.samt),
      csamt: money(s.csamt),
    })),
    exp: [...expByType.entries()].map(([exp_typ, inv]) => ({ exp_typ, inv })),
    cdnr: byGstin(r.cdnr, 'nt', true),
    cdnur: r.cdnur.map((d) => ({
      typ: d.exportType === undefined ? 'B2CL' : d.exportType === 'WPAY' ? 'EXPWP' : 'EXPWOP',
      ntty: d.noteType,
      nt_num: d.number,
      nt_dt: portalDate(d.date),
      val: money(d.value),
      pos: d.pos,
      itms: portalItems(d.items),
    })),
    nil: {
      inv: r.nil.map((n) => ({
        sply_ty: n.supply,
        nil_amt: money(n.nil),
        expt_amt: money(n.exempt),
        ngsup_amt: money(n.nonGst),
      })),
    },
    hsn: {
      data: r.hsn.map((h, i) => ({
        num: i + 1,
        hsn_sc: h.hsn,
        desc: h.description,
        uqc: 'NOS',
        qty: Number(h.quantity.toString()),
        rt: Number(h.rate.toString()),
        txval: money(h.txval),
        iamt: money(h.iamt),
        camt: money(h.camt),
        samt: money(h.samt),
        csamt: money(h.csamt),
      })),
    },
  };
}
