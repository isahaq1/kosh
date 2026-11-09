/**
 * Purchase agreements, work acceptance and vendor requests (RFC 0032 §3.4, after Paragon's procurement chain):
 *
 * - an **agreement** (a blanket order) fixes a vendor's prices and quantities for a period; orders that name it take
 *   its prices and may not go beyond its quantities or dates;
 * - a **work acceptance** records what a vendor's service was accepted, per order line, so a service line is billed
 *   up to what was accepted once an acceptance exists for the order;
 * - a **vendor request** asks for a new vendor — the name, address, NID, trade licence, proprietor —, approved
 *   through the approval engine; approved, the contact is made and marked a vendor; until then nobody can order
 *   from them.
 */
import { approvalGuard, requestApprovals } from '@kosh/permissions';
import { type Decimal, orm } from '@kosh/server/orm';
import { compute, defineModel, type Env, f, onchange, records } from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink'] as const;
const me = { $env: 'uid' } as const;
const zero: Decimal = orm.toDecimal(0);
const ORDERED = new Set(['purchase', 'done']);

export const PurchaseAgreement = defineModel('purchase.agreement', {
  label: 'Purchase agreement',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'vendor', 'dateStart', 'dateEnd'],
  access: { 'purchase.user': ALL, 'purchase.manager': [...ALL, 'export', 'import'] },
  rules: { all: { groups: ['purchase.user'], perms: [...ALL], domain: {} } },
  fields: {
    name: f.char({ required: true, sequence: 'purchase.agreement', label: 'Agreement' }),
    vendor: f.many2one('res.partner', { required: true, ondelete: 'restrict' }),
    buyer: f.many2one('res.users', {
      required: true,
      ondelete: 'restrict',
      default: (env: Env) => env.userId,
    }),
    kind: f.selection(
      { blanket: 'Blanket order', contract: 'Framework contract' },
      {
        required: true,
        default: 'blanket',
        label: 'Agreement type',
        help: 'A blanket order fixes quantities and prices to call off; a framework contract fixes prices only.',
      },
    ),
    reference: f.char({ label: 'Vendor reference' }),
    dateStart: f.date({ label: 'Valid from' }),
    dateEnd: f.date({ label: 'Valid to' }),
    currency: f.many2one('res.currency', { ondelete: 'restrict' }),
    note: f.text({ label: 'Terms and conditions' }),
    lines: f.one2many('purchase.agreement.line', 'agreement', { label: 'Products' }),
    orders: f.one2many('purchase.order', 'agreement', { label: 'Orders' }),
    state: f.state({
      states: { draft: 'Draft', confirmed: 'Confirmed', closed: 'Closed', cancel: 'Cancelled' },
      initial: 'draft',
      help: 'Drafted, confirmed (orders may draw on it), closed when spent or over.',
      transitions: {
        confirm: {
          from: ['draft'],
          to: 'confirmed',
          guard: records('purchase.agreement', async (agreements) =>
            [...(await agreements.load({ lines: true }))]
              .filter((a) => a.lines.length === 0)
              .map((a) => a.id),
          ),
          message: 'Add the products first.',
          after: records('purchase.agreement', async (agreements) => {
            for (const a of await agreements.load({}))
              await agreements.env.emit('purchase.agreement.confirmed', { id: a.id });
          }),
        },
        close: { from: ['confirmed'], to: 'closed' },
        cancel: { from: ['draft', 'confirmed'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
    }),
  },
  sqlConstraints: {
    endsAfterStart: {
      check: orm.sql`date_end IS NULL OR date_start IS NULL OR date_end >= date_start`,
      message: 'An agreement ends after it starts.',
    },
  },
  onchange: {
    vendor: onchange('purchase.agreement', async (d): Promise<void> => {
      const vendor = (await d.record('vendor')) as { currency: { id: number } | null } | null;
      if (vendor?.currency && (d.get('currency') ?? null) === null)
        d.set('currency', vendor.currency.id as never);
    }),
  },
});

export const PurchaseAgreementLine = defineModel('purchase.agreement.line', {
  label: 'Agreement line',
  order: ['agreement desc', 'id asc'],
  access: { 'purchase.user': ALL, 'purchase.manager': [...ALL, 'export', 'import'] },
  rules: { all: { groups: ['purchase.user'], perms: [...ALL], domain: {} } },
  fields: {
    agreement: f.many2one('purchase.agreement', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    name: f.char({ label: 'Description' }),
    quantity: f.decimal({
      scale: 3,
      label: 'Quantity',
      help: 'What may be ordered on the agreement in all; empty: no limit.',
    }),
    uom: f.many2one('uom.uom', { ondelete: 'restrict', label: 'Unit' }),
    priceUnit: f.decimal({ scale: 2, required: true, default: '0', label: 'Unit price' }),
    qtyOrdered: f.decimal({
      scale: 3,
      store: true,
      label: 'Ordered',
      help: 'On confirmed orders that name the agreement.',
      ...compute(
        'purchase.agreement.line',
        'qtyOrdered',
        [
          'product',
          'agreement.orders.state',
          'agreement.orders.lines.product',
          'agreement.orders.lines.quantity',
        ],
        (lines) => {
          for (const l of lines) {
            let total = zero;
            for (const o of l.agreement.orders) {
              if (!ORDERED.has(o.state)) continue;
              for (const ol of o.lines)
                if (ol.product.id === l.product.id) total = total.plus(ol.quantity);
            }
            l.qtyOrdered = total;
          }
        },
      ),
    }),
  },
  onchange: {
    product: onchange('purchase.agreement.line', async (d): Promise<void> => {
      const product = (await d.record('product')) as {
        name: string;
        uom: { id: number } | null;
        standardPrice: Decimal | null;
      } | null;
      if (product === null) return;
      if (product.uom !== null) d.set('uom', product.uom.id as never);
      if ((d.get('name') ?? '') === '') d.set('name', product.name);
      if (orm.toDecimal(String(d.get('priceUnit') ?? '0')).eq(0) && product.standardPrice !== null)
        d.set('priceUnit', product.standardPrice.toString() as never);
    }),
  },
});

/** The agreement's price for a product, when the order names one that is confirmed and in its dates. */
export async function agreementPriceFor(
  env: Env,
  agreementId: number,
  productId: number,
  date: string,
): Promise<{ price: Decimal; name: string } | null> {
  const [a] = await env
    .model('purchase.agreement')
    .browse([agreementId as never])
    .load({ lines: { product: true } });
  if (a === undefined || a.state !== 'confirmed') return null;
  const from = a.dateStart === null ? null : String(a.dateStart).slice(0, 10);
  const to = a.dateEnd === null ? null : String(a.dateEnd).slice(0, 10);
  if ((from !== null && date < from) || (to !== null && date > to)) return null;
  const line = [...a.lines].find((l) => l.product.id === productId);
  return line === undefined ? null : { price: line.priceUnit, name: a.name };
}

/**
 * Refuses an order that goes beyond its agreement (RFC 0032 §3.4): outside its dates, a product it does not
 * cover, or more than its quantity counting the confirmed orders.
 */
export async function checkAgreement(env: Env, orderIds: readonly number[]): Promise<void> {
  for (const o of await env
    .model('purchase.order')
    .browse([...orderIds] as never)
    .load({ agreement: { lines: { product: true } }, lines: { product: true } })) {
    const a = o.agreement;
    if (a === null) continue;
    const refuse = (problem: string) => {
      throw new orm.ValidationError(
        'purchase.order',
        ['agreement'],
        `${o.name} goes beyond agreement ${a.name}: ${problem}`,
        'Change the order, or the agreement.',
      );
    };
    if (a.state !== 'confirmed') refuse('the agreement is not confirmed.');
    const date = String(o.dateOrder).slice(0, 10);
    const from = a.dateStart === null ? null : String(a.dateStart).slice(0, 10);
    const to = a.dateEnd === null ? null : String(a.dateEnd).slice(0, 10);
    if ((from !== null && date < from) || (to !== null && date > to))
      refuse('the order date is outside its validity.');
    for (const l of o.lines) {
      const al = [...a.lines].find((x) => x.product.id === l.product.id);
      if (al === undefined) refuse(`${l.product.name} is not on it.`);
      else if (al.quantity !== null && (al.qtyOrdered ?? zero).plus(l.quantity).gt(al.quantity))
        refuse(
          `${l.product.name}: ${al.qtyOrdered?.toString() ?? '0'} ordered already, ${l.quantity.toString()} more would pass ${al.quantity.toString()}.`,
        );
    }
  }
}

export const PurchaseWorkAcceptance = defineModel('purchase.work.acceptance', {
  label: 'Work acceptance',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'order', 'amountTotal'],
  access: { 'purchase.user': ALL, 'purchase.manager': [...ALL, 'export', 'import'] },
  rules: { all: { groups: ['purchase.user'], perms: [...ALL], domain: {} } },
  fields: {
    name: f.char({ required: true, sequence: 'purchase.work.acceptance', label: 'Reference' }),
    vendor: f.many2one('res.partner', { required: true, ondelete: 'restrict' }),
    order: f.many2one('purchase.order', {
      required: true,
      ondelete: 'restrict',
      label: 'Purchase order',
    }),
    responsible: f.many2one('res.users', {
      required: true,
      ondelete: 'restrict',
      default: (env: Env) => env.userId,
      label: 'Responsible person',
    }),
    invoiceReference: f.char({ label: 'Vendor invoice reference' }),
    dueDate: f.date({ required: true, label: 'Due date', default: (env: Env) => env.today() }),
    acceptedOn: f.date({ label: 'Accepted on' }),
    currency: f.many2one('res.currency', { ondelete: 'restrict' }),
    note: f.text({ label: 'Terms and conditions' }),
    lines: f.one2many('purchase.work.acceptance.line', 'acceptance', { label: 'Work accepted' }),
    amountTotal: f.decimal({
      scale: 2,
      store: true,
      label: 'Total',
      help: 'The accepted lines at their prices.',
      ...compute('purchase.work.acceptance', 'amountTotal', ['lines.subtotal'], (acceptances) => {
        for (const a of acceptances)
          a.amountTotal = [...a.lines].reduce((s, l) => s.plus(l.subtotal ?? zero), zero);
      }),
    }),
    state: f.state({
      states: { draft: 'Draft', accepted: 'Accepted', cancel: 'Cancelled' },
      initial: 'draft',
      help: 'Drafted from the order; accepted once the work is checked: the service may then be billed up to it.',
      transitions: {
        /** The order's service lines, with what is left to accept. */
        fill: {
          from: ['draft'],
          to: 'draft',
          after: records('purchase.work.acceptance', async (acceptances) => {
            const env = acceptances.env as unknown as Env;
            for (const a of await acceptances.load({ lines: true, order: true })) {
              await env
                .model('purchase.work.acceptance.line')
                .browse([...a.lines].map((l) => l.id))
                .unlink();
              const lines = await (
                await env.model('purchase.order.line').search({ where: { order: a.order.id } })
              ).load({ product: true, uom: true });
              const rows = [...lines]
                .filter((l) => l.product.kind === 'service')
                .map((l) => ({
                  acceptance: a.id,
                  orderLine: l.id,
                  product: l.product.id,
                  name: l.name,
                  quantity: l.quantity.minus(l.qtyAccepted ?? zero),
                  uom: l.uom?.id ?? null,
                  priceUnit: l.priceUnit,
                }))
                .filter((r) => r.quantity.gt(0));
              if (rows.length > 0)
                await env.model('purchase.work.acceptance.line').create(rows as never);
            }
          }),
        },
        accept: {
          from: ['draft'],
          to: 'accepted',
          guard: records('purchase.work.acceptance', async (acceptances) =>
            [...(await acceptances.load({ lines: true }))]
              .filter((a) => a.lines.length === 0)
              .map((a) => a.id),
          ),
          message: 'Add the work accepted first.',
          after: records('purchase.work.acceptance', async (acceptances) => {
            const env = acceptances.env as unknown as Env;
            await acceptances.write({ acceptedOn: env.today() } as never);
            for (const a of await acceptances.load({}))
              await env.emit('purchase.work_acceptance.accepted', { id: a.id });
          }),
        },
        cancel: { from: ['draft', 'accepted'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
    }),
  },
  onchange: {
    // The order's vendor and currency; Fill brings its service lines.
    order: onchange('purchase.work.acceptance', async (d, env): Promise<void> => {
      const order = (await d.record('order')) as {
        id: number;
        partner: { id: number };
        currency: { id: number } | null;
      } | null;
      if (order === null) return;
      d.set('vendor', order.partner.id as never);
      if (order.currency !== null) d.set('currency', order.currency.id as never);
    }),
  },
});

export const PurchaseWorkAcceptanceLine = defineModel('purchase.work.acceptance.line', {
  label: 'Work accepted',
  order: ['acceptance desc', 'id asc'],
  access: { 'purchase.user': ALL, 'purchase.manager': [...ALL, 'export', 'import'] },
  rules: { all: { groups: ['purchase.user'], perms: [...ALL], domain: {} } },
  fields: {
    acceptance: f.many2one('purchase.work.acceptance', { required: true, ondelete: 'cascade' }),
    orderLine: f.many2one('purchase.order.line', {
      required: true,
      ondelete: 'restrict',
      label: 'Order line',
    }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    name: f.char({ label: 'Description' }),
    quantity: f.decimal({ scale: 3, required: true, default: '1', label: 'Accepted' }),
    uom: f.many2one('uom.uom', { ondelete: 'restrict', label: 'Unit' }),
    priceUnit: f.decimal({ scale: 2, required: true, default: '0', label: 'Unit price' }),
    subtotal: f.decimal({
      scale: 2,
      store: true,
      help: 'The accepted quantity at the price.',
      ...compute(
        'purchase.work.acceptance.line',
        'subtotal',
        ['quantity', 'priceUnit'],
        (lines) => {
          for (const l of lines) l.subtotal = l.quantity.times(l.priceUnit).toDecimalPlaces(2);
        },
      ),
    }),
  },
  sqlConstraints: {
    positive: { check: orm.sql`quantity > 0`, message: 'Accepted quantities are positive.' },
  },
});

export const PurchaseVendorRequest = defineModel('purchase.vendor.request', {
  label: 'Vendor request',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'name'],
  access: {
    'purchase.requester': ALL,
    'purchase.user': ALL,
    'purchase.manager': [...ALL, 'export', 'import'],
  },
  rules: {
    seeOwn: { groups: ['purchase.requester'], perms: ['read'], domain: { requester: me } },
    draftOwn: {
      groups: ['purchase.requester'],
      perms: ['write', 'create', 'unlink'],
      domain: { requester: me, state: { in: ['draft', 'rejected'] } },
    },
    buyers: { groups: ['purchase.user'], perms: ['read', 'write'], domain: {} },
    all: { groups: ['purchase.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, label: 'Vendor name' }),
    kind: f.selection(
      { vendor: 'Vendor', contractor: 'Contractor', service: 'Service provider' },
      {
        required: true,
        default: 'vendor',
        label: 'Request type',
        help: 'What the new contact supplies.',
      },
    ),
    street: f.char(),
    street2: f.char({ label: 'Street 2' }),
    city: f.char(),
    zip: f.char({ label: 'Postal code' }),
    country: f.char({ size: 2, default: 'BD', help: 'The two-letter country code (BD, IN).' }),
    nid: f.char({ label: 'NID / birth certificate' }),
    tradeLicense: f.char({ label: 'Trade licence number' }),
    proprietorName: f.char({ label: 'Proprietor name' }),
    proprietorMobile: f.char({ label: 'Proprietor mobile' }),
    email: f.char(),
    phone: f.char(),
    requester: f.many2one('res.users', {
      required: true,
      ondelete: 'restrict',
      default: (env: Env) => env.userId,
      label: 'Requested by',
    }),
    date: f.date({ required: true, default: (env: Env) => env.today(), label: 'Request date' }),
    partner: f.many2one('res.partner', { ondelete: 'set null', label: 'Vendor made' }),
    rejectReason: f.char({ size: 300, label: 'Rejected because' }),
    note: f.text(),
    state: f.state({
      states: {
        draft: 'Draft',
        to_approve: 'Waiting approval',
        approved: 'Approved',
        rejected: 'Rejected',
      },
      initial: 'draft',
      help: 'Drafted, submitted for approval; approved, the vendor is made as a contact nobody could order from before.',
      transitions: {
        submit: {
          from: ['draft', 'rejected'],
          to: 'to_approve',
          after: records('purchase.vendor.request', async (requests) => {
            await requests.write({ rejectReason: null } as never);
            await requestApprovals(requests);
            for (const r of await requests.load({}))
              await requests.env.emit('purchase.vendor_request.submitted', { id: r.id });
          }),
        },
        approve: {
          from: ['to_approve'],
          to: 'approved',
          guard: records('purchase.vendor.request', (requests) => approvalGuard(requests)),
          message: 'Waiting for approvals.',
          after: records('purchase.vendor.request', async (requests) => {
            const env = requests.env as unknown as Env;
            await env.flush();
            for (const id of requests.ids) await makeVendor(env, id as number);
          }),
        },
        reject: { from: ['to_approve'], to: 'rejected' },
        redraft: { from: ['rejected'], to: 'draft' },
      },
    }),
  },
});

/** The approved request's contact, marked a vendor, made once (as the system: the requester need not edit contacts). */
async function makeVendor(env: Env, id: number): Promise<void> {
  await env.asSuperuser({ reason: 'vendor from an approved request' }, async (su) => {
    const [r] = await su
      .model('purchase.vendor.request')
      .browse([id as never])
      .load({ partner: true, company: true, requester: true });
    if (r === undefined || r.partner !== null) return;
    const made = await su.model('res.partner').create([
      {
        name: r.name,
        isVendor: true,
        isCompany: true,
        street: [r.street, r.street2].filter((x) => x !== null && x !== '').join(', ') || null,
        city: r.city,
        zip: r.zip,
        country: r.country,
        email: r.email,
        phone: r.phone,
        mobile: r.proprietorMobile,
        notes: [
          r.proprietorName === null ? null : `Proprietor: ${r.proprietorName}`,
          r.nid === null ? null : `NID: ${r.nid}`,
          r.tradeLicense === null ? null : `Trade licence: ${r.tradeLicense}`,
          `From vendor request by ${r.requester.name}.`,
        ]
          .filter((x) => x !== null)
          .join('\n'),
      },
    ] as never);
    await su
      .model('purchase.vendor.request')
      .browse([id as never])
      .write({ partner: made.ids[0] } as never);
    await su.emit('purchase.vendor_request.approved', { id });
  });
}
