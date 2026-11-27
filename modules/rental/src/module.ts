/**
 * The data layer of Rental (RFC 0038, step 6): products **for rent** — by the hour or the day, so many of them,
 * at a price, with a deposit and a late fee — and **rental orders**: a customer, a period, the products and how
 * many; reserved, picked up, returned.
 *
 * The server decides what is free: reserving is refused when, at any moment of the period, more would be out
 * than there are — an item that is late stays out until it is back. A late return adds its fee by itself. What
 * other apps do with an order (the invoice) hangs on its hooks: `reserved`, `pickedUp`, `returned`, `cancelled`.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { productShutro } from '@kosh/product';
import { emitting } from '@kosh/server';
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
  records,
} from './.kosh/bindings.js';
import { type Booking, lateUnits, peakBooked, type RentUnit, unitsOf } from './period.js';

const ALL = ['read', 'write', 'create', 'unlink'] as const;
/** Fields the server maintains: written by its own code and by Administrators only. */
const SYSTEM = ['base.admin'] as const;
const zero: Decimal = orm.toDecimal(0);
const UNITS = { hour: 'Hour', day: 'Day' } as const;
const ms = (v: unknown): number => new Date(v as string | Date).getTime();

export const ProductRental = extendModel('product.product', {
  fields: {
    rentable: f.boolean({
      default: false,
      label: 'For rent',
      help: 'Rental orders offer this product.',
    }),
    rentUnit: f.selection(UNITS, {
      required: true,
      default: 'day',
      label: 'Rented by',
      help: 'What the rent is counted in: every hour or every day begun.',
    }),
    rentPrice: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Rent per unit',
      help: 'What one of them costs for an hour or a day.',
    }),
    rentDeposit: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Deposit',
      help: 'Held for each one while it is out, and given back when it returns.',
    }),
    rentLateFee: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Late fee per unit',
      help: 'Added for every hour or day begun after the return was due, for each one.',
    }),
    rentQuantity: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Number for rent',
      help: 'How many of them there are to rent out: no more are ever reserved for the same moment.',
    }),
  },
});

export const RentalLine = defineModel('rental.line', {
  label: 'Rental line',
  order: ['id asc'],
  access: {
    'rental.user': [...ALL],
    'rental.manager': [...ALL, 'export'],
  },
  fields: {
    order: f.many2one('rental.order', { required: true, ondelete: 'cascade', index: true }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict', index: true }),
    quantity: f.decimal({ scale: 2, required: true, default: '1', label: 'Quantity' }),
    /** Frozen when the order is reserved: the product's own may change afterwards. */
    unit: f.selection(UNITS, {
      label: 'By',
      help: 'The hour or the day, from the product when the order is reserved.',
    }),
    priceUnit: f.decimal({
      scale: 2,
      label: 'Rent per unit',
      help: 'Empty: the product’s, taken when the order is reserved.',
    }),
    deposit: f.decimal({
      scale: 2,
      label: 'Deposit each',
      help: 'Empty: the product’s, taken when the order is reserved.',
    }),
    lateFee: f.decimal({
      scale: 2,
      label: 'Late fee per unit',
      help: 'Empty: the product’s, taken when the order is reserved.',
    }),
    units: f.integer({
      store: true,
      label: 'Units',
      help: 'The hours or days the period comes to: every one begun counts.',
      ...compute(
        'rental.line',
        'units',
        ['unit', 'product.rentUnit', 'order.start', 'order.stop'],
        (lines) => {
          for (const l of lines) {
            const unit = (l.unit ?? l.product.rentUnit) as RentUnit;
            l.units =
              l.order.start === null || l.order.stop === null
                ? 0
                : unitsOf(ms(l.order.start), ms(l.order.stop), unit);
          }
        },
      ),
    }),
    subtotal: f.decimal({
      scale: 2,
      store: true,
      label: 'Rent',
      help: 'The units, times the quantity, at the rent per unit.',
      ...compute(
        'rental.line',
        'subtotal',
        ['units', 'quantity', 'priceUnit', 'product.rentPrice'],
        (lines) => {
          for (const l of lines)
            l.subtotal = (l.priceUnit ?? l.product.rentPrice ?? zero)
              .times(l.quantity ?? zero)
              .times(l.units ?? 0)
              .toDecimalPlaces(2);
        },
      ),
    }),
    depositTotal: f.decimal({
      scale: 2,
      store: true,
      label: 'Deposit',
      help: 'The deposit for each, times the quantity.',
      ...compute(
        'rental.line',
        'depositTotal',
        ['quantity', 'deposit', 'product.rentDeposit'],
        (lines) => {
          for (const l of lines)
            l.depositTotal = (l.deposit ?? l.product.rentDeposit ?? zero)
              .times(l.quantity ?? zero)
              .toDecimalPlaces(2);
        },
      ),
    }),
  },
  sqlConstraints: {
    positive: {
      check: orm.sql`quantity > 0 AND (price_unit IS NULL OR price_unit >= 0)
        AND (deposit IS NULL OR deposit >= 0) AND (late_fee IS NULL OR late_fee >= 0)`,
      message: 'A line has a quantity above zero, and amounts that are not negative.',
    },
  },
  constraints: {
    // What is reserved is what was checked against what is free.
    asReserved: {
      ...check('rental.line', ['product', 'quantity'], async (lines) =>
        [...(await lines.load({ order: true }))]
          .filter((l) => l.order.state !== 'draft')
          .map((l) => l.id),
      ),
      message: 'A reserved order keeps its products: cancel it and make another.',
    },
    forRent: {
      ...check('rental.line', ['product'], async (lines) =>
        [...(await lines.load({ product: true }))]
          .filter((l) => l.product.rentable !== true)
          .map((l) => l.id),
      ),
      message: 'This product is not for rent (Products › For rent).',
    },
  },
});

/** States in which an order holds its products. */
export const HOLDING = ['reserved', 'out'] as const;

/**
 * What is free of a product over a period in a company: its number for rent, less the most that is reserved or
 * out at once then — an order that is late holds its products until now —, leaving `except` out.
 */
export async function freeOf(
  su: Env,
  company: number,
  product: number,
  start: number,
  end: number,
  except: number | null = null,
): Promise<{ total: number; free: number }> {
  const [p] = await su
    .model('product.product')
    .browse([product] as never)
    .load(['rentQuantity']);
  const total = Number((p?.rentQuantity ?? zero).toString());
  const rows = await su.sql<{ start: Date; finish: Date; state: string; quantity: string }>`
    SELECT o.start, o.stop AS finish, o.state, sum(l.quantity)::text AS quantity
      FROM rental_line l JOIN rental_order o ON o.id = l.order_id
     WHERE o.company_id = ${company} AND l.product_id = ${product}
       AND o.state IN ('reserved', 'out') AND o.id <> ${except ?? 0}
     GROUP BY o.id, o.start, o.stop, o.state`;
  const now = Date.now();
  const bookings: Booking[] = rows.map((r) => ({
    start: ms(r.start),
    // Out and past its time: nobody knows when it comes back, so it is not free until it has.
    end: r.state === 'out' && ms(r.finish) < now ? Number.POSITIVE_INFINITY : ms(r.finish),
    quantity: Number(r.quantity),
  }));
  return { total, free: total - peakBooked(bookings, start, end) };
}

/** Freezes each line's terms from its product, and refuses when a product is not free for the whole period. */
async function reserve(env: Env, ids: readonly number[]): Promise<void> {
  await env.flush();
  await env.asSuperuser({ reason: 'rental reserved' }, async (su) => {
    for (const o of await su
      .model('rental.order')
      .browse([...ids] as never)
      .load({ lines: { product: true }, company: true })) {
      const wanted = new Map<number, { name: string; quantity: number }>();
      for (const l of o.lines) {
        const key = l.product.id as number;
        const before = wanted.get(key)?.quantity ?? 0;
        wanted.set(key, {
          name: l.product.name,
          quantity: before + Number(l.quantity.toString()),
        });
        await su
          .model('rental.line')
          .browse([l.id] as never)
          .write({
            unit: l.unit ?? l.product.rentUnit,
            priceUnit: (l.priceUnit ?? l.product.rentPrice).toString(),
            deposit: (l.deposit ?? l.product.rentDeposit).toString(),
            lateFee: (l.lateFee ?? l.product.rentLateFee).toString(),
          } as never);
      }
      const short: string[] = [];
      for (const [product, want] of wanted) {
        const { free } = await freeOf(
          su,
          o.company.id as number,
          product,
          ms(o.start),
          ms(o.stop),
          o.id as number,
        );
        if (want.quantity > free)
          short.push(`${want.name} (${Math.max(0, free)} free, ${want.quantity} asked)`);
      }
      if (short.length > 0)
        throw new orm.ValidationError(
          'rental.order',
          ['lines'],
          `Not free for the whole period: ${short.join(', ')}.`,
          'Choose another period, fewer of them, or another product.',
        );
    }
    await su.flush();
  });
}

const sum = (lines: Iterable<Record<string, unknown>>, key: string): Decimal =>
  [...lines].reduce((s, l) => s.plus((l[key] as Decimal | null) ?? zero), zero);

export const RentalOrder = defineModel('rental.order', {
  label: 'Rental order',
  recName: 'name',
  order: ['start desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'start', 'stop'],
  access: {
    'rental.user': ['read', 'write', 'create'],
    'rental.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    name: f.char({ required: true, sequence: 'rental.order', label: 'Reference' }),
    partner: f.many2one('res.partner', {
      required: true,
      ondelete: 'restrict',
      index: true,
      label: 'Customer',
    }),
    start: f.datetime({ required: true, label: 'From' }),
    stop: f.datetime({ required: true, label: 'Until' }),
    lines: f.one2many('rental.line', 'order', { label: 'Products' }),
    note: f.text(),
    pickedAt: f.datetime({ label: 'Picked up at', groups: { write: [...SYSTEM] } }),
    returnedAt: f.datetime({ label: 'Returned at', groups: { write: [...SYSTEM] } }),
    rentTotal: f.decimal({
      scale: 2,
      store: true,
      label: 'Rent',
      help: 'The lines’ rent for the period.',
      ...compute('rental.order', 'rentTotal', ['lines.subtotal'], (orders) => {
        for (const o of orders) o.rentTotal = sum(o.lines as never, 'subtotal');
      }),
    }),
    depositTotal: f.decimal({
      scale: 2,
      store: true,
      label: 'Deposit',
      help: 'Held while the products are out; given back when they return.',
      ...compute('rental.order', 'depositTotal', ['lines.depositTotal'], (orders) => {
        for (const o of orders) o.depositTotal = sum(o.lines as never, 'depositTotal');
      }),
    }),
    lateFee: f.decimal({
      scale: 2,
      default: '0',
      label: 'Late fee',
      groups: { write: [...SYSTEM] },
      help: 'Worked out when the products come back after their time.',
    }),
    amountDue: f.decimal({
      scale: 2,
      store: true,
      label: 'To charge',
      help: 'The rent and the late fee, before taxes. The deposit is not a charge.',
      ...compute('rental.order', 'amountDue', ['lines.subtotal', 'lateFee'], (orders) => {
        for (const o of orders)
          o.amountDue = sum(o.lines as never, 'subtotal').plus(o.lateFee ?? zero);
      }),
    }),
    state: f.state({
      states: {
        draft: 'Quotation',
        reserved: 'Reserved',
        out: 'Picked up',
        returned: 'Returned',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      help: 'Reserved: the products are held for the period. Picked up: they are with the customer. Returned: they are back, and a late return has its fee.',
      transitions: {
        confirm: emitting('rental.order.reserved', {
          from: ['draft'],
          to: 'reserved',
          guard: records('rental.order', async (orders) =>
            [...(await orders.load({ lines: true }))]
              .filter((o) => [...o.lines].length === 0)
              .map((o) => o.id),
          ),
          message: 'Add what is rented first.',
          before: records('rental.order', async (orders): Promise<void> => {
            await reserve(orders.env as unknown as Env, orders.ids.map(Number));
          }),
          after: records('rental.order', async (orders): Promise<void> => {
            await (orders.env as unknown as Env)
              .model('rental.order')
              .browse(orders.ids)
              .reserved();
          }),
        }),
        pickup: emitting('rental.order.picked_up', {
          from: ['reserved'],
          to: 'out',
          after: records('rental.order', async (orders): Promise<void> => {
            const env = orders.env as unknown as Env;
            await env.asSuperuser({ reason: 'rental picked up' }, async (su) => {
              await su
                .model('rental.order')
                .browse(orders.ids)
                .write({ pickedAt: new Date() } as never);
              await su.flush();
            });
            await env.model('rental.order').browse(orders.ids).pickedUp();
          }),
        }),
        // Back: the day and the hour are the server's, and so is the fee of a late return.
        receive: emitting('rental.order.returned', {
          from: ['out'],
          to: 'returned',
          after: records('rental.order', async (orders): Promise<void> => {
            const env = orders.env as unknown as Env;
            await env.asSuperuser({ reason: 'rental returned' }, async (su) => {
              const now = Date.now();
              for (const o of await su
                .model('rental.order')
                .browse(orders.ids)
                .load({ lines: { product: true } })) {
                let fee = zero;
                for (const l of o.lines) {
                  const late = lateUnits(
                    ms(o.stop),
                    now,
                    (l.unit ?? l.product.rentUnit) as RentUnit,
                  );
                  fee = fee.plus(
                    (l.lateFee ?? l.product.rentLateFee ?? zero).times(l.quantity).times(late),
                  );
                }
                await su
                  .model('rental.order')
                  .browse([o.id])
                  .write({
                    returnedAt: new Date(now),
                    lateFee: fee.toDecimalPlaces(2).toString(),
                  } as never);
              }
              await su.flush();
            });
            await env.model('rental.order').browse(orders.ids).returned();
          }),
        }),
        cancel: {
          from: ['draft', 'reserved'],
          to: 'cancel',
          after: records('rental.order', async (orders): Promise<void> => {
            await (orders.env as unknown as Env)
              .model('rental.order')
              .browse(orders.ids)
              .cancelled();
          }),
        },
      },
    }),
  },
  methods: {
    /** Runs once these orders are reserved. Nothing here. */
    reserved: method('rental.order', async (): Promise<void> => undefined),
    /** Runs once these orders' products are picked up. Nothing here. */
    pickedUp: method('rental.order', async (): Promise<void> => undefined),
    /** Runs once these orders' products are back. Nothing here; `rental_account` drafts the invoice. */
    returned: method('rental.order', async (): Promise<void> => undefined),
    /** Runs once these orders are cancelled. Nothing here. */
    cancelled: method('rental.order', async (): Promise<void> => undefined),
  },
  sqlConstraints: {
    ordered: { check: orm.sql`stop > start`, message: 'A rental ends after it starts.' },
  },
  constraints: {
    // What was reserved is what is held: the period and the products change before, not after.
    heldAsReserved: {
      ...check('rental.order', ['start', 'stop', 'partner'], async (orders) =>
        [...(await orders.load(['state']))].filter((o) => o.state !== 'draft').map((o) => o.id),
      ),
      message:
        'A reserved order keeps its period and its customer: cancel it and make another, or return it.',
    },
  },
});

export const rentalShutro = defineModule({
  name: 'rental',
  version: '0.1.0',
  depends: [contactsShutro, productShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: 'rental.user',
      label: 'Rental: orders',
      implies: ['contacts.user', 'product.user'],
    }),
    orm.defineGroup({ code: 'rental.manager', label: 'Rental manager', implies: ['rental.user'] }),
  ],
  sequences: [
    orm.defineSequence({ code: 'rental.order', prefix: 'RN/{year}/', padding: 5, reset: 'yearly' }),
  ],
  models: [RentalOrder, RentalLine],
  extensions: [ProductRental],
});
