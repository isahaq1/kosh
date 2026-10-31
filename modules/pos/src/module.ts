/**
 * The data layer of Counter (RFC 0021): shops with their payment methods, the cashier's sessions with opening and
 * closing counts, and the orders sold at the counter — lines with taxes, several payments and the change given —
 * each accepted once by the device's client id (sales queued offline arrive later, in order). What a closed session
 * means to Stockroom and Accounting is the bridges' (`pos_stock`, `pos_account`).
 */
import { accountingShutro } from '@kosh/accounting';
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { productShutro } from '@kosh/product';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  method,
  records,
} from './.kosh/bindings.js';
import { bookSessions } from './accounting.js';

const ALL = ['read', 'write', 'create', 'unlink'] as const;
const me = { $env: 'uid' } as const;
const ZERO: Decimal = orm.toDecimal(0);

/** A monetary value's amount (a Money object or a plain Decimal), or null. */
export function amountOf(value: unknown): Decimal | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && 'amount' in value) return (value as { amount: Decimal }).amount;
  return value as Decimal;
}

export const PosShop = defineModel('pos.shop', {
  label: 'Shop',
  recName: 'name',
  order: ['name asc'],
  companyScoped: { required: true },
  archivable: true,
  access: { 'pos.cashier': ['read'], 'pos.manager': [...ALL, 'export'] },
  fields: {
    name: f.char({ required: true }),
    /** Prices on the register include the taxes (a shop) or not (a wholesale counter). */
    pricesIncludeTax: f.boolean({ default: true, label: 'Prices include taxes' }),
    salesJournal: f.many2one('account.journal', { ondelete: 'restrict', label: 'Sales journal' }),
    methods: f.one2many('pos.payment.method', 'shop', { label: 'Payment methods' }),
    sessions: f.one2many('pos.session', 'shop'),
    /** The receipt's footer line (thanks, the return policy). */
    receiptFooter: f.char({ size: 200, label: 'Receipt footer' }),
    /** Where a closing's cash difference goes (a gain or a loss); the income account otherwise. */
    differenceAccount: f.many2one('account.account', {
      ondelete: 'restrict',
      label: 'Cash difference account',
    }),
  },
});

/** How a shop takes money: cash, a card terminal, mobile money, a transfer; each to its journal. */
export const PosPaymentMethod = defineModel('pos.payment.method', {
  label: 'Payment method',
  recName: 'name',
  order: ['sequence asc', 'id asc'],
  archivable: true,
  access: { 'pos.cashier': ['read'], 'pos.manager': ALL },
  fields: {
    shop: f.many2one('pos.shop', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true }),
    kind: f.selection(
      { cash: 'Cash', card: 'Card', mobile: 'Mobile money', transfer: 'Bank transfer' },
      { required: true, default: 'cash' },
    ),
    journal: f.many2one('account.journal', { ondelete: 'restrict' }),
    sequence: f.integer({ required: true, default: 10 }),
  },
});

export const PosSession = defineModel('pos.session', {
  label: 'Session',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'cashier', 'closingDifference'],
  access: { 'pos.cashier': ['read', 'write', 'create'], 'pos.manager': [...ALL, 'export'] },
  rules: {
    // Cashiers see and work in their own sessions; managers every session.
    own: { groups: ['pos.cashier'], perms: ['read', 'write', 'create'], domain: { cashier: me } },
    all: { groups: ['pos.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, sequence: 'pos.session' }),
    shop: f.many2one('pos.shop', { required: true, ondelete: 'restrict' }),
    cashier: f.many2one('res.users', { required: true, default: (env: Env) => env.userId }),
    openedAt: f.datetime({ required: true, default: () => new Date(), label: 'Opened' }),
    closedAt: f.datetime({ label: 'Closed' }),
    /** The cash in the drawer when the session opened. */
    openingCash: f.decimal({ scale: 2, required: true, default: '0', label: 'Opening cash' }),
    /** The cash counted when closing. */
    closingCash: f.decimal({ scale: 2, label: 'Closing cash counted' }),
    expectedCash: f.decimal({
      scale: 2,
      store: true,
      label: 'Cash expected',
      ...compute(
        'pos.session',
        'expectedCash',
        [
          'openingCash',
          'orders.state',
          'orders.change',
          'orders.payments.amount',
          'orders.payments.kind',
        ],
        (sessions) => {
          for (const s of sessions) {
            let cash = s.openingCash;
            for (const o of s.orders) {
              if (o.state !== 'paid') continue;
              for (const p of o.payments) if (p.kind === 'cash') cash = cash.plus(p.amount);
              if (o.change !== null) cash = cash.minus(o.change);
            }
            s.expectedCash = cash;
          }
        },
      ),
    }),
    closingDifference: f.decimal({
      scale: 2,
      store: true,
      label: 'Difference',
      ...compute(
        'pos.session',
        'closingDifference',
        ['closingCash', 'expectedCash'],
        (sessions) => {
          for (const s of sessions)
            s.closingDifference =
              s.closingCash === null ? null : s.closingCash.minus(s.expectedCash ?? ZERO);
        },
      ),
    }),
    differenceReason: f.char({ size: 200, label: 'Difference explained' }),
    /** The journal entry of the closed session (one per session; none without a sales journal). */
    entry: f.many2one('account.move', { ondelete: 'set null', label: 'Journal entry' }),
    orders: f.one2many('pos.order', 'session'),
    orderCount: f.integer({
      store: true,
      label: 'Sales',
      ...compute('pos.session', 'orderCount', ['orders.state'], (sessions) => {
        for (const s of sessions)
          s.orderCount = [...s.orders].filter((o) => o.state === 'paid').length;
      }),
    }),
    total: f.decimal({
      scale: 2,
      store: true,
      label: 'Sold',
      ...compute('pos.session', 'total', ['orders.state', 'orders.total'], (sessions) => {
        for (const s of sessions)
          s.total = [...s.orders]
            .filter((o) => o.state === 'paid')
            .reduce((sum, o) => sum.plus(o.total ?? ZERO), ZERO);
      }),
    }),
    state: f.state({
      states: { open: 'Open', closed: 'Closed' },
      initial: 'open',
      transitions: {
        close: {
          from: ['open'],
          to: 'closed',
          guard: records('pos.session', async (sessions) =>
            sessions.filter((s) => s.closingCash === null),
          ),
          message: 'Count the cash in the drawer before closing.',
          before: records('pos.session', async (sessions): Promise<void> => {
            const open = (await sessions.load({ orders: true })).filter((s) =>
              [...s.orders].some((o) => o.state === 'draft'),
            );
            if (open.length > 0)
              throw new orm.ValidationError(
                'pos.session',
                ['state'],
                'A sale is still being paid; finish or void it before closing.',
                'Open the register and finish the sale.',
              );
          }),
          after: records('pos.session', async (sessions): Promise<void> => {
            await sessions.write({ closedAt: new Date() } as never);
            const env = sessions.env as unknown as Env;
            await env.flush();
            // The entry reads journals, accounts and taxes a cashier may not: booked as the system, audited.
            await env.asSuperuser({ reason: 'counter session books' }, (su) =>
              bookSessions(su, sessions.ids),
            );
            await env.model('pos.session').browse(sessions.ids).closed();
          }),
        },
      },
    }),
  },
  methods: {
    /** Runs once these sessions are closed. Nothing here; `pos_stock` and `pos_account` act on it. */
    closed: method('pos.session', async (): Promise<void> => undefined),
  },
  constraints: {
    oneOpenPerCashier: {
      ...check('pos.session', ['cashier', 'state'], async (sessions) => {
        const env = sessions.env as unknown as Env;
        const out: Id<'pos.session'>[] = [];
        for (const s of sessions) {
          if (s.state !== 'open') continue;
          const others = await env.model('pos.session').search({
            where: { cashier: s.cashier.id, state: 'open', id: { ne: s.id } },
            limit: 1,
          });
          if (others.length > 0) out.push(s.id);
        }
        return out;
      }),
      message: 'This cashier already has an open session; close it first.',
    },
    explainedDifference: {
      ...check(
        'pos.session',
        ['closingDifference', 'differenceReason', 'state'],
        async (sessions) =>
          sessions
            .filter(
              (s) =>
                s.state === 'closed' &&
                s.closingDifference !== null &&
                !s.closingDifference.isZero() &&
                (s.differenceReason === null || s.differenceReason.trim() === ''),
            )
            .map((s) => s.id),
      ),
      message: 'Say why the cash counted differs from the cash expected.',
    },
  },
});

/** Taxes of a line: percentages add up on the untaxed amount; fixed taxes per unit add to it. */
function taxesOnLine(
  untaxedOrGross: Decimal,
  quantity: Decimal,
  taxes: readonly {
    readonly amountType: string;
    readonly rate: Decimal;
    readonly fixedAmount: Decimal;
  }[],
  included: boolean,
): { untaxed: Decimal; tax: Decimal } {
  const percent = taxes
    .filter((t) => t.amountType === 'percent')
    .reduce((sum, t) => sum.plus(t.rate), ZERO);
  const fixed = taxes
    .filter((t) => t.amountType === 'fixed')
    .reduce((sum, t) => sum.plus(t.fixedAmount.times(quantity)), ZERO);
  if (!included) {
    const tax = untaxedOrGross.times(percent).div(100).plus(fixed);
    return { untaxed: untaxedOrGross, tax };
  }
  // The price holds the taxes: the untaxed part is what remains once the percentage and the fixed part are out.
  const untaxed = untaxedOrGross.minus(fixed).times(100).div(percent.plus(100));
  return {
    untaxed: untaxed.toDecimalPlaces(2),
    tax: untaxedOrGross.minus(untaxed.toDecimalPlaces(2)),
  };
}

export const PosOrder = defineModel('pos.order', {
  label: 'Sale',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'total'],
  access: { 'pos.cashier': ['read', 'write', 'create'], 'pos.manager': [...ALL, 'export'] },
  rules: {
    own: {
      groups: ['pos.cashier'],
      perms: ['read', 'write', 'create'],
      domain: { 'session.cashier': me },
    },
    all: { groups: ['pos.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, sequence: 'pos.order' }),
    session: f.many2one('pos.session', { required: true, ondelete: 'restrict' }),
    /** The id the device gave the sale: a sale queued offline is accepted once. */
    clientId: f.char({ size: 64, label: 'Device reference' }),
    partner: f.many2one('res.partner', { ondelete: 'set null', label: 'Customer' }),
    date: f.datetime({ required: true, default: () => new Date() }),
    lines: f.one2many('pos.order.line', 'order'),
    payments: f.one2many('pos.order.payment', 'order'),
    /** Copied from the shop when the sale is made: how its prices were shown. */
    pricesIncludeTax: f.boolean({ default: true, label: 'Prices include taxes' }),
    /** The sale this one refunds, if any (its quantities are negative). */
    refundOf: f.many2one('pos.order', { ondelete: 'set null', label: 'Refund of' }),
    refunds: f.one2many('pos.order', 'refundOf'),
    /** Why the customer brought it back (a refund). */
    refundReason: f.char({ size: 200, label: 'Refund reason' }),
    note: f.char({ size: 200 }),
    amountUntaxed: f.decimal({
      scale: 2,
      store: true,
      label: 'Untaxed',
      ...compute('pos.order', 'amountUntaxed', ['lines.subtotal'], (orders) => {
        for (const o of orders)
          o.amountUntaxed = [...o.lines].reduce((sum, l) => sum.plus(l.subtotal ?? ZERO), ZERO);
      }),
    }),
    amountTax: f.decimal({
      scale: 2,
      store: true,
      label: 'Taxes',
      ...compute('pos.order', 'amountTax', ['lines.taxAmount'], (orders) => {
        for (const o of orders)
          o.amountTax = [...o.lines].reduce((sum, l) => sum.plus(l.taxAmount ?? ZERO), ZERO);
      }),
    }),
    total: f.decimal({
      scale: 2,
      store: true,
      label: 'Total',
      ...compute('pos.order', 'total', ['amountUntaxed', 'amountTax'], (orders) => {
        for (const o of orders) o.total = (o.amountUntaxed ?? ZERO).plus(o.amountTax ?? ZERO);
      }),
    }),
    amountPaid: f.decimal({
      scale: 2,
      store: true,
      label: 'Paid',
      ...compute('pos.order', 'amountPaid', ['payments.amount'], (orders) => {
        for (const o of orders)
          o.amountPaid = [...o.payments].reduce((sum, p) => sum.plus(p.amount), ZERO);
      }),
    }),
    /** What the cashier gives back when the payments exceed the total (cash only). */
    change: f.decimal({
      scale: 2,
      store: true,
      label: 'Change',
      ...compute('pos.order', 'change', ['amountPaid', 'total'], (orders) => {
        for (const o of orders) {
          const over = (o.amountPaid ?? ZERO).minus(o.total ?? ZERO);
          o.change = over.gt(0) && (o.total ?? ZERO).gte(0) ? over : ZERO;
        }
      }),
    }),
    state: f.state({
      states: { draft: 'Being paid', paid: 'Paid', void: 'Voided' },
      initial: 'draft',
      transitions: {
        pay: {
          from: ['draft'],
          to: 'paid',
          guard: records('pos.order', async (orders) =>
            (await orders.load({ lines: true, session: true })).filter(
              (o) =>
                [...o.lines].length === 0 ||
                ((o.total ?? ZERO).gte(0)
                  ? (o.amountPaid ?? ZERO).lt(o.total ?? ZERO)
                  : !(o.amountPaid ?? ZERO).eq(o.total ?? ZERO)) ||
                o.session.state !== 'open',
            ),
          ),
          message:
            'A sale is paid when its lines are in, the payments cover the total and the session is open.',
          after: records('pos.order', async (orders): Promise<void> => {
            for (const id of orders.ids) await orders.env.emit('pos.order.paid', { id });
          }),
        },
        void: { from: ['draft'], to: 'void' },
      },
    }),
  },
  sqlConstraints: {
    oneClientId: {
      unique: ['session', 'clientId'],
      where: orm.sql`client_id IS NOT NULL`,
      message: 'This sale was already received from the device.',
    },
  },
});

/** The untaxed amount and the tax of a line, from its price, quantity, discount, taxes and the shop's pricing. */
const lineAmounts = compute(
  'pos.order.line',
  ['subtotal', 'taxAmount'],
  [
    'quantity',
    'priceUnit',
    'discount',
    'taxes.rate',
    'taxes.amountType',
    'taxes.fixedAmount',
    'order.pricesIncludeTax',
  ],
  (lines) => {
    for (const l of lines) {
      const gross = l.priceUnit
        .times(l.quantity)
        .times(orm.toDecimal(100).minus(l.discount))
        .div(100);
      const { untaxed, tax } = taxesOnLine(
        gross,
        l.quantity,
        [...l.taxes],
        l.order.pricesIncludeTax === true,
      );
      l.subtotal = untaxed.toDecimalPlaces(2);
      l.taxAmount = tax.toDecimalPlaces(2);
    }
  },
);

export const PosOrderLine = defineModel('pos.order.line', {
  label: 'Sale line',
  order: ['id asc'],
  access: { 'pos.cashier': ['read', 'write', 'create', 'unlink'], 'pos.manager': ALL },
  fields: {
    order: f.many2one('pos.order', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    name: f.char({ required: true, label: 'Description' }),
    quantity: f.decimal({ scale: 3, required: true, default: '1' }),
    /** The unit price as shown on the register (taxes included when the shop's prices include them). */
    priceUnit: f.decimal({ scale: 2, required: true, default: '0', label: 'Unit price' }),
    discount: f.decimal({ scale: 2, required: true, default: '0', label: 'Discount %' }),
    taxes: f.many2many('account.tax', { relation: 'pos_line_tax_rel' }),
    subtotal: f.decimal({ scale: 2, store: true, label: 'Untaxed', ...lineAmounts }),
    taxAmount: f.decimal({ scale: 2, store: true, label: 'Tax', ...lineAmounts }),
  },
});

export const PosOrderPayment = defineModel('pos.order.payment', {
  label: 'Payment',
  order: ['id asc'],
  access: { 'pos.cashier': ['read', 'write', 'create', 'unlink'], 'pos.manager': ALL },
  fields: {
    order: f.many2one('pos.order', { required: true, ondelete: 'cascade' }),
    method: f.many2one('pos.payment.method', { required: true, ondelete: 'restrict' }),
    amount: f.decimal({ scale: 2, required: true }),
    /** The provider's or terminal's reference (a bKash transaction id, a card slip). */
    reference: f.char({ size: 80 }),
    /** The method's kind, kept on the payment so a session's cash adds up without a second hop. */
    kind: f.selection(
      { cash: 'Cash', card: 'Card', mobile: 'Mobile money', transfer: 'Bank transfer' },
      {
        store: true,
        ...compute('pos.order.payment', 'kind', ['method.kind'], (payments) => {
          for (const p of payments) p.kind = p.method.kind;
        }),
      },
    ),
  },
  constraints: {
    methodOfTheShop: {
      ...check('pos.order.payment', ['method', 'order'], async (payments) =>
        (await payments.load({ method: true, order: { session: true } }))
          .filter((p) => p.method.shop.id !== p.order.session.shop.id)
          .map((p) => p.id),
      ),
      message: 'The payment method belongs to another shop.',
    },
  },
});

export const posShutro = defineModule({
  name: 'pos',
  version: '0.1.0',
  depends: [productShutro, contactsShutro, accountingShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: 'pos.cashier',
      label: 'Counter cashier',
      // Receipts are documents: cashiers read the templates.
      implies: ['product.user', 'contacts.user', 'reporting.user'],
    }),
    orm.defineGroup({ code: 'pos.manager', label: 'Counter manager', implies: ['pos.cashier'] }),
  ],
  permissions: [
    orm.definePermission({
      code: 'pos.refund_any',
      label: 'Refund any sale (not only those of one’s own open session)',
      groups: ['pos.manager'],
    }),
  ],
  sequences: [
    orm.defineSequence({ code: 'pos.session', prefix: 'S/{year}/', padding: 5, reset: 'yearly' }),
    orm.defineSequence({ code: 'pos.order', prefix: 'R/{year}/', padding: 6, reset: 'yearly' }),
  ],
  models: [PosShop, PosPaymentMethod, PosSession, PosOrder, PosOrderLine, PosOrderPayment],
});
