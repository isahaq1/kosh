/**
 * E-invoicing and e-way bills (RFC 0016 step 5, part 4). A posted customer invoice, credit or debit note to a
 * registered recipient or abroad is registered with the Invoice Registration Portal (IRP) through a provider: the
 * IRP schema's payload (version 1.1) is built from the document and checked first (what the IRP would refuse is
 * said here, in words); the IRN, the acknowledgement and the signed QR code come back onto the document. An IRN is
 * cancelled within 24 hours of its acknowledgement. An e-way bill is generated from an invoice with the transport
 * (part B), and cancelled within 24 hours.
 *
 * Providers sit behind {@link GstProvider} (NIC's APIs directly, or a GST Suvidha Provider), like the messengers of
 * notifications; credentials come from the environment, never from records. {@link createFakeGstProvider} answers
 * as the IRP does, for tests and demonstrations: the IRN is the SHA-256 of the seller's GSTIN, the financial year,
 * the document type and number, and a second registration of the same document is refused.
 */
import { createHash, randomInt } from 'node:crypto';
import { HttpProblem } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { GST_STATE_CODES } from './module.js';

type Decimal = ReturnType<typeof orm.toDecimal>;
const ZERO = orm.toDecimal(0);

/** An item of the IRP payload. */
export interface EInvoiceItem {
  readonly SlNo: string;
  readonly PrdDesc: string;
  readonly IsServc: 'Y' | 'N';
  readonly HsnCd: string;
  readonly Qty: number;
  readonly Unit: string;
  readonly UnitPrice: number;
  readonly TotAmt: number;
  readonly Discount: number;
  readonly AssAmt: number;
  readonly GstRt: number;
  readonly IgstAmt: number;
  readonly CgstAmt: number;
  readonly SgstAmt: number;
  readonly CesAmt: number;
  readonly TotItemVal: number;
}

/** The IRP's e-invoice schema (version 1.1), as far as Kosh fills it. */
export interface EInvoicePayload {
  readonly Version: '1.1';
  readonly TranDtls: {
    readonly TaxSch: 'GST';
    readonly SupTyp: 'B2B' | 'EXPWP' | 'EXPWOP';
    readonly RegRev: 'Y' | 'N';
    readonly IgstOnIntra: 'N';
  };
  readonly DocDtls: {
    readonly Typ: 'INV' | 'CRN' | 'DBN';
    readonly No: string;
    readonly Dt: string;
  };
  readonly SellerDtls: {
    readonly Gstin: string;
    readonly LglNm: string;
    readonly Addr1: string;
    readonly Loc: string;
    readonly Pin: number;
    readonly Stcd: string;
  };
  readonly BuyerDtls: {
    readonly Gstin: string;
    readonly LglNm: string;
    readonly Pos: string;
    readonly Addr1: string;
    readonly Loc: string;
    readonly Pin: number;
    readonly Stcd: string;
  };
  readonly ItemList: readonly EInvoiceItem[];
  readonly ValDtls: {
    readonly AssVal: number;
    readonly CgstVal: number;
    readonly SgstVal: number;
    readonly IgstVal: number;
    readonly CesVal: number;
    readonly TotInvVal: number;
  };
}

/** The e-way bill: part A from the invoice, part B the transport. */
export interface EwayBillPayload {
  readonly supplyType: 'O';
  readonly docType: 'INV' | 'CHL';
  readonly docNo: string;
  readonly docDate: string;
  readonly fromGstin: string;
  readonly fromPincode: number;
  readonly fromStateCode: number;
  readonly toGstin: string;
  readonly toPincode: number;
  readonly toStateCode: number;
  readonly totInvValue: number;
  readonly transMode: '1' | '2' | '3' | '4';
  readonly transDistance: number;
  readonly transporterId: string;
  readonly vehicleNo: string;
  /** The IRN, when the invoice was e-invoiced. */
  readonly irn?: string;
}

/** What a provider answers, or refuses with {@link GstProviderError}. */
export interface GstProvider {
  readonly name: string;
  registerInvoice(
    payload: EInvoicePayload,
  ): Promise<{ irn: string; ackNo: string; ackDate: string; signedQr: string }>;
  cancelInvoice(
    seller: string,
    irn: string,
    reason: string,
    remark: string,
  ): Promise<{ cancelledAt: string }>;
  generateEwayBill(
    payload: EwayBillPayload,
  ): Promise<{ ewbNo: string; ewbDate: string; validUntil: string }>;
  cancelEwayBill(
    seller: string,
    ewbNo: string,
    reason: string,
    remark: string,
  ): Promise<{ cancelledAt: string }>;
}

/** A refusal of the IRP or the e-way bill system: its code and message, kept on the document. */
export class GstProviderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'GstProviderError';
  }
}

/** The financial year (April–March) of `iso` as the IRN uses it: `2026-27`. */
export function financialYear(iso: string): string {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

/** The IRN of a document: SHA-256 of the seller's GSTIN, the financial year, the document type and number. */
export function irnOf(gstin: string, docType: string, docNo: string, iso: string): string {
  return createHash('sha256')
    .update(`${gstin}${financialYear(iso)}${docType}${docNo.toUpperCase()}`)
    .digest('hex');
}

const toIso = (dmy: string) => `${dmy.slice(6, 10)}-${dmy.slice(3, 5)}-${dmy.slice(0, 2)}`;
const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A provider answering like the IRP and the e-way bill system, in memory (tests, demonstrations). */
export function createFakeGstProvider(
  now: () => Date = () => new Date(),
): GstProvider & { readonly invoices: Map<string, { cancelled: boolean; ackDate: string }> } {
  const invoices = new Map<string, { cancelled: boolean; ackDate: string }>();
  const bills = new Map<string, { cancelled: boolean }>();
  let ack = 112610000000000;
  // The IRP answers in Indian time (UTC+05:30), as a wall clock.
  const ist = () => new Date(now().getTime() + 330 * 60_000);
  const stamp = () => ist().toISOString().slice(0, 19).replace('T', ' ');
  return {
    name: 'fake',
    invoices,
    async registerInvoice(payload) {
      const irn = irnOf(
        payload.SellerDtls.Gstin,
        payload.DocDtls.Typ,
        payload.DocDtls.No,
        toIso(payload.DocDtls.Dt),
      );
      if (invoices.has(irn)) throw new GstProviderError('2150', 'Duplicate IRN');
      if (payload.ItemList.length === 0)
        throw new GstProviderError('2172', 'The invoice has no items');
      ack += 1;
      const ackDate = stamp();
      invoices.set(irn, { cancelled: false, ackDate });
      const data = {
        SellerGstin: payload.SellerDtls.Gstin,
        BuyerGstin: payload.BuyerDtls.Gstin,
        DocNo: payload.DocDtls.No,
        DocTyp: payload.DocDtls.Typ,
        DocDt: payload.DocDtls.Dt,
        TotInvVal: payload.ValDtls.TotInvVal,
        ItemCnt: payload.ItemList.length,
        MainHsnCode: payload.ItemList[0]?.HsnCd,
        Irn: irn,
        IrnDt: ackDate,
      };
      return {
        irn,
        ackNo: String(ack),
        ackDate,
        signedQr: `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ data: JSON.stringify(data) })}.fake`,
      };
    },
    async cancelInvoice(_seller, irn) {
      const known = invoices.get(irn);
      if (known === undefined) throw new GstProviderError('2163', 'The IRN is not known');
      if (known.cancelled) throw new GstProviderError('9999', 'The IRN is already cancelled');
      known.cancelled = true;
      return { cancelledAt: stamp() };
    },
    async generateEwayBill(payload) {
      const ewbNo = String(randomInt(100000000000, 999999999999));
      bills.set(ewbNo, { cancelled: false });
      const start = ist();
      // Valid one day per 200 km (road), to the end of the last day.
      const days = Math.max(1, Math.ceil(payload.transDistance / 200));
      const until = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + days, 23, 59, 0),
      );
      return {
        ewbNo,
        ewbDate: stamp(),
        validUntil: until.toISOString().slice(0, 19).replace('T', ' '),
      };
    },
    async cancelEwayBill(_seller, ewbNo) {
      const known = bills.get(ewbNo);
      if (known === undefined || known.cancelled)
        throw new GstProviderError('312', 'The e-way bill cannot be cancelled');
      known.cancelled = true;
      return { cancelledAt: stamp() };
    },
  };
}

/** The provider the environment names (`KOSH_GST_PROVIDER=fake`), or none: e-invoicing is then unavailable. */
export function gstProviderFromEnv(env: NodeJS.ProcessEnv = process.env): GstProvider | undefined {
  return env['KOSH_GST_PROVIDER'] === 'fake' ? createFakeGstProvider() : undefined;
}

const money = (d: Decimal) => Number(d.toFixed(2));
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const DOC_TYPES: Readonly<Record<string, 'INV' | 'CRN' | 'DBN'>> = {
  out_invoice: 'INV',
  out_refund: 'CRN',
  out_debit: 'DBN',
};

/** A document's payload for the IRP, or the reasons the IRP would refuse it. */
export async function einvoicePayload(
  env: Env,
  id: number,
): Promise<{ payload: EInvoicePayload | null; problems: string[]; seller: string }> {
  const [m] = await env
    .model('account.move')
    .search({ where: { id: orm.asId(id, 'account.move') }, limit: 1 })
    .then((found) =>
      found.load({
        company: true,
        partner: ['name', 'gstin', 'country', 'state', 'street', 'city', 'zip'],
        invoiceLines: { product: ['hsnCode', 'kind'], taxes: ['reverseCharge'] },
      }),
    );
  if (m === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', `There is no document ${id}.`);
  const problems: string[] = [];
  const typ = DOC_TYPES[m.kind];
  if (typ === undefined)
    problems.push('Only customer invoices, credit notes and debit notes are e-invoiced.');
  if (m.state !== 'posted') problems.push('Only a posted document is e-invoiced.');
  const company = m.company;
  const seller = company.gstin ?? '';
  if (company.gstin === null)
    problems.push('The company has no GSTIN (Accounting › Reporting › GST returns › Settings).');
  if (company.state === null)
    problems.push('The company has no state (Accounting › Configuration › Settings).');
  if (company.zip === null || !/^\d{6}$/.test(company.zip))
    problems.push('The company has no 6-digit PIN code.');
  const partner = m.partner;
  const exported =
    partner?.country !== null &&
    partner?.country !== undefined &&
    partner.country !== company.country;
  if (partner === null) problems.push('The document has no customer.');
  else if (!exported && partner.gstin === null)
    problems.push(
      `${partner.name} has no GSTIN: invoices to unregistered customers are not e-invoiced.`,
    );
  if (partner !== null && !exported && (partner.zip === null || !/^\d{6}$/.test(partner.zip)))
    problems.push(`${partner.name} has no 6-digit PIN code.`);
  const pos = exported ? '96' : (GST_STATE_CODES[m.placeOfSupply ?? partner?.state ?? ''] ?? '');
  if (pos === '') problems.push('The place of supply is not a state of India.');
  const lines = [...m.invoiceLines].filter((l) => l.lineKind === 'product');
  if (lines.length === 0) problems.push('The document has no lines.');
  const items: EInvoiceItem[] = lines.map((l, i) => {
    if (l.product?.hsnCode === null || l.product?.hsnCode === undefined)
      problems.push(
        `Line ${i + 1} (${l.name ?? ''}) has no HSN / SAC code: set it on the product.`,
      );
    const qty = l.quantity ?? orm.toDecimal(1);
    const price = l.priceUnit ?? ZERO;
    const gross = qty.times(price);
    const assessable = l.subtotal?.amount ?? ZERO;
    const heads = [l.igstAmount, l.cgstAmount, l.sgstAmount, l.cessAmount].map(
      (x) => x?.amount ?? ZERO,
    );
    return {
      SlNo: String(i + 1),
      PrdDesc: l.name ?? '',
      IsServc: l.product?.hsnCode?.startsWith('99') === true ? 'Y' : 'N',
      HsnCd: l.product?.hsnCode ?? '',
      Qty: Number(qty.toString()),
      Unit: 'NOS',
      UnitPrice: money(price),
      TotAmt: money(gross),
      Discount: money(gross.minus(assessable)),
      AssAmt: money(assessable),
      GstRt: Number((l.gstRate ?? ZERO).toString()),
      IgstAmt: money(heads[0] as Decimal),
      CgstAmt: money(heads[1] as Decimal),
      SgstAmt: money(heads[2] as Decimal),
      CesAmt: money(heads[3] as Decimal),
      TotItemVal: money(l.totalWithGst?.amount ?? assessable),
    };
  });
  const sum = (key: keyof EInvoiceItem) => items.reduce((s, it) => s + (it[key] as number), 0);
  const twoDecimals = (n: number) => Math.round(n * 100) / 100;
  const igst = twoDecimals(sum('IgstAmt'));
  const payload: EInvoicePayload = {
    Version: '1.1',
    TranDtls: {
      TaxSch: 'GST',
      SupTyp: exported ? (igst > 0 ? 'EXPWP' : 'EXPWOP') : 'B2B',
      RegRev: lines.some((l) => [...l.taxes].some((t) => t.reverseCharge)) ? 'Y' : 'N',
      IgstOnIntra: 'N',
    },
    DocDtls: { Typ: typ ?? 'INV', No: m.name ?? '', Dt: dmy(String(m.date)) },
    SellerDtls: {
      Gstin: seller,
      LglNm: company.name,
      Addr1: company.street ?? company.name,
      Loc: company.city ?? '',
      Pin: Number(company.zip ?? 0),
      Stcd: GST_STATE_CODES[company.state ?? ''] ?? '',
    },
    BuyerDtls: {
      Gstin: exported ? 'URP' : (partner?.gstin ?? ''),
      LglNm: partner?.name ?? '',
      Pos: pos,
      Addr1: partner?.street ?? partner?.name ?? '',
      Loc: partner?.city ?? '',
      Pin: exported ? 999999 : Number(partner?.zip ?? 0),
      Stcd: exported ? '96' : (GST_STATE_CODES[partner?.state ?? ''] ?? ''),
    },
    ItemList: items,
    ValDtls: {
      AssVal: twoDecimals(sum('AssAmt')),
      CgstVal: twoDecimals(sum('CgstAmt')),
      SgstVal: twoDecimals(sum('SgstAmt')),
      IgstVal: igst,
      CesVal: twoDecimals(sum('CesAmt')),
      TotInvVal: twoDecimals(sum('TotItemVal')),
    },
  };
  return { payload: problems.length === 0 ? payload : null, problems, seller };
}

/** Writes the IRP's answer (or the refusal) onto a document, as the system: the fields are read-only to users. */
async function record(env: Env, id: number, values: Record<string, unknown>): Promise<void> {
  await env.asSuperuser({ reason: 'e-invoicing: the IRP answered' }, async (su) => {
    // The document's e-invoice record (users only read it); the document shows it through computed fields.
    const records = su.model('l10n_in.einvoice');
    const move = orm.asId(id, 'account.move');
    const found = await records.search({ where: { move }, limit: 1 });
    if (found.length === 0) await records.create([{ move, ...values } as never]);
    else await found.write(values as never);
    await su.flush(); // checks in this scope (Shutro request #11)
  });
}

/** A document's e-invoice record, or undefined (never registered). */
async function einvoiceOf(env: Env, id: number) {
  const [e] = await env
    .model('l10n_in.einvoice')
    .search({ where: { move: orm.asId(id, 'account.move') }, limit: 1 });
  return e;
}

const fromProvider = (stamp: string) => new Date(`${stamp.replace(' ', 'T')}+05:30`);

/** The state of a document's e-invoice and e-way bill (what the screen shows). */
export async function einvoiceState(env: Env, id: number) {
  const [m] = await env
    .model('account.move')
    .search({ where: { id: orm.asId(id, 'account.move') }, limit: 1 });
  if (m === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', `There is no document ${id}.`);
  return {
    status: m.einvoiceStatus,
    irn: m.irn,
    ackNo: m.irnAckNo,
    ackDate: m.irnAckDate,
    signedQr: m.irnSignedQr,
    cancelledAt: m.irnCancelledAt,
    error: m.einvoiceError,
    ewayBill: {
      status: m.ewbStatus,
      number: m.ewbNo,
      date: m.ewbDate,
      validUntil: m.ewbValidUntil,
      vehicleNo: m.ewbVehicleNo,
      transporterId: m.ewbTransporterId,
      distanceKm: m.ewbDistanceKm,
      mode: m.ewbMode,
      error: m.ewbError,
    },
  };
}

const unavailable = () =>
  new HttpProblem(
    409,
    'no-gst-provider',
    'E-invoicing is not set up',
    'No IRP / e-way bill provider is configured for this installation (KOSH_GST_PROVIDER).',
  );

/**
 * Registers a document with the IRP. The document must be readable and the user may post (the right to e-invoice
 * goes with it). A refusal, here or by the IRP, is kept on the document and answered with 422.
 */
export async function registerEInvoice(env: Env, provider: GstProvider | undefined, id: number) {
  env.access.check('account.move', 'write');
  if (provider === undefined) throw unavailable();
  const { payload, problems } = await einvoicePayload(env, id);
  const [current] = await env
    .model('account.move')
    .search({ where: { id: orm.asId(id, 'account.move') }, limit: 1 });
  if (current?.einvoiceStatus === 'registered')
    throw new HttpProblem(
      409,
      'already-registered',
      'Already registered',
      `The document has the IRN ${current.irn}.`,
    );
  if (payload === null) {
    await record(env, id, { einvoiceStatus: 'failed', einvoiceError: problems.join('\n') });
    throw new HttpProblem(
      422,
      'einvoice-refused',
      'The document cannot be e-invoiced',
      problems.join(' '),
    );
  }
  try {
    const answer = await provider.registerInvoice(payload);
    await record(env, id, {
      einvoiceStatus: 'registered',
      irn: answer.irn,
      irnAckNo: answer.ackNo,
      irnAckDate: fromProvider(answer.ackDate),
      irnSignedQr: answer.signedQr,
      einvoiceError: null,
    });
  } catch (error) {
    if (!(error instanceof GstProviderError)) throw error;
    await record(env, id, {
      einvoiceStatus: 'failed',
      einvoiceError: `${error.code}: ${error.message}`,
    });
    throw new HttpProblem(
      422,
      'einvoice-refused',
      'The IRP refused the document',
      `${error.code}: ${error.message}`,
    );
  }
  return einvoiceState(env, id);
}

/** The IRP's reasons to cancel an IRN. */
export const CANCEL_REASONS: Readonly<Record<string, string>> = {
  '1': 'Duplicate',
  '2': 'Data entry mistake',
  '3': 'Order cancelled',
  '4': 'Others',
};

/** Cancels a document's IRN, within 24 hours of its acknowledgement. The document itself is reversed separately. */
export async function cancelEInvoice(
  env: Env,
  provider: GstProvider | undefined,
  id: number,
  reason: string,
  remark: string,
) {
  env.access.check('account.move', 'write');
  if (provider === undefined) throw unavailable();
  if (CANCEL_REASONS[reason] === undefined)
    throw new HttpProblem(
      400,
      'invalid-body',
      'Invalid request',
      'reason is 1 (duplicate), 2 (mistake), 3 (cancelled) or 4 (others).',
    );
  const [m] = await env
    .model('account.move')
    .search({ where: { id: orm.asId(id, 'account.move') }, limit: 1 })
    .then((f) => f.load({ company: true }));
  if (m === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', `There is no document ${id}.`);
  const e = await einvoiceOf(env, id);
  if (e?.einvoiceStatus !== 'registered' || e.irn === null || e.irnAckDate === null)
    throw new HttpProblem(
      409,
      'not-registered',
      'Not registered',
      'The document has no IRN to cancel.',
    );
  const acknowledged = new Date(String(e.irnAckDate)).getTime();
  if (env.now().getTime() - acknowledged > 24 * 3600 * 1000)
    throw new HttpProblem(
      409,
      'too-late',
      'Too late to cancel',
      'An IRN is cancelled within 24 hours. Issue a credit note instead.',
    );
  try {
    const answer = await provider.cancelInvoice(m.company.gstin ?? '', e.irn, reason, remark);
    await record(env, id, {
      einvoiceStatus: 'cancelled',
      irnCancelledAt: fromProvider(answer.cancelledAt),
    });
  } catch (error) {
    if (!(error instanceof GstProviderError)) throw error;
    throw new HttpProblem(
      422,
      'einvoice-refused',
      'The IRP refused the cancellation',
      `${error.code}: ${error.message}`,
    );
  }
  return einvoiceState(env, id);
}

const MODES = { road: '1', rail: '2', air: '3', ship: '4' } as const;

/** Generates the e-way bill of a posted invoice with its transport (part B). */
export async function generateEwayBill(
  env: Env,
  provider: GstProvider | undefined,
  id: number,
  transport: {
    readonly mode: keyof typeof MODES;
    readonly distanceKm: number;
    readonly vehicleNo: string;
    readonly transporterId?: string | undefined;
  },
) {
  env.access.check('account.move', 'write');
  if (provider === undefined) throw unavailable();
  const { payload: invoice, problems } = await einvoicePayload(env, id);
  const [m] = await env
    .model('account.move')
    .search({ where: { id: orm.asId(id, 'account.move') }, limit: 1 });
  if (m?.kind !== 'out_invoice') problems.push('E-way bills are generated from customer invoices.');
  if (m?.ewbStatus === 'generated')
    throw new HttpProblem(
      409,
      'already-generated',
      'Already generated',
      `The invoice has the e-way bill ${m.ewbNo}.`,
    );
  if (transport.mode === 'road' && !/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(transport.vehicleNo))
    problems.push('A vehicle number is like MH12AB1234.');
  if (!(transport.distanceKm > 0 && transport.distanceKm <= 4000))
    problems.push('The distance is 1 to 4000 km.');
  const values = {
    ewbMode: transport.mode,
    ewbDistanceKm: transport.distanceKm,
    ewbVehicleNo: transport.vehicleNo,
    ewbTransporterId: transport.transporterId ?? null,
  };
  if (invoice === null || problems.length > 0) {
    await record(env, id, { ...values, ewbStatus: 'failed', ewbError: problems.join('\n') });
    throw new HttpProblem(
      422,
      'ewaybill-refused',
      'No e-way bill for this invoice',
      problems.join(' '),
    );
  }
  try {
    const answer = await provider.generateEwayBill({
      supplyType: 'O',
      docType: 'INV',
      docNo: invoice.DocDtls.No,
      docDate: invoice.DocDtls.Dt,
      fromGstin: invoice.SellerDtls.Gstin,
      fromPincode: invoice.SellerDtls.Pin,
      fromStateCode: Number(invoice.SellerDtls.Stcd),
      toGstin: invoice.BuyerDtls.Gstin,
      toPincode: invoice.BuyerDtls.Pin,
      toStateCode: Number(invoice.BuyerDtls.Stcd),
      totInvValue: invoice.ValDtls.TotInvVal,
      transMode: MODES[transport.mode],
      transDistance: transport.distanceKm,
      transporterId: transport.transporterId ?? '',
      vehicleNo: transport.vehicleNo,
      ...(m?.irn === null || m?.irn === undefined ? {} : { irn: m.irn }),
    });
    await record(env, id, {
      ...values,
      ewbStatus: 'generated',
      ewbNo: answer.ewbNo,
      ewbDate: fromProvider(answer.ewbDate),
      ewbValidUntil: fromProvider(answer.validUntil),
      ewbError: null,
    });
  } catch (error) {
    if (!(error instanceof GstProviderError)) throw error;
    await record(env, id, {
      ...values,
      ewbStatus: 'failed',
      ewbError: `${error.code}: ${error.message}`,
    });
    throw new HttpProblem(
      422,
      'ewaybill-refused',
      'The e-way bill system refused it',
      `${error.code}: ${error.message}`,
    );
  }
  return einvoiceState(env, id);
}

/** Cancels an e-way bill within 24 hours of its generation. */
export async function cancelEwayBill(
  env: Env,
  provider: GstProvider | undefined,
  id: number,
  reason: string,
  remark: string,
) {
  env.access.check('account.move', 'write');
  if (provider === undefined) throw unavailable();
  const [m] = await env
    .model('account.move')
    .search({ where: { id: orm.asId(id, 'account.move') }, limit: 1 })
    .then((f) => f.load({ company: true }));
  if (m === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', `There is no document ${id}.`);
  const e = await einvoiceOf(env, id);
  if (e?.ewbStatus !== 'generated' || e.ewbNo === null || e.ewbDate === null)
    throw new HttpProblem(
      409,
      'no-ewaybill',
      'No e-way bill',
      'The invoice has no e-way bill to cancel.',
    );
  if (env.now().getTime() - new Date(String(e.ewbDate)).getTime() > 24 * 3600 * 1000)
    throw new HttpProblem(
      409,
      'too-late',
      'Too late to cancel',
      'An e-way bill is cancelled within 24 hours.',
    );
  try {
    await provider.cancelEwayBill(m.company.gstin ?? '', e.ewbNo, reason, remark);
    await record(env, id, { ewbStatus: 'cancelled' });
  } catch (error) {
    if (!(error instanceof GstProviderError)) throw error;
    throw new HttpProblem(
      422,
      'ewaybill-refused',
      'The e-way bill system refused it',
      `${error.code}: ${error.message}`,
    );
  }
  return einvoiceState(env, id);
}

/**
 * After posting (`account.move.posted`): customer documents of companies with e-invoicing on are registered, those
 * to registered recipients and abroad; a refusal stays on the document for the user to fix and retry.
 */
export async function registerPosted(env: Env, provider: GstProvider, id: number): Promise<void> {
  const [m] = await env
    .model('account.move')
    .search({ where: { id: orm.asId(id, 'account.move') }, limit: 1 })
    .then((f) => f.load({ company: true, partner: ['gstin', 'country'] }));
  if (m === undefined || DOC_TYPES[m.kind] === undefined || !m.company.einvoiceEnabled) return;
  if (m.einvoiceStatus === 'registered') return;
  const exported =
    m.partner?.country !== null &&
    m.partner?.country !== undefined &&
    m.partner.country !== m.company.country;
  if (m.partner?.gstin === null && !exported) return; // unregistered: not e-invoiced
  try {
    await registerEInvoice(env, provider, id);
  } catch (error) {
    if (error instanceof HttpProblem && error.problem.status === 422) return; // kept on the document
    throw error;
  }
}
