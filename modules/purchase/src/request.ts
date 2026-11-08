/**
 * Purchase requests (RFC 0032 §3.4, after Paragon's procurement chain): anyone may ask Purchase for products — the
 * requester's department head approves, then a Purchase manager above an estimated amount —; buyers are assigned
 * to the approved lines and turn what is left to buy into requests for quotation, one per vendor chosen by the
 * vendor prices (RFC 0030) or the request's preferred vendor. Every line is followed through the chain: approved,
 * RFQ made, ordered, cancelled — the **line tracker** —, with what was approved, ordered and is still to buy.
 */
import { approvalGuard, requestApprovals } from '@kosh/permissions';
import { type Decimal, orm } from '@kosh/server/orm';
import { check, compute, defineModel, type Env, f, onchange, records } from './.kosh/bindings.js';
import { vendorPriceFor } from './vendorprice.js';

const ALL = ['read', 'write', 'create', 'unlink'] as const;
const me = { $env: 'uid' } as const;
const zero: Decimal = orm.toDecimal(0);

/** A date-only value as `YYYY-MM-DD`. */
function isoDay(v: unknown): string {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

const OPEN_ORDER = new Set(['draft', 'sent', 'to_approve', 'purchase', 'done']);
const ORDERED = new Set(['purchase', 'done']);

export const PurchaseRequest = defineModel('purchase.request', {
  label: 'Purchase request',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'priority', 'dateRequired', 'vendor'],
  access: {
    'purchase.requester': ALL,
    'purchase.user': ALL,
    'purchase.manager': [...ALL, 'export', 'import'],
  },
  rules: {
    // One's own requests; changed while a draft (or sent back as rejected).
    seeOwn: { groups: ['purchase.requester'], perms: ['read'], domain: { requester: me } },
    draftOwn: {
      groups: ['purchase.requester'],
      perms: ['write', 'create', 'unlink'],
      domain: { requester: me, state: { in: ['draft', 'rejected'] } },
    },
    // Buyers see every request once it is submitted, and work the approved ones.
    buyers: {
      groups: ['purchase.user'],
      perms: ['read', 'write'],
      domain: { state: { in: ['to_approve', 'approved', 'done'] } },
    },
    all: { groups: ['purchase.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, sequence: 'purchase.request', label: 'Reference' }),
    requester: f.many2one('res.users', {
      required: true,
      ondelete: 'restrict',
      default: (env: Env) => env.userId,
      label: 'Requested by',
    }),
    date: f.date({ required: true, default: (env: Env) => env.today(), label: 'Request date' }),
    dateRequired: f.date({
      required: true,
      default: (env: Env) => env.today(),
      label: 'Needed by',
    }),
    priority: f.selection(
      { normal: 'Normal', high: 'High', urgent: 'Urgent', critical: 'Critical' },
      {
        required: true,
        default: 'normal',
        help: 'How soon the products are needed, shown as stars.',
      },
    ),
    vendor: f.many2one('res.partner', {
      ondelete: 'set null',
      label: 'Preferred vendor',
      help: 'Asked when no vendor price names one for a line.',
    }),
    purpose: f.text(),
    lines: f.one2many('purchase.request.line', 'request', { label: 'Products' }),
    amountEstimate: f.decimal({
      scale: 2,
      store: true,
      label: 'Estimated amount',
      help: 'The lines at the products’ cost: what the approval levels go by before a price is quoted.',
      ...compute(
        'purchase.request',
        'amountEstimate',
        ['lines.quantity', 'lines.product.standardPrice'],
        (requests) => {
          for (const r of requests)
            r.amountEstimate = [...r.lines]
              .reduce((s, l) => s.plus(l.quantity.times(l.product.standardPrice ?? zero)), zero)
              .toDecimalPlaces(2);
        },
      ),
    }),
    rejectReason: f.char({ size: 300, label: 'Rejected because' }),
    state: f.state({
      states: {
        draft: 'Draft',
        to_approve: 'Waiting for approval',
        approved: 'Approved',
        done: 'Done',
        rejected: 'Rejected',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      help: 'Drafted by the requester, approved by their department head and Purchase, worked by the buyers into requests for quotation, closed when bought.',
      transitions: {
        submit: {
          from: ['draft', 'rejected'],
          to: 'to_approve',
          guard: records('purchase.request', async (requests) =>
            [...(await requests.load({ lines: true }))]
              .filter((r) => r.lines.length === 0)
              .map((r) => r.id),
          ),
          message: 'Add the products before submitting the request.',
          before: records('purchase.request', async (requests) => {
            for (const r of await requests.load({ lines: true }))
              for (const l of r.lines) await l.write({ qtyApproved: l.quantity } as never);
            await requests.write({ rejectReason: null } as never);
          }),
          after: records('purchase.request', async (requests) => {
            await requestApprovals(requests);
            for (const r of await requests.load({}))
              await requests.env.emit('purchase.request.submitted', { id: r.id });
          }),
        },
        approve: {
          from: ['to_approve'],
          to: 'approved',
          guard: records('purchase.request', (requests) => approvalGuard(requests)),
          message: 'Waiting for approvals.',
          after: records('purchase.request', async (requests) => {
            for (const r of await requests.load({}))
              await requests.env.emit('purchase.request.approved', { id: r.id });
          }),
        },
        reject: { from: ['to_approve'], to: 'rejected' },
        redraft: { from: ['rejected', 'cancel'], to: 'draft' },
        cancel: { from: ['draft', 'to_approve', 'rejected', 'approved'], to: 'cancel' },
        /** What is still to buy becomes requests for quotation, one per vendor (RFC 0032 §3.4). */
        rfq: {
          from: ['approved'],
          to: 'approved',
          requires: 'purchase.request_buy',
          guard: records('purchase.request', async (requests) =>
            [...(await requests.load({ lines: true }))]
              .filter((r) => [...r.lines].every((l) => (l.qtyRemaining ?? zero).lte(0)))
              .map((r) => r.id),
          ),
          message: 'Nothing is left to buy: every approved quantity is on a request for quotation.',
          after: records('purchase.request', async (requests) => {
            const env = requests.env as unknown as Env;
            await env.flush();
            for (const id of requests.ids) await createRfqs(env, id as number);
          }),
        },
        close: { from: ['approved'], to: 'done', requires: 'purchase.request_buy' },
      },
      extensible: true,
    }),
  },
  methods: {},
  onchange: {
    purpose: onchange('purchase.request', async (): Promise<void> => undefined),
  },
});

/**
 * One request for quotation per vendor for what a request still has to buy: the vendor the vendor prices choose for
 * each line (the cheapest that arrives in time, RFC 0030), else the request's preferred vendor; a line with neither
 * refuses the whole, naming the product. Lines link back to the request's lines; prices come from the vendor prices.
 */
export async function createRfqs(env: Env, id: number): Promise<number[]> {
  const [r] = await env
    .model('purchase.request')
    .browse([id as never])
    .load({ lines: { product: true, uom: true }, vendor: true, company: { currency: true } });
  if (r === undefined) return [];
  const owed = r.lines.filter((l) => (l.qtyRemaining ?? zero).gt(0));
  if (owed.length === 0) return [];
  type Owed = typeof owed extends Iterable<infer T> ? T : never;
  const byVendor = new Map<number, Owed[]>();
  const missing: string[] = [];
  for (const l of owed) {
    const choice = await vendorPriceFor(env as never, {
      product: l.product.id as number,
      quantity: l.qtyRemaining ?? zero,
      date: isoDay(env.today()),
      needBy: isoDay(l.dateRequired ?? r.dateRequired),
    });
    const vendor = choice?.vendor ?? (r.vendor?.id as number | undefined) ?? null;
    if (vendor === null) {
      missing.push(l.product.name);
      continue;
    }
    byVendor.set(vendor, [...(byVendor.get(vendor) ?? []), l]);
  }
  if (missing.length > 0)
    throw new orm.ValidationError(
      'purchase.request',
      ['vendor'],
      `No vendor for ${missing.join(', ')}.`,
      'Add a vendor price for the product (Purchase › Vendor prices) or choose a preferred vendor on the request.',
    );
  const made: number[] = [];
  for (const [vendor, lines] of byVendor) {
    // The vendor's currency, else the company's (what the form would fill in).
    const [partner] = await env
      .model('res.partner')
      .browse([vendor as never])
      .load({ currency: true });
    const order = await env.model('purchase.order').create([
      {
        partner: vendor,
        user: env.userId,
        company: r.company.id,
        currency: partner?.currency?.id ?? r.company.currency.id,
        origin: r.name,
        datePlanned: r.dateRequired,
        lines: {
          create: lines.map((l) => ({
            product: l.product.id,
            name: l.name ?? l.product.name,
            quantity: l.qtyRemaining,
            uom: l.uom?.id ?? null,
            datePlanned: l.dateRequired ?? r.dateRequired,
            requestLine: l.id,
          })),
        },
      },
    ] as never);
    made.push(order.ids[0] as number);
  }
  await env.emit('purchase.request.rfq', { id: r.id });
  return made;
}

export const PurchaseRequestLine = defineModel('purchase.request.line', {
  label: 'Purchase request line',
  order: ['request desc', 'id asc'],
  access: {
    'purchase.requester': ALL,
    'purchase.user': ALL,
    'purchase.manager': [...ALL, 'export', 'import'],
  },
  rules: {
    seeOwn: {
      groups: ['purchase.requester'],
      perms: ['read'],
      domain: { 'request.requester': me },
    },
    draftOwn: {
      groups: ['purchase.requester'],
      perms: ['write', 'create', 'unlink'],
      domain: { 'request.requester': me, 'request.state': { in: ['draft', 'rejected'] } },
    },
    buyers: {
      groups: ['purchase.user'],
      perms: ['read', 'write'],
      domain: { 'request.state': { in: ['to_approve', 'approved', 'done'] } },
    },
    all: { groups: ['purchase.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    request: f.many2one('purchase.request', {
      required: true,
      ondelete: 'cascade',
      label: 'Request',
    }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    name: f.char({ label: 'Description' }),
    uom: f.many2one('uom.uom', { ondelete: 'restrict', label: 'Unit' }),
    quantity: f.decimal({ scale: 3, required: true, default: '1', label: 'Requested' }),
    qtyApproved: f.decimal({
      scale: 3,
      label: 'Approved',
      help: 'As requested when submitted; an approver may lower it, never raise it.',
    }),
    dateRequired: f.date({ label: 'Needed by' }),
    buyers: f.many2many('res.users', {
      relation: 'purchase_request_line_buyer',
      label: 'Assigned to',
      help: 'The buyers who work this line.',
    }),
    purchaseLines: f.one2many('purchase.order.line', 'requestLine', { label: 'Order lines' }),
    qtyOnRfq: f.decimal({
      scale: 3,
      store: true,
      label: 'On RFQs',
      help: 'On requests for quotation not confirmed yet.',
      ...compute(
        'purchase.request.line',
        'qtyOnRfq',
        ['purchaseLines.quantity', 'purchaseLines.order.state'],
        (lines) => {
          for (const l of lines)
            l.qtyOnRfq = [...l.purchaseLines]
              .filter((p) => OPEN_ORDER.has(p.order.state) && !ORDERED.has(p.order.state))
              .reduce((s, p) => s.plus(p.quantity), zero);
        },
      ),
    }),
    qtyOrdered: f.decimal({
      scale: 3,
      store: true,
      label: 'Ordered',
      help: 'On confirmed purchase orders.',
      ...compute(
        'purchase.request.line',
        'qtyOrdered',
        ['purchaseLines.quantity', 'purchaseLines.order.state'],
        (lines) => {
          for (const l of lines)
            l.qtyOrdered = [...l.purchaseLines]
              .filter((p) => ORDERED.has(p.order.state))
              .reduce((s, p) => s.plus(p.quantity), zero);
        },
      ),
    }),
    qtyRemaining: f.decimal({
      scale: 3,
      store: true,
      label: 'To buy',
      help: 'Approved and on no request for quotation or order yet.',
      ...compute(
        'purchase.request.line',
        'qtyRemaining',
        ['qtyApproved', 'purchaseLines.quantity', 'purchaseLines.order.state', 'request.state'],
        (lines) => {
          for (const l of lines) {
            if (l.request.state !== 'approved') {
              l.qtyRemaining = zero;
              continue;
            }
            const covered = [...l.purchaseLines]
              .filter((p) => OPEN_ORDER.has(p.order.state))
              .reduce((s, p) => s.plus(p.quantity), zero);
            const left = (l.qtyApproved ?? zero).minus(covered);
            l.qtyRemaining = left.gt(0) ? left : zero;
          }
        },
      ),
    }),
    status: f.selection(
      {
        draft: 'Draft',
        to_approve: 'Waiting for approval',
        approved: 'Approved',
        rfq: 'RFQ made',
        ordered: 'Ordered',
        done: 'Done',
        cancelled: 'Cancelled',
      },
      {
        store: true,
        label: 'Status',
        help: 'Where the line is in the chain: approved, on a request for quotation, on a confirmed order, done.',
        ...compute(
          'purchase.request.line',
          'status',
          ['request.state', 'qtyApproved', 'qtyOnRfq', 'qtyOrdered'],
          (lines) => {
            for (const l of lines) {
              const s = l.request.state;
              l.status =
                s === 'cancel' || s === 'rejected'
                  ? 'cancelled'
                  : s === 'draft'
                    ? 'draft'
                    : s === 'to_approve'
                      ? 'to_approve'
                      : s === 'done'
                        ? 'done'
                        : (l.qtyOrdered ?? zero).gte(l.qtyApproved ?? zero) &&
                            (l.qtyApproved ?? zero).gt(0)
                          ? 'ordered'
                          : (l.qtyOnRfq ?? zero).plus(l.qtyOrdered ?? zero).gt(0)
                            ? 'rfq'
                            : 'approved';
            }
          },
        ),
      },
    ),
  },
  sqlConstraints: {
    positive: {
      check: orm.sql`quantity > 0 AND (qty_approved IS NULL OR qty_approved >= 0)`,
      message: 'Requested quantities are positive.',
    },
  },
  constraints: {
    notAbove: {
      ...check('purchase.request.line', ['quantity', 'qtyApproved'], async (lines) =>
        [...lines]
          .filter((l) => l.qtyApproved !== null && l.qtyApproved.gt(l.quantity))
          .map((l) => l.id),
      ),
      message: 'An approved quantity is never above the requested one.',
    },
  },
  onchange: {
    product: onchange('purchase.request.line', async (d): Promise<void> => {
      const product = (await d.record('product')) as {
        name: string;
        uom: { id: number } | null;
      } | null;
      if (product === null) return;
      if (product.uom !== null) d.set('uom', product.uom.id as never);
      if ((d.get('name') ?? '') === '') d.set('name', product.name);
    }),
  },
});
