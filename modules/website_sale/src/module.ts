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
import { emitting } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import { websiteShutro } from '@kosh/website';
import {
  check,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  method,
  type Records,
  records,
} from './.kosh/bindings.js';
import { courierOf } from './couriers.js';

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
    /** Shown with it on its page. */
    related: f.many2many('product.product', {
      relation: 'product_shop_related_rel',
      label: 'Related products',
    }),
    /** The order on the shop (lowest first). */
    shopSequence: f.integer({ required: true, default: 10, label: 'Shop order' }),
    /** What search engines show (the name when empty), in English and Bangla. */
    seoTitle: f.char({ translate: true, label: 'Search title' }),
    seoDescription: f.text({ translate: true, label: 'Search description' }),
  },
  methods: {
    /**
     * What each of these products has available for the shop, in its unit (a decimal string), or null when stock is
     * not followed. Null here; `website_sale_stock` says what Stockroom has.
     */
    shopAvailable: method('product.product', async function (): Promise<
      Map<number, string | null>
    > {
      return new Map(this.ids.map((id) => [id, null]));
    }),
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
    /** With stock shown (`website_sale_stock`): at most this many is "few left". */
    fewLeft: f.integer({ required: true, default: 5, label: 'Few left from' }),
    /** With stock shown: whether more than is available may be ordered. */
    allowBackorders: f.boolean({ default: true, label: 'Sell beyond stock' }),
    /** Carts left this many hours with an email get one reminder (0: never). */
    abandonedHours: f.integer({
      required: true,
      default: 24,
      label: 'Remind abandoned carts after (h)',
    }),
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
      {
        required: true,
        default: 'fixed',
        label: 'Fee by',
        help: 'How the delivery fee is worked out: one fixed fee, by the parcel’s weight or by whether the city is inside the zone.',
      },
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
    courier: f.selection(COURIERS, {
      required: true,
      default: 'none',
      label: 'Courier',
      help: 'The courier service that books and delivers the parcels of this method.',
    }),
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

/**
 * A coupon of the shop (RFC 0024 §2.7): a code that takes a percentage off the goods, an amount off, or the delivery
 * fee — from a minimum, between two dates, up to a number of uses, once per customer if it says so.
 */
export const ShopCoupon = defineModel('shop.coupon', {
  label: 'Coupon',
  recName: 'code',
  order: ['code asc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['value', 'validTo', 'maxUses'],
  access: { 'sales.user': ['read'], 'sales.manager': ALL, 'website.manager': ALL },
  fields: {
    /** What the customer types (upper case). */
    code: f.char({ required: true, size: 40 }),
    name: f.char({ translate: true, label: 'What it gives' }),
    kind: f.selection(
      { percent: 'Percentage off the goods', amount: 'Amount off', free_delivery: 'Free delivery' },
      {
        required: true,
        default: 'percent',
        label: 'Gives',
        help: 'What the coupon gives: a percentage off the goods, an amount off or free delivery.',
      },
    ),
    value: f.decimal({ scale: 2, required: true, default: '0', label: 'Value' }),
    /** The goods must come to this much. */
    minimum: f.decimal({ scale: 2, required: true, default: '0', label: 'From' }),
    validFrom: f.date({ label: 'Valid from' }),
    validTo: f.date({ label: 'Valid until' }),
    /** Empty: as often as it is used. */
    maxUses: f.integer({ label: 'Uses at most' }),
    uses: f.integer({ required: true, default: 0, label: 'Used' }),
    oncePerCustomer: f.boolean({ default: false, label: 'Once per customer' }),
    /** The service product an amount off is charged as (made with its first use). */
    product: f.many2one('product.product', { ondelete: 'set null', label: 'Discount product' }),
  },
  sqlConstraints: {
    oneCode: { unique: ['company', 'code'], message: 'Another coupon has this code.' },
    values: {
      check: orm.sql`value >= 0 AND minimum >= 0 AND (kind <> 'percent' OR value <= 100) AND (max_uses IS NULL OR max_uses > 0)`,
      message: 'A coupon gives zero or more (a percentage up to 100), from zero or more.',
    },
    period: {
      check: orm.sql`valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from`,
      message: 'A coupon ends on or after it starts.',
    },
  },
  constraints: {
    upperCase: {
      ...check('shop.coupon', ['code'], async (coupons) =>
        coupons.filter((c) => !/^[A-Z0-9_-]{2,40}$/.test(c.code)).map((c) => c.id),
      ),
      message: 'A code is 2 to 40 capital letters, digits, dashes or underscores (EID10).',
    },
  },
});

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
    coupon: f.many2one('shop.coupon', { ondelete: 'set null', label: 'Coupon' }),
    /** The email a visitor left on their cart (reminded once if they leave it). */
    contactEmail: f.char({ label: 'Cart email' }),
    /** The hash of the cart's recovery code, sent with the reminder. */
    recoveryToken: f.char({ index: true, label: 'Recovery code' }),
    remindedAt: f.datetime({ label: 'Reminded at' }),
  },
});

export const LineShop = extendModel('sale.order.line', {
  fields: {
    /** The delivery fee's line (replaced when the method or the cart changes). */
    isDelivery: f.boolean({ default: false, label: 'Delivery fee' }),
    /** A coupon's amount off (replaced when the cart or the coupon changes). */
    isDiscount: f.boolean({ default: false, label: 'Coupon discount' }),
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

/**
 * A shipment (RFC 0024 §2.7): a shop order's parcel with its courier — made as a draft when an order whose delivery
 * method has a courier is confirmed, booked by the team (the courier's consignment id and label), then moved along by
 * what the courier says (picked, in transit, delivered or returned) with its events; delivered with the cash to
 * collect, the cash is collected.
 */
export const DeliveryShipment = defineModel('delivery.shipment', {
  label: 'Shipment',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'trackingRef'],
  access: { 'sales.user': ['read', 'write', 'create'], 'sales.manager': ALL },
  fields: {
    name: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'delivery.shipment' },
      label: 'Reference',
    }),
    order: f.many2one('sale.order', { required: true, ondelete: 'restrict', label: 'Order' }),
    carrier: f.many2one('delivery.carrier', { required: true, ondelete: 'restrict' }),
    courier: f.selection(COURIERS, {
      required: true,
      default: 'fake',
      help: 'The courier service the parcel is booked with.',
    }),
    recipient: f.char({ required: true }),
    phone: f.char({ required: true }),
    address: f.char({ required: true }),
    city: f.char({ required: true }),
    /** The cash the courier collects (0: paid online). */
    cod: f.decimal({ scale: 2, required: true, default: '0', label: 'Cash to collect' }),
    weight: f.decimal({ scale: 3, required: true, default: '0', label: 'Weight (kg)' }),
    trackingRef: f.char({ index: true, label: 'Consignment' }),
    labelUrl: f.char({ label: 'Label' }),
    codCollected: f.boolean({ default: false, label: 'Cash collected' }),
    codCollectedAt: f.datetime({ label: 'Collected at' }),
    events: f.one2many('delivery.shipment.event', 'shipment', { label: 'Tracking' }),
    note: f.text(),
    state: f.state({
      help: 'Follows the parcel from booking with the courier through pick-up and transit to delivery or return.',
      states: {
        draft: 'To book',
        booked: 'Booked',
        picked: 'Picked up',
        in_transit: 'In transit',
        delivered: 'Delivered',
        returned: 'Returned',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      transitions: {
        /** Books the parcel with the courier: its consignment id and label. */
        book: {
          from: ['draft'],
          to: 'booked',
          before: records('delivery.shipment', async (shipments): Promise<void> => {
            for (const s of await shipments.load({})) {
              const courier = courierOf(s.courier);
              if (courier === null)
                throw new orm.ValidationError(
                  'delivery.shipment',
                  ['courier'],
                  `The ${COURIERS[s.courier as keyof typeof COURIERS] ?? s.courier} courier is not set up on this server.`,
                  'Its credentials go in the server’s environment; the test courier always works.',
                );
              let booked: Awaited<ReturnType<typeof courier.book>>;
              try {
                booked = await courier.book({
                  reference: s.name,
                  recipient: {
                    name: s.recipient,
                    phone: s.phone,
                    address: s.address,
                    city: s.city,
                  },
                  cod: s.cod.toFixed(2),
                  weightKg: s.weight.toFixed(3),
                  note: s.note ?? '',
                });
              } catch (error) {
                throw new orm.ValidationError(
                  'delivery.shipment',
                  ['courier'],
                  `The courier refused the booking: ${error instanceof Error ? error.message : String(error)}`,
                  'Check the address and phone number, then book again.',
                );
              }
              await s.write({ trackingRef: booked.trackingRef, labelUrl: booked.labelUrl ?? null });
              await shipments.env
                .model('delivery.shipment.event')
                .create([{ shipment: s.id, status: 'booked', note: 'Booked with the courier' }]);
            }
          }),
        },
        pick: { from: ['booked'], to: 'picked' },
        transit: { from: ['booked', 'picked'], to: 'in_transit' },
        deliver: emitting('delivery.shipment.delivered', {
          from: ['booked', 'picked', 'in_transit'],
          to: 'delivered',
          after: records('delivery.shipment', async (shipments): Promise<void> => {
            for (const s of await shipments.load({}))
              if (s.cod.gt(0) && !s.codCollected)
                await s.write({ codCollected: true, codCollectedAt: new Date() });
          }),
        }),
        bounce: emitting('delivery.shipment.returned', {
          from: ['booked', 'picked', 'in_transit'],
          to: 'returned',
        }),
        cancel: {
          from: ['draft', 'booked'],
          to: 'cancel',
          before: records('delivery.shipment', async (shipments): Promise<void> => {
            for (const s of await shipments.load({})) {
              if (s.trackingRef === null) continue;
              const courier = courierOf(s.courier);
              try {
                await courier?.cancel(s.trackingRef);
              } catch (error) {
                throw new orm.ValidationError(
                  'delivery.shipment',
                  ['state'],
                  `The courier did not cancel it: ${error instanceof Error ? error.message : String(error)}`,
                  'Ask the courier to return the parcel instead.',
                );
              }
            }
          }),
        },
      },
    }),
  },
  sqlConstraints: {
    amounts: { check: orm.sql`cod >= 0 AND weight >= 0`, message: 'Amounts are zero or more.' },
  },
});

export const DeliveryShipmentEvent = defineModel('delivery.shipment.event', {
  label: 'Tracking event',
  order: ['at asc', 'id asc'],
  access: { 'sales.user': ['read', 'create'], 'sales.manager': ['read', 'create', 'unlink'] },
  fields: {
    shipment: f.many2one('delivery.shipment', { required: true, ondelete: 'cascade' }),
    at: f.datetime({ required: true, default: () => new Date(), label: 'When' }),
    status: f.char({ required: true }),
    note: f.char(),
  },
});

export const websiteSaleShutro = defineModule({
  name: 'website_sale',
  version: '0.4.0',
  depends: [websiteShutro, salesShutro, saleAccountShutro, paymentShutro, productShutro],
  groups: [
    orm.defineGroup({
      code: 'website_sale.manager',
      label: 'Shop manager',
      implies: ['website.manager', 'sales.manager'],
    }),
  ],
  sequences: [
    orm.defineSequence({
      code: 'delivery.shipment',
      prefix: 'SHP/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
  ],
  models: [DeliveryCarrier, DeliveryShipment, DeliveryShipmentEvent, ShopCoupon],
  extensions: [ProductShop, SiteShop, OrderShop, LineShop, TransactionOrder],
});
