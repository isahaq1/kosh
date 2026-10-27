/**
 * The data layer of Sales (Shutro): quotations and sales orders. Numbered when created (SO/2026/00001), amounts
 * computed from the lines in the order's currency (Money, never `number`), a guarded workflow, and record rules:
 * salespeople see their own orders, managers see every order of their companies.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { computeTaxes, productShutro, taxRule } from '@kosh/product';
import { orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  onchange,
  records,
} from './.kosh/bindings.js';

/** A line's taxes through the engine (RFC 0016): its amount after discount, its taxes in order. */
function taxesOf(l: {
  readonly quantity: ReturnType<typeof orm.toDecimal>;
  readonly priceUnit: ReturnType<typeof orm.toDecimal>;
  readonly discount: ReturnType<typeof orm.toDecimal>;
  readonly taxes: Iterable<Parameters<typeof taxRule>[0]>;
}) {
  const amount = l.quantity.times(l.priceUnit).times(orm.toDecimal(100).minus(l.discount)).div(100);
  return computeTaxes(amount, l.quantity, [...l.taxes].map(taxRule));
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
    currency: f.many2one('res.currency', { required: true }),
    dateOrder: f.date({ required: true, default: (env: Env) => env.today(), label: 'Order date' }),
    validityDate: f.date({ label: 'Valid until' }),
    clientReference: f.char({ label: 'Customer reference' }),
    note: f.text({ label: 'Terms and conditions' }),
    lines: f.one2many('sale.order.line', 'order'),
    amountUntaxed: f.monetary({ currency: 'currency', store: true, label: 'Untaxed', ...amounts }),
    amountTax: f.monetary({ currency: 'currency', store: true, label: 'Taxes', ...amounts }),
    amountTotal: f.monetary({ currency: 'currency', store: true, label: 'Total', ...amounts }),
    state: f.state({
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
  onchange: {
    // The customer's currency, else the company's.
    partner: onchange('sale.order', async (d, env) => {
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
    priceUnit: f.decimal({ scale: 2, required: true, default: '0', label: 'Unit price' }),
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
    taxAmount: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Tax',
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

export const salesShutro = defineModule({
  name: 'sales',
  version: '0.2.0',
  migrations: [
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
  sequences: [
    orm.defineSequence({ code: 'sale.order', prefix: 'SO/{year}/', padding: 5, reset: 'yearly' }),
  ],
  models: [SaleOrder, SaleOrderLine],
});
