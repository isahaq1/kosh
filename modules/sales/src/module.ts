/**
 * The data layer of Sales (Shutro): quotations and sales orders. Numbered when created (SO/2026/00001), amounts
 * computed from the lines in the order's currency (Money, never `number`), a guarded workflow, and record rules:
 * salespeople see their own orders, managers see every order of their companies.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { computeTaxes, priceFor, productShutro, taxRule } from '@kosh/product';
import { type Decimal, orm } from '@kosh/server/orm';
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

/** A line's taxes through the engine (RFC 0016): its amount after discount, its taxes in order. */
function taxesOf(l: {
  readonly quantity: ReturnType<typeof orm.toDecimal>;
  /** Null while the price list has not priced it yet. */
  readonly priceUnit: ReturnType<typeof orm.toDecimal> | null;
  readonly discount: ReturnType<typeof orm.toDecimal>;
  readonly taxes: Iterable<Parameters<typeof taxRule>[0]>;
}) {
  const amount = l.quantity
    .times(l.priceUnit ?? orm.toDecimal('0'))
    .times(orm.toDecimal(100).minus(l.discount))
    .div(100);
  return computeTaxes(amount, l.quantity, [...l.taxes].map(taxRule));
}

/** A monetary value's amount (a Money object or a plain Decimal), or null. */
function amountOf(value: unknown): Decimal | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && 'amount' in value) return (value as { amount: Decimal }).amount;
  return value as Decimal;
}

const amounts = compute(
  'sale.order',
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

export const SaleOrder = defineModel('sale.order', {
  label: 'Sales order',
  companyScoped: { required: true },
  order: ['dateOrder desc', 'id desc'],
  tracking: ['partner', 'amountTotal', 'state'],
  access: {
    'sales.user': ['read', 'write', 'create'],
    'sales.manager': ['read', 'write', 'create', 'unlink', 'export', 'import'],
  },
  rules: {
    own: { groups: ['sales.user'], perms: ['read', 'write'], domain: { user: { $env: 'uid' } } },
    all: { groups: ['sales.manager'], perms: ['read', 'write', 'create', 'unlink'], domain: {} },
  },
  fields: {
    name: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'sale.order', dateField: 'dateOrder' },
      label: 'Number',
    }),
    user: f.many2one('res.users', {
      required: true,
      default: (env: Env) => env.userId,
      label: 'Salesperson',
    }),
    partner: f.many2one('res.partner', { required: true, checkCompany: true, label: 'Customer' }),
    /** Where the invoice goes and where the goods go (RFC 0028 §3.2); empty: the customer's own address. */
    partnerInvoice: f.many2one('res.partner', {
      checkCompany: true,
      label: 'Invoice to',
      help: 'The contact the invoice is addressed to; empty: the customer.',
    }),
    partnerShipping: f.many2one('res.partner', {
      checkCompany: true,
      label: 'Deliver to',
      help: 'Where the goods go; empty: the customer’s address.',
    }),
    /** The price list its lines are priced by (RFC 0028 §3.1); from the customer, else none (list prices). */
    pricelist: f.many2one('product.pricelist', {
      ondelete: 'restrict',
      label: 'Price list',
      help: 'Lines without a price typed in are priced by this list; each line says why.',
    }),
    currency: f.many2one('res.currency', { required: true }),
    dateOrder: f.date({ required: true, default: (env: Env) => env.today(), label: 'Order date' }),
    validityDate: f.date({ label: 'Valid until' }),
    clientReference: f.char({ label: 'Customer reference' }),
    note: f.text({ label: 'Terms and conditions' }),
    lines: f.one2many('sale.order.line', 'order'),
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
      help: 'What the customer pays: the untaxed amount plus the taxes.',
      ...amounts,
    }),
    /** RFC 0022 step 2: what the order earns — the lines' untaxed amounts less their products' cost. */
    margin: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Margin',
      help: 'What the order earns: its lines’ untaxed amounts less their products’ cost.',
      ...compute('sale.order', 'margin', ['lines.margin', 'currency'], (orders) => {
        for (const o of orders)
          o.margin = o.currency === null ? null : o.lines.sum('margin', o.currency);
      }),
    }),
    marginPercent: f.decimal({
      scale: 1,
      store: true,
      label: 'Margin (%)',
      help: 'The margin as a percentage of the untaxed amount.',
      ...compute('sale.order', 'marginPercent', ['margin', 'amountUntaxed'], (orders) => {
        for (const o of orders) {
          const untaxed = amountOf(o.amountUntaxed);
          const margin = amountOf(o.margin);
          o.marginPercent =
            untaxed === null || margin === null || untaxed.isZero()
              ? null
              : margin.times(100).div(untaxed).toDecimalPlaces(1);
        }
      }),
    }),
    state: f.state({
      help: 'A quotation until it is confirmed as a sales order, which can then be locked or cancelled.',
      states: {
        draft: 'Quotation',
        sent: 'Quotation sent',
        sale: 'Sales order',
        done: 'Locked',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      transitions: {
        send: { from: ['draft'], to: 'sent' },
        confirm: {
          from: ['draft', 'sent'],
          to: 'sale',
          guard: records('sale.order', async (orders) => {
            const loaded = await orders.load({ lines: true });
            return loaded.filter((o) => o.lines.length === 0);
          }),
          message: 'Add at least one line before confirming the order.',
          // Other apps check the order first (sale_account: the customer's credit).
          before: records('sale.order', async (orders) => {
            const env = orders.env as unknown as Env;
            await env.model('sale.order').browse(orders.ids).confirming();
          }),
          // Other apps act on a confirmation through the outbox (sale_project creates the tasks).
          after: records('sale.order', async (orders) => {
            for (const o of await orders.load({}))
              await orders.env.emit('sale.order.confirmed', { id: o.id });
          }),
        },
        lock: { from: ['sale'], to: 'done' },
        unlock: { from: ['done'], to: 'sale' },
        cancel: { from: ['draft', 'sent', 'sale'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
      extensible: true, // Accounting adds invoicing states through its bridge
    }),
  },
  methods: {
    /** Before a confirmation: nothing here; sale_account checks the customer's credit (RFC 0028 §3.2). */
    confirming: method('sale.order', async () => undefined),
  },
  onchange: {
    // The customer's currency, else the company's; an empty validity and terms from the company's settings.
    partner: onchange('sale.order', async (d, env) => {
      await quotationDefaults(d, env);
      const p = await d.record('partner');
      const [priced] =
        p === null
          ? []
          : await env
              .model('res.partner')
              .browse([p.id])
              .load({ pricelist: { currency: true } });
      d.set('pricelist', priced?.pricelist?.id ?? null);
      if (priced?.pricelist?.currency) {
        d.set('currency', priced.pricelist.currency.id);
        return;
      }
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
    // A price list in another currency puts the order in it.
    pricelist: onchange('sale.order', async (d) => {
      const list = await d.record('pricelist');
      if (list?.currency) d.set('currency', list.currency.id);
    }),
    // A new order date moves the validity with it.
    dateOrder: onchange('sale.order', async (d, env) => {
      d.set('validityDate', null);
      await quotationDefaults(d, env);
    }),
  },
});

/** The company's quotation settings (RFC 0020): how long quotations stay valid, and their default terms. */
export const CompanySales = extendModel('res.company', {
  fields: {
    saleValidityDays: f.integer({ default: 30, label: 'Quotations valid for (days, 0: no limit)' }),
    saleTerms: f.text({ label: 'Default terms and conditions' }),
  },
});

/** Fills an order's empty validity and terms from its company's settings. */
async function quotationDefaults(
  d: { get(key: string): unknown; set(key: string, value: unknown): void },
  env: Env,
): Promise<void> {
  const [company] = (
    await env.model('res.company').browse([env.companyId]).load(['saleValidityDays', 'saleTerms'])
  ).read(['saleValidityDays', 'saleTerms']);
  const days = Number(company?.['saleValidityDays'] ?? 0);
  const date = d.get('dateOrder');
  if ((d.get('validityDate') ?? null) === null && days > 0 && typeof date === 'string') {
    const [y, m, day] = date.split('-').map(Number) as [number, number, number];
    d.set('validityDate', new Date(Date.UTC(y, m - 1, day + days)).toISOString().slice(0, 10));
  }
  const terms = company?.['saleTerms'];
  if ((d.get('note') ?? '') === '' && typeof terms === 'string' && terms !== '')
    d.set('note', terms);
}

/** A line's price and why (RFC 0028 §3.1): typed in, else its order's price list, else the list price. */
async function linePrice(l: {
  readonly env: unknown;
  readonly manualPrice: Decimal | null;
  readonly product: { readonly id: unknown } | null;
  readonly quantity: Decimal;
  readonly order: {
    readonly pricelist: { readonly id: unknown } | null;
    readonly dateOrder: unknown;
  } | null;
}): Promise<{ price: Decimal; reason: string | null }> {
  if (l.manualPrice !== null) return { price: l.manualPrice, reason: 'Typed in.' };
  if (l.product === null) return { price: orm.toDecimal('0'), reason: null };
  const env = l.env as { today(): string };
  const found = await priceFor(
    l.env as never,
    (l.order?.pricelist?.id as number | undefined) ?? null,
    l.product.id as number,
    l.quantity,
    String(l.order?.dateOrder ?? env.today()).slice(0, 10),
  );
  return { price: found.price, reason: found.explanation };
}

export const SaleOrderLine = defineModel('sale.order.line', {
  label: 'Order line',
  access: {
    'sales.user': ['read', 'write', 'create', 'unlink'],
    'sales.manager': ['read', 'write', 'create', 'unlink'],
  },
  fields: {
    order: f.many2one('sale.order', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', { required: true }),
    name: f.char({ required: true, label: 'Description' }),
    quantity: f.decimal({ scale: 3, required: true, default: '1' }),
    uom: f.many2one('uom.uom', { label: 'Unit' }),
    /**
     * The unit price: the one typed in, else the order's price list's (RFC 0028 §3.1). Typing a price keeps it
     * (`manualPrice`); changing the product, the quantity or the list reprices the lines without one.
     */
    priceUnit: f.decimal({
      scale: 2,
      store: true,
      label: 'Unit price',
      help: 'The price typed in, else the order’s price list’s (see why on the line), else the product’s list price.',
      ...compute(
        'sale.order.line',
        'priceUnit',
        ['product', 'quantity', 'manualPrice', 'order.pricelist', 'order.dateOrder'],
        async (lines) => {
          for (const l of lines) l.priceUnit = (await linePrice(l)).price;
        },
      ),
      inverse: async (records: never) => {
        const lines = records as Iterable<{
          id: number;
          env: Env;
          priceUnit: Decimal | null;
        }> & { env: Env };
        const env = (records as { env: Env }).env;
        // Who may set prices by hand (RFC 0028 §3.1): the server decides.
        if (!env.su && !env.access.has('sales.price_override'))
          throw new orm.ValidationError(
            'sale.order.line',
            ['priceUnit'],
            'You may not change prices.',
            'Prices come from the price list; ask a Sales manager.',
          );
        for (const l of lines)
          await env
            .model('sale.order.line')
            .browse([l.id as never])
            .write({ manualPrice: l.priceUnit });
      },
    }),
    /** The price typed in, kept when the product, the quantity or the list changes (empty: the list's price). */
    manualPrice: f.decimal({ scale: 2, label: 'Price typed in' }),
    /** Why the line has its price: the list and rule, or "typed in". */
    priceReason: f.char({
      store: true,
      label: 'Why this price',
      ...compute(
        'sale.order.line',
        'priceReason',
        ['product', 'quantity', 'manualPrice', 'order.pricelist', 'order.dateOrder'],
        async (lines) => {
          for (const l of lines) l.priceReason = (await linePrice(l)).reason;
        },
      ),
    }),
    /** Percent off the unit price (0–100). */
    discount: f.decimal({ scale: 2, required: true, default: '0', label: 'Discount %' }),
    /** The line's taxes, applied in order (RFC 0016). */
    taxes: f.many2many('account.tax'),
    /** Before 0.2.0, one tax per line: copied into `taxes` by the migration; dropped later. */
    tax: f.many2one('account.tax', { label: 'Tax (before 0.2.0)', readonly: true }),
    /** The order's currency, so line amounts are Money in it. */
    currency: f.many2one('res.currency', {
      store: true,
      ...compute('sale.order.line', 'currency', ['order.currency'], (lines) => {
        for (const l of lines) l.currency = l.order.currency.id;
      }),
    }),
    subtotal: f.monetary({
      currency: 'currency',
      store: true,
      help: 'The line’s amount before taxes: the quantity times the unit price, less the discount and any tax included in the price.',
      ...compute(
        'sale.order.line',
        'subtotal',
        [
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
        ],
        (lines) => {
          for (const l of lines) l.subtotal = taxesOf(l).untaxed;
        },
      ),
    }),
    /** The line's untaxed amount less its product's cost at the time (RFC 0022 step 2). */
    margin: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Margin',
      help: 'What the line earns: its untaxed amount less its product’s cost for the quantity.',
      ...compute(
        'sale.order.line',
        'margin',
        ['subtotal', 'quantity', 'product.standardPrice'],
        (lines) => {
          for (const l of lines) {
            const untaxed = amountOf(l.subtotal);
            l.margin =
              untaxed === null || l.product === null
                ? null
                : untaxed.minus(l.quantity.times(l.product.standardPrice));
          }
        },
      ),
    }),
    taxAmount: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Tax',
      help: 'The taxes on this line, computed from its amount and its taxes.',
      ...compute(
        'sale.order.line',
        'taxAmount',
        [
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
        ],
        (lines) => {
          for (const l of lines) l.taxAmount = taxesOf(l).taxTotal;
        },
      ),
    }),
  },
  onchange: {
    product: onchange('sale.order.line', async (d, env) => {
      const p = await d.record('product');
      if (p === null) return;
      d.set('name', p.name);
      d.set('priceUnit', p.listPrice);
      d.set('uom', p.uom?.id ?? null);
      // The product's taxes, loaded (a draft's related record has its plain fields only).
      const [taxed] = await env.model('product.product').browse([p.id]).load({ taxes: true });
      d.set('taxes', { set: [...(taxed?.taxes.ids ?? [])] });
    }),
  },
  constraints: {
    positiveQuantity: {
      ...check('sale.order.line', ['quantity'], (lines) => lines.filter((l) => l.quantity.lte(0))),
      message: 'Line quantities must be positive.',
    },
    discountRange: {
      ...check('sale.order.line', ['discount'], (lines) =>
        lines.filter((l) => l.discount.lt(0) || l.discount.gt(100)),
      ),
      message: 'A discount is between 0 and 100 %.',
    },
  },
});

/** The customer's price list (RFC 0028 §3.1): their orders start on it. */
export const PartnerPricelist = extendModel('res.partner', {
  fields: {
    pricelist: f.many2one('product.pricelist', {
      ondelete: 'set null',
      label: 'Price list',
      help: 'Orders for this customer start on this price list.',
    }),
  },
});

export const salesShutro = defineModule({
  name: 'sales',
  version: '0.4.0',
  migrations: [
    {
      version: '0.4.0',
      description:
        'Price lists: existing lines keep the price they have, as typed in (no order is repriced)',
      up: async (ctx) => {
        await ctx.sql`UPDATE sale_order_line SET manual_price = price_unit WHERE manual_price IS NULL`;
        await ctx.sql`UPDATE sale_order_line SET price_reason = 'Typed in.' WHERE price_reason IS NULL`;
      },
    },
    {
      version: '0.2.0',
      description: 'Several taxes per line: the single tax of each line becomes its first',
      up: async (ctx) => {
        await ctx.sql`INSERT INTO sale_order_line_account_tax_rel (sale_order_line_id, account_tax_id)
          SELECT id, tax_id FROM sale_order_line WHERE tax_id IS NOT NULL ON CONFLICT DO NOTHING`;
      },
    },
  ],
  depends: [contactsShutro, productShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: 'sales.user',
      label: 'Salesperson',
      implies: ['contacts.user', 'product.user', 'messaging.user'],
    }),
    orm.defineGroup({ code: 'sales.manager', label: 'Sales manager', implies: ['sales.user'] }),
  ],
  permissions: [
    orm.definePermission({
      code: 'sales.price_override',
      label: 'Type in prices on order lines (instead of the price list)',
      groups: ['sales.user'],
    }),
  ],
  sequences: [
    orm.defineSequence({ code: 'sale.order', prefix: 'SO/{year}/', padding: 5, reset: 'yearly' }),
  ],
  models: [SaleOrder, SaleOrderLine],
  extensions: [CompanySales, PartnerPricelist],
});
