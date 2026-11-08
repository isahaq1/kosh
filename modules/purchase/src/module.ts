/**
 * The data layer of Purchase (Shutro): requests for quotation and purchase orders to vendors. Numbered when created
 * (PO/2026/00001), amounts computed from the lines in the order's currency, prices defaulting to the product cost,
 * and multi-level approvals (RFC 0003 §5.3): submitting an order asks the approvers its amount needs; the last
 * approval confirms it, a rejection sends it back to draft. Buyers see their own orders; managers see all.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { approvalGuard, permissionsShutro, requestApprovals } from '@kosh/permissions';
import { computeTaxes, productShutro, taxRule } from '@kosh/product';
import { orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  method,
  onchange,
  records,
} from './.kosh/bindings.js';
import { PurchaseRequest, PurchaseRequestLine } from './request.js';
import { ProductVendorPrice, vendorPriceFor } from './vendorprice.js';

type Decimal = ReturnType<typeof orm.toDecimal>;

/** A line's taxes through the engine (RFC 0016): its amount, its taxes in order. */
function taxesOf(l: {
  readonly quantity: ReturnType<typeof orm.toDecimal>;
  readonly priceUnit: ReturnType<typeof orm.toDecimal> | null;
  readonly taxes: Iterable<Parameters<typeof taxRule>[0]>;
}) {
  return computeTaxes(
    l.quantity.times(l.priceUnit ?? orm.toDecimal('0')),
    l.quantity,
    [...l.taxes].map(taxRule),
  );
}

const amounts = compute(
  'purchase.order',
  ['amountUntaxed', 'amountTax', 'amountTotal'],
  ['lines.subtotal', 'lines.taxAmount'],
  (orders) => {
    for (const o of orders) {
      // A new order has no currency until its partner is chosen: no amounts yet.
      if (o.currency === null) {
        o.amountUntaxed = null;
        o.amountTax = null;
        o.amountTotal = null;
        continue;
      }
      const untaxed = o.lines.sum('subtotal', o.currency);
      const tax = o.lines.sum('taxAmount', o.currency);
      o.amountUntaxed = untaxed;
      o.amountTax = tax;
      o.amountTotal = untaxed.plus(tax);
    }
  },
);

export const PurchaseOrder = defineModel('purchase.order', {
  label: 'Purchase order',
  companyScoped: { required: true },
  order: ['dateOrder desc', 'id desc'],
  tracking: ['partner', 'amountTotal', 'state'],
  access: {
    'purchase.user': ['read', 'write', 'create'],
    'purchase.manager': ['read', 'write', 'create', 'unlink', 'export', 'import'],
  },
  rules: {
    own: { groups: ['purchase.user'], perms: ['read', 'write'], domain: { user: { $env: 'uid' } } },
    all: { groups: ['purchase.manager'], perms: ['read', 'write', 'create', 'unlink'], domain: {} },
  },
  fields: {
    name: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'purchase.order', dateField: 'dateOrder' },
      label: 'Number',
    }),
    user: f.many2one('res.users', {
      required: true,
      default: (env: Env) => env.userId,
      label: 'Buyer',
    }),
    partner: f.many2one('res.partner', { required: true, checkCompany: true, label: 'Vendor' }),
    partnerReference: f.char({ label: 'Vendor reference' }),
    currency: f.many2one('res.currency', { required: true }),
    dateOrder: f.date({ required: true, default: (env: Env) => env.today(), label: 'Order date' }),
    datePlanned: f.date({ label: 'Expected arrival' }),
    origin: f.char({ label: 'Source document' }),
    note: f.text({ label: 'Terms and conditions' }),
    lines: f.one2many('purchase.order.line', 'order'),
    amountUntaxed: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Untaxed',
      help: 'The sum of the lines’ amounts before taxes.',
      ...amounts,
    }),
    amountTax: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Taxes',
      help: 'The sum of the taxes on the lines.',
      ...amounts,
    }),
    amountTotal: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Total',
      help: 'What the order costs with its taxes: the untaxed amount plus the taxes.',
      ...amounts,
    }),
    state: f.state({
      help: 'A request for quotation until it is submitted; once approved it becomes a purchase order, which can then be locked or cancelled.',
      states: {
        draft: 'RFQ',
        sent: 'RFQ sent',
        to_approve: 'Waiting approval',
        purchase: 'Purchase order',
        done: 'Locked',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      transitions: {
        send: { from: ['draft'], to: 'sent' },
        submit: {
          from: ['draft', 'sent'],
          to: 'to_approve',
          guard: records('purchase.order', async (orders) => {
            const loaded = await orders.load({ lines: true });
            return loaded.filter((o) => o.lines.length === 0);
          }),
          message: 'Add at least one line before submitting the order.',
          // Other apps check the order first (account_budget: its budgets); then the approvals are asked for.
          before: records('purchase.order', async (orders) => {
            const env = orders.env as unknown as Env;
            await env.model('purchase.order').browse(orders.ids).submitting();
          }),
          after: records('purchase.order', (orders) => requestApprovals(orders)),
        },
        confirm: {
          from: ['to_approve'],
          to: 'purchase',
          guard: records('purchase.order', (orders) => approvalGuard(orders)),
          message: 'Waiting for approvals.',
          // Other apps act on a confirmation through the outbox (purchase_stock makes the receipt).
          after: records('purchase.order', async (orders) => {
            for (const o of await orders.load({}))
              await orders.env.emit('purchase.order.confirmed', { id: o.id });
          }),
        },
        reject: { from: ['to_approve'], to: 'draft' },
        lock: { from: ['purchase'], to: 'done' },
        unlock: { from: ['done'], to: 'purchase' },
        cancel: { from: ['draft', 'sent', 'to_approve', 'purchase'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
      extensible: true, // Accounting adds billing through its bridge
    }),
  },
  methods: {
    /** Before the approvals of a submission: nothing here; account_budget checks the budgets. */
    submitting: method('purchase.order', async () => undefined),
    /**
     * The approvers each order names for an approval level where "the record decides" (RFC 0027 §2.1): the approvers
     * of its lines' product categories (the nearest category up the tree that names some).
     */
    approvalUsers: method('purchase.order', async function (this: unknown, _key: string): Promise<
      Map<number, number[]>
    > {
      const orders = this as { env: Env; ids: readonly number[] };
      const out = new Map<number, number[]>();
      for (const order of await orders.env
        .model('purchase.order')
        .browse([...orders.ids] as never)
        .load({ lines: { product: { category: true } } })) {
        const people = new Set<number>();
        for (const line of order.lines) {
          let category = line.product?.category?.id as number | undefined;
          for (let depth = 0; category !== undefined && depth < 10; depth += 1) {
            const [c] = await orders.env
              .model('product.category')
              .browse([category as never])
              .load({ approvalUsers: true, parent: true });
            const users = (c?.approvalUsers ?? []) as readonly { id: unknown }[];
            if (users.length > 0) {
              for (const u of users) people.add(u.id as number);
              break;
            }
            category = c?.parent?.id as number | undefined;
          }
        }
        out.set(order.id as number, [...people]);
      }
      return out;
    }),
  },
  onchange: {
    // The vendor's currency, else the company's; empty terms from the company's settings.
    partner: onchange('purchase.order', async (d, env) => {
      if ((d.get('note') ?? '') === '') {
        const [company] = (
          await env.model('res.company').browse([env.companyId]).load(['purchaseTerms'])
        ).read(['purchaseTerms']);
        const terms = company?.['purchaseTerms'];
        if (typeof terms === 'string' && terms !== '') d.set('note', terms);
      }
      const p = await d.record('partner');
      if (p?.currency) {
        d.set('currency', p.currency.id);
        return;
      }
      const [company] = await env
        .model('res.company')
        .browse([env.companyId])
        .load({ currency: true });
      if (company !== undefined) d.set('currency', company.currency.id);
    }),
  },
});

/** The company's purchase settings (RFC 0020): the terms new orders start with. */
export const CompanyPurchase = extendModel('res.company', {
  fields: {
    purchaseTerms: f.text({ label: 'Default terms and conditions' }),
  },
});

/** A purchase line's price and why (RFC 0030 §3.1): typed in, else the vendor's price, else the product's cost. */
async function purchaseLinePrice(l: {
  readonly env: unknown;
  readonly manualPrice: Decimal | null;
  readonly product: { readonly id: unknown; readonly standardPrice?: Decimal } | null;
  readonly quantity: Decimal;
  readonly order: {
    readonly partner: { readonly id: unknown } | null;
    readonly dateOrder: unknown;
    readonly currency: { readonly id: unknown } | null;
  } | null;
}): Promise<{ price: Decimal; reason: string | null; code: string | null }> {
  if (l.manualPrice !== null) return { price: l.manualPrice, reason: 'Typed in.', code: null };
  if (l.product === null) return { price: orm.toDecimal('0'), reason: null, code: null };
  const env = l.env as Env;
  const date = String(l.order?.dateOrder ?? env.today()).slice(0, 10);
  const vendor = (l.order?.partner?.id as number | undefined) ?? null;
  const choice =
    vendor === null
      ? null
      : await vendorPriceFor(env, {
          product: l.product.id as number,
          quantity: l.quantity,
          date,
          vendor,
          currency: (l.order?.currency?.id as number | undefined) ?? null,
        });
  if (choice !== null)
    return { price: choice.price, reason: choice.explanation, code: choice.vendorCode };
  const [product] = await env
    .model('product.product')
    .browse([l.product.id as never])
    .load(['standardPrice']);
  return {
    price: product?.standardPrice ?? orm.toDecimal('0'),
    reason: 'The product’s cost: this vendor has no price for it.',
    code: null,
  };
}

const PRICE_DEPENDS = [
  'product',
  'quantity',
  'manualPrice',
  'order.partner',
  'order.dateOrder',
  'order.currency',
] as const;

export const PurchaseOrderLine = defineModel('purchase.order.line', {
  label: 'Purchase line',
  access: {
    'purchase.user': ['read', 'write', 'create', 'unlink'],
    'purchase.manager': ['read', 'write', 'create', 'unlink'],
  },
  fields: {
    order: f.many2one('purchase.order', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', { required: true }),
    name: f.char({ required: true, label: 'Description' }),
    quantity: f.decimal({ scale: 3, required: true, default: '1' }),
    uom: f.many2one('uom.uom', { label: 'Unit' }),
    /**
     * The unit price: the one typed in, else the vendor's price for the quantity and date (RFC 0030 §3.1), else the
     * product's cost. Typing a price keeps it (`manualPrice`).
     */
    priceUnit: f.decimal({
      scale: 2,
      store: true,
      label: 'Unit price',
      help: 'The price typed in, else the vendor’s price for this quantity and date (see why on the line), else the product’s cost.',
      ...compute('purchase.order.line', 'priceUnit', [...PRICE_DEPENDS], async (lines) => {
        for (const l of lines) l.priceUnit = (await purchaseLinePrice(l)).price;
      }),
      inverse: async (records: never) => {
        const lines = records as Iterable<{ id: number; priceUnit: Decimal | null }>;
        const env = (records as { env: Env }).env;
        for (const l of lines)
          await env
            .model('purchase.order.line')
            .browse([l.id as never])
            .write({ manualPrice: l.priceUnit });
      },
    }),
    /** The price typed in, kept when the product, the quantity or the vendor changes (empty: the vendor's price). */
    manualPrice: f.decimal({ scale: 2, label: 'Price typed in' }),
    /** Why the line has its price: the vendor price and its break, or "typed in". */
    priceReason: f.char({
      store: true,
      label: 'Why this price',
      ...compute('purchase.order.line', 'priceReason', [...PRICE_DEPENDS], async (lines) => {
        for (const l of lines) l.priceReason = (await purchaseLinePrice(l)).reason;
      }),
    }),
    /** The vendor's own code for the product, from their price. */
    vendorCode: f.char({
      store: true,
      label: 'Vendor’s code',
      ...compute('purchase.order.line', 'vendorCode', [...PRICE_DEPENDS], async (lines) => {
        for (const l of lines) l.vendorCode = (await purchaseLinePrice(l)).code;
      }),
    }),
    /** The line's taxes, applied in order (RFC 0016). */
    taxes: f.many2many('account.tax'),
    /** Before 0.2.0, one tax per line: copied into `taxes` by the migration; dropped later. */
    tax: f.many2one('account.tax', { label: 'Tax (before 0.2.0)', readonly: true }),
    datePlanned: f.date({ label: 'Expected arrival' }),
    /** The purchase request line this one buys for (RFC 0032 §3.4). */
    requestLine: f.many2one('purchase.request.line', {
      ondelete: 'set null',
      label: 'Request line',
    }),
    currency: f.many2one('res.currency', {
      store: true,
      ...compute('purchase.order.line', 'currency', ['order.currency'], (lines) => {
        for (const l of lines) l.currency = l.order.currency.id;
      }),
    }),
    subtotal: f.monetary({
      currency: 'currency',
      store: true,
      help: 'The line’s amount before taxes: the quantity times the unit price, less any tax included in the price.',
      ...compute(
        'purchase.order.line',
        'subtotal',
        [
          'quantity',
          'priceUnit',
          'taxes.rate',
          'taxes.sequence',
          'taxes.amountType',
          'taxes.fixedAmount',
          'taxes.affectsBase',
          'taxes.priceIncluded',
          'taxes.reverseCharge',
        ],
        (lines) => {
          for (const l of lines) l.subtotal = taxesOf(l).untaxed;
        },
      ),
    }),
    taxAmount: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Tax',
      help: 'The taxes on this line, computed from its amount and its taxes.',
      ...compute(
        'purchase.order.line',
        'taxAmount',
        [
          'quantity',
          'priceUnit',
          'taxes.rate',
          'taxes.sequence',
          'taxes.amountType',
          'taxes.fixedAmount',
          'taxes.affectsBase',
          'taxes.priceIncluded',
          'taxes.reverseCharge',
        ],
        (lines) => {
          for (const l of lines) l.taxAmount = taxesOf(l).taxTotal;
        },
      ),
    }),
  },
  onchange: {
    product: onchange('purchase.order.line', async (d, env) => {
      const p = await d.record('product');
      if (p === null) return;
      d.set('name', p.name);
      d.set('uom', p.uom?.id ?? null);
      // The product's taxes, loaded (a draft's related record has its plain fields only).
      const [taxed] = await env
        .model('product.product')
        .browse([p.id])
        .load({ purchaseTaxes: true });
      d.set('taxes', { set: [...(taxed?.purchaseTaxes.ids ?? [])] });
    }),
  },
  constraints: {
    positiveQuantity: {
      ...check('purchase.order.line', ['quantity'], (lines) =>
        lines.filter((l) => l.quantity.lte(0)),
      ),
      message: 'Line quantities must be positive.',
    },
  },
});

export const purchaseShutro = defineModule({
  name: 'purchase',
  version: '0.4.0',
  migrations: [
    {
      version: '0.4.0',
      description:
        'Vendor prices: existing lines keep the price they have, as typed in (no order is repriced)',
      up: async (ctx) => {
        await ctx.sql`UPDATE purchase_order_line SET manual_price = price_unit WHERE manual_price IS NULL`;
        await ctx.sql`UPDATE purchase_order_line SET price_reason = 'Typed in.' WHERE price_reason IS NULL`;
      },
    },
    {
      version: '0.2.0',
      description: 'Several taxes per line: the single tax of each line becomes its first',
      up: async (ctx) => {
        await ctx.sql`INSERT INTO purchase_order_line_account_tax_rel (purchase_order_line_id, account_tax_id)
          SELECT id, tax_id FROM purchase_order_line WHERE tax_id IS NOT NULL ON CONFLICT DO NOTHING`;
      },
    },
  ],
  depends: [contactsShutro, productShutro, messagingShutro, permissionsShutro],
  groups: [
    orm.defineGroup({
      code: 'purchase.requester',
      label: 'Purchase requester',
      implies: ['product.user', 'messaging.user'],
    }),
    orm.defineGroup({
      code: 'purchase.user',
      label: 'Buyer',
      implies: ['purchase.requester', 'contacts.user', 'product.user', 'messaging.user'],
    }),
    orm.defineGroup({
      code: 'purchase.manager',
      label: 'Purchase manager',
      implies: ['purchase.user'],
    }),
    orm.defineGroup({
      code: 'purchase.director',
      label: 'Purchase director',
      implies: ['purchase.manager'],
    }),
  ],
  permissions: [
    orm.definePermission({
      code: 'purchase.request_buy',
      label: 'Turn purchase requests into requests for quotation',
      groups: ['purchase.user'],
    }),
  ],
  sequences: [
    orm.defineSequence({
      code: 'purchase.order',
      prefix: 'PO/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
    orm.defineSequence({
      code: 'purchase.request',
      prefix: 'PR/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
  ],
  models: [
    PurchaseOrder,
    PurchaseOrderLine,
    ProductVendorPrice,
    PurchaseRequest,
    PurchaseRequestLine,
  ],
  extensions: [CompanyPurchase],
});
