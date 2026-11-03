/**
 * The data layer of the Shop (RFC 0024 §2.7, in Sites): products published on a site's shop with a description in
 * English and Bangla, a weight and related products; delivery methods with their fee — fixed, by weight or by zone
 * (inside a set of cities, Dhaka, or outside) — free above an amount, cash on delivery or not; carts, which are
 * quotations of the site's company with a secret token and the method chosen; and online payments of a shop's order,
 * which confirm it, invoice it and register the payment once the provider confirms.
 */
import { createHash, randomBytes } from 'node:crypto';
import { paymentShutro } from '@kosh/payment';
import { productShutro } from '@kosh/product';
import { saleAccountShutro } from '@kosh/sale_account';
import { salesShutro } from '@kosh/sales';
import { type Decimal, orm } from '@kosh/server/orm';
import { websiteShutro } from '@kosh/website';
import {
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  type Records,
} from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;
const zero = orm.toDecimal(0);

/** A cart's secret: given to the visitor once; only its hash is kept. */
export const newCartToken = (): string => randomBytes(24).toString('base64url');
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** The couriers whose adapters book shipments (RFC 0024 §2.7; the adapters come with part 2). */
export const COURIERS = {
  none: 'None (delivered by hand)',
  fake: 'Test courier',
  pathao: 'Pathao',
  steadfast: 'Steadfast',
  redx: 'RedX',
} as const;

export const ProductShop = extendModel('product.product', {
  fields: {
    /** Shown on the sites' shops. */
    published: f.boolean({ default: false, label: 'On the shop' }),
    /** What the shop says about it (English and Bangla). */
    websiteDescription: f.text({ translate: true, label: 'Shop description' }),
    /** For fees by weight, in kg. */
    weight: f.decimal({ scale: 3, label: 'Weight (kg)' }),
    /** Shown with it on its page. */
    related: f.many2many('product.product', {
      relation: 'product_shop_related_rel',
      label: 'Related products',
    }),
    /** The order on the shop (lowest first). */
    shopSequence: f.integer({ required: true, default: 10, label: 'Shop order' }),
  },
});

export const SiteShop = extendModel('website.site', {
  fields: {
    /** The site sells: its shop's API answers. */
    shop: f.boolean({ default: false, label: 'Shop' }),
    /** Cash-on-delivery orders above this stay quotations until someone confirms them (empty: no limit). */
    codLimit: f.decimal({ scale: 2, label: 'Cash on delivery up to' }),
    /** Who shop orders are assigned to (the site's creator when empty). */
    salesperson: f.many2one('res.users', { ondelete: 'set null', label: 'Shop orders for' }),
    /** Who carts belong to before checkout (made with the first cart). */
    visitor: f.many2one('res.partner', { ondelete: 'set null', label: 'Shop visitor' }),
  },
});

export const DeliveryCarrier = defineModel('delivery.carrier', {
  label: 'Delivery method',
  recName: 'name',
  order: ['sequence asc', 'id asc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['kind', 'price', 'freeOver'],
  access: { 'sales.user': ['read'], 'sales.manager': ALL, 'website.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    kind: f.selection(
      { fixed: 'Fixed fee', weight: 'By weight', zone: 'By zone' },
      { required: true, default: 'fixed', label: 'Fee by' },
    ),
    /** The fixed fee; by weight, the fee of the first kg. */
    price: f.decimal({ scale: 2, required: true, default: '0', label: 'Fee' }),
    /** By weight: each kg (or part of one) beyond the first. */
    pricePerKg: f.decimal({ scale: 2, required: true, default: '0', label: 'Each further kg' }),
    /** By zone: the cities inside, comma separated (`Dhaka`). */
    zoneCities: f.char({ default: 'Dhaka', label: 'Inside: cities' }),
    priceInside: f.decimal({ scale: 2, required: true, default: '0', label: 'Fee inside' }),
    priceOutside: f.decimal({ scale: 2, required: true, default: '0', label: 'Fee outside' }),
    /** Free when the goods come to this much or more (empty: never). */
    freeOver: f.decimal({ scale: 2, label: 'Free from' }),
    /** Customers may pay the courier on delivery. */
    cod: f.boolean({ default: true, label: 'Cash on delivery' }),
    courier: f.selection(COURIERS, { required: true, default: 'none', label: 'Courier' }),
    /** The service product the fee is charged as on orders (made with the method). */
    product: f.many2one('product.product', { ondelete: 'restrict', label: 'Fee product' }),
    sequence: f.integer({ required: true, default: 10 }),
    description: f.text({ translate: true }),
  },
  sqlConstraints: {
    fees: {
      check: orm.sql`price >= 0 AND price_per_kg >= 0 AND price_inside >= 0 AND price_outside >= 0 AND (free_over IS NULL OR free_over >= 0)`,
      message: 'Fees are zero or more.',
    },
  },
});

/** The fee of `carrier` for goods worth `amount` weighing `weight` kg, delivered to `city`. */
export function feeOf(
  carrier: {
    readonly kind: string;
    readonly price: Decimal;
    readonly pricePerKg: Decimal;
    readonly zoneCities: string | null;
    readonly priceInside: Decimal;
    readonly priceOutside: Decimal;
    readonly freeOver: Decimal | null;
  },
  amount: Decimal,
  weight: Decimal,
  city: string | null,
): Decimal {
  if (carrier.freeOver !== null && amount.gte(carrier.freeOver)) return zero;
  if (carrier.kind === 'weight') {
    const beyond = weight.minus(1);
    return carrier.price.plus(beyond.gt(0) ? beyond.ceil().times(carrier.pricePerKg) : zero);
  }
  if (carrier.kind === 'zone') {
    const inside = (carrier.zoneCities ?? '')
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter((c) => c !== '');
    const here = (city ?? '').trim().toLowerCase();
    return here !== '' && inside.includes(here) ? carrier.priceInside : carrier.priceOutside;
  }
  return carrier.price;
}

export const OrderShop = extendModel('sale.order', {
  fields: {
    /** The site the order was placed on. */
    website: f.many2one('website.site', { ondelete: 'set null', label: 'Site' }),
    /** The hash of the cart's secret token (the visitor holds the token). */
    cartToken: f.char({ index: true, label: 'Cart token' }),
    carrier: f.many2one('delivery.carrier', { ondelete: 'set null', label: 'Delivery method' }),
    shopPayment: f.selection(
      { cod: 'Cash on delivery', online: 'Paid online' },
      { label: 'Payment' },
    ),
    /** Placed by the customer (checked out); a cart before that. */
    placedAt: f.datetime({ label: 'Placed at' }),
    shopNote: f.text({ label: 'Customer note' }),
  },
});

export const LineShop = extendModel('sale.order.line', {
  fields: {
    /** The delivery fee's line (replaced when the method or the cart changes). */
    isDelivery: f.boolean({ default: false, label: 'Delivery fee' }),
  },
});

export const TransactionOrder = extendModel('payment.transaction', {
  fields: {
    saleOrder: f.many2one('sale.order', { ondelete: 'set null', label: 'Sales order' }),
  },
  overrides: {
    // A shop's order is confirmed, invoiced and its invoice posted when its payment is confirmed; the payment pays it.
    payable: async function (
      this: unknown,
      next: () => Promise<Map<number, number[]>>,
    ): Promise<Map<number, number[]>> {
      const out = await next();
      const txs = this as Records<'payment.transaction'>;
      const env = txs.env as unknown as Env;
      for (const t of await txs.load({ saleOrder: true })) {
        if ((out.get(t.id) ?? []).length > 0 || t.saleOrder === null) continue;
        const order = env.model('sale.order').browse([t.saleOrder.id]);
        const [o] = await order.load({ invoices: true });
        if (o === undefined) continue;
        if (o.state === 'draft' || o.state === 'sent') await order.confirm();
        let invoice = [...o.invoices].find((i) => i.state !== 'cancel')?.id;
        if (invoice === undefined) {
          await order.invoice();
          const [again] = await order.load({ invoices: true });
          invoice = [...(again?.invoices ?? [])].find((i) => i.state !== 'cancel')?.id;
        }
        if (invoice === undefined) continue;
        const move = env.model('account.move').browse([invoice]);
        const [m] = await move.load({});
        if (m?.state === 'draft') await move.post();
        await txs.env.model('payment.transaction').browse([t.id]).write({ move: invoice });
        out.set(t.id, [invoice]);
      }
      return out;
    },
  },
});

export const websiteSaleShutro = defineModule({
  name: 'website_sale',
  version: '0.1.0',
  depends: [websiteShutro, salesShutro, saleAccountShutro, paymentShutro, productShutro],
  groups: [
    orm.defineGroup({
      code: 'website_sale.manager',
      label: 'Shop manager',
      implies: ['website.manager', 'sales.manager'],
    }),
  ],
  models: [DeliveryCarrier],
  extensions: [ProductShop, SiteShop, OrderShop, LineShop, TransactionOrder],
});
