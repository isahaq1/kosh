/**
 * The data layer of Loyalty (RFC 0034 §2.6): a **program** with its earning **rules** (so many points for so much
 * spent, on everything or on a product or a category), its **tiers** (points earned in a window multiply what an
 * order gives) and the life of a point; a **card** per customer with its balance and tier; and the **ledger**:
 * every point earned, taken back, expired or given by hand. Orders of Sales — and of the Shop, which are Sales
 * orders — earn when they are confirmed, once, and give the points back when they are cancelled.
 *
 * Before a program runs, **Preview** says what it would have given over the orders of a past period, and what
 * that is worth: the cost is known before the first point is.
 */
import { randomBytes } from 'node:crypto';
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { productShutro } from '@kosh/product';
import { salesShutro } from '@kosh/sales';
import { emitting } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  records,
} from './.kosh/bindings.js';
import {
  type EarnRule,
  earn,
  expiredPoints,
  monthsBefore,
  type Order,
  preview,
  redeemLimit,
  type Tier,
  tierOf,
  voucherUse,
} from './engine.js';
import {
  applyPromotions,
  type PromoOrder,
  type Promotion,
  type PromotionKind,
  previewPromotion,
} from './promotions.js';

/**
 * Fields the server maintains: written by its own code (as the system) and by Administrators only. An empty list
 * would mean *everyone* — Shutro reads no groups as no restriction.
 */
const SYSTEM = ['base.admin'] as const;

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
/** An amount in hundredths. */
const cents = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  const amount =
    typeof value === 'object' && 'amount' in value ? (value as { amount: unknown }).amount : value;
  return Number(
    orm
      .toDecimal(amount as never)
      .times(100)
      .toDecimalPlaces(0)
      .toString(),
  );
};
const money = (hundredths: number): string => (hundredths / 100).toFixed(2);

export const LoyaltyProgram = defineModel('loyalty.program', {
  label: 'Loyalty program',
  recName: 'name',
  order: ['id desc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['state', 'pointValue', 'expireMonths'],
  access: { 'loyalty.user': READ, 'loyalty.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true }),
    pointValue: f.decimal({
      scale: 2,
      required: true,
      default: '1',
      label: 'A point is worth',
      help: 'In the company’s currency: what the previews count the points at, and what a point is worth when it is spent.',
    }),
    autoEnrol: f.boolean({
      default: true,
      label: 'Every customer joins',
      help: 'A customer gets a card with their first confirmed order; off: only customers given a card earn.',
    }),
    tierMonths: f.integer({
      required: true,
      default: 12,
      label: 'Tiers count the last (months)',
      help: 'A customer’s tier comes from the points they earned in this many months.',
    }),
    expireMonths: f.integer({
      label: 'Points expire after (months)',
      help: 'Points not used this long after they were earned are lost, the oldest first; empty: never.',
    }),
    redeemable: f.boolean({
      default: true,
      label: 'Points can be spent',
      help: 'On an order, points come off what the customer pays, at the value of a point.',
    }),
    redeemMaxPercent: f.integer({
      required: true,
      default: 100,
      label: 'Points pay at most (%)',
      help: 'The share of an order — taxes included — that points may pay.',
    }),
    redeemMinPoints: f.integer({
      required: true,
      default: 0,
      label: 'Spent from (points)',
      help: 'Fewer points than this are not spent on an order.',
    }),
    rules: f.one2many('loyalty.rule', 'program'),
    tiers: f.one2many('loyalty.tier', 'program'),
    cards: f.one2many('loyalty.card', 'program'),
    previewFrom: f.date({
      label: 'Preview from',
      help: 'Preview counts the confirmed orders from this day; empty: the month before this one.',
    }),
    previewTo: f.date({ label: 'Preview to' }),
    previewOrders: f.integer({ label: 'Orders', groups: { write: [...SYSTEM] } }),
    previewEarning: f.integer({
      label: 'Orders that would have earned',
      groups: { write: [...SYSTEM] },
    }),
    previewPoints: f.integer({ label: 'Points given', groups: { write: [...SYSTEM] } }),
    previewRevenue: f.decimal({
      scale: 2,
      label: 'Sales before taxes',
      groups: { write: [...SYSTEM] },
    }),
    previewCost: f.decimal({
      scale: 2,
      label: 'Worth',
      groups: { write: [...SYSTEM] },
      help: 'The points at the value of a point: what the program would have cost if every point were spent.',
    }),
    previewShare: f.decimal({
      scale: 2,
      label: 'Share of sales %',
      groups: { write: [...SYSTEM] },
    }),
    previewAt: f.datetime({ label: 'Previewed at', groups: { write: [...SYSTEM] } }),
    state: f.state({
      states: { draft: 'Draft', running: 'Running', ended: 'Ended' },
      initial: 'draft',
      help: 'Draft while it is written and previewed; running while orders earn; ended after — cards keep their points.',
      transitions: {
        // What it would have given over past orders: nothing is earned, nothing is written but the figures.
        look: {
          from: ['draft', 'running'],
          to: 'draft',
          guard: records('loyalty.program', async (programs) =>
            (await programs.load(['state'])).filter((p) => p.state !== 'draft'),
          ),
          message: 'A program is previewed while it is a draft: duplicate it to try other rules.',
          after: records('loyalty.program', async (programs) => {
            const env = programs.env as unknown as Env;
            for (const id of programs.ids) await previewProgram(env, id as number);
          }),
        },
        launch: emitting('loyalty.program.launched', {
          from: ['draft'],
          to: 'running',
          guard: records('loyalty.program', (programs) =>
            unready(programs.env as unknown as Env, programs.ids as readonly number[]),
          ),
          message:
            'A program runs with at least one rule, and one program runs at a time: end the other first.',
        }),
        finish: { from: ['running'], to: 'ended' },
      },
    }),
  },
  sqlConstraints: {
    sane: {
      check: orm.sql`point_value >= 0 AND tier_months > 0 AND (expire_months IS NULL OR expire_months > 0)
        AND redeem_max_percent BETWEEN 0 AND 100 AND redeem_min_points >= 0`,
      message: 'A point is worth zero or more; tiers and expiry count at least one month.',
    },
  },
});

export const LoyaltyRule = defineModel('loyalty.rule', {
  label: 'Earning rule',
  recName: 'name',
  order: ['program asc', 'sequence asc', 'id asc'],
  companyScoped: { required: true },
  access: { 'loyalty.user': READ, 'loyalty.manager': ALL },
  fields: {
    program: f.many2one('loyalty.program', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    sequence: f.integer({ required: true, default: 10 }),
    name: f.char({ required: true }),
    points: f.integer({ required: true, default: 1, label: 'Points' }),
    amountPer: f.decimal({
      scale: 2,
      required: true,
      default: '100',
      label: 'For every',
      help: 'So many points for every full amount of this, before taxes, discounts taken off.',
    }),
    product: f.many2one('product.product', {
      ondelete: 'cascade',
      label: 'Only this product',
    }),
    category: f.many2one('product.category', {
      ondelete: 'cascade',
      label: 'Only this category',
      help: 'With a product or a category, the rule counts their lines only; empty: the whole order.',
    }),
    minimumOrder: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Orders from',
      help: 'Orders worth less, before taxes, earn nothing by this rule.',
    }),
    dateFrom: f.date({ label: 'From' }),
    dateTo: f.date({
      label: 'To',
      help: 'A rule with dates gives only on those days: a campaign.',
    }),
  },
  sqlConstraints: {
    gives: {
      check: orm.sql`points > 0 AND amount_per > 0 AND minimum_order >= 0`,
      message: 'A rule gives at least a point for an amount above zero.',
    },
    ordered: {
      check: orm.sql`date_to IS NULL OR date_from IS NULL OR date_to >= date_from`,
      message: 'A rule ends on or after it starts.',
    },
  },
});

export const LoyaltyTier = defineModel('loyalty.tier', {
  label: 'Tier',
  recName: 'name',
  order: ['program asc', 'minPoints asc'],
  companyScoped: { required: true },
  access: { 'loyalty.user': READ, 'loyalty.manager': ALL },
  fields: {
    program: f.many2one('loyalty.program', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    name: f.char({ required: true }),
    minPoints: f.integer({
      required: true,
      label: 'From (points earned)',
      help: 'Points earned in the program’s window to be in this tier.',
    }),
    multiplier: f.decimal({
      scale: 2,
      required: true,
      default: '1',
      label: 'Earns × ',
      help: 'What an order earns is multiplied by this: 1.5 gives half as much again.',
    }),
  },
  sqlConstraints: {
    sane: {
      check: orm.sql`min_points >= 0 AND multiplier > 0`,
      message: 'A tier starts at zero points or more and multiplies by more than zero.',
    },
  },
});

/** A customer in a program: their points, and the tier those earned lately put them in. */
export const LoyaltyCard = defineModel('loyalty.card', {
  label: 'Loyalty card',
  recName: 'code',
  order: ['id desc'],
  companyScoped: { required: true },
  access: {
    'loyalty.user': ['read', 'create', 'export'],
    'loyalty.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    code: f.char({ required: true, sequence: 'loyalty.card', label: 'Card number' }),
    program: f.many2one('loyalty.program', {
      required: true,
      checkCompany: true,
      ondelete: 'restrict',
    }),
    partner: f.many2one('res.partner', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
      label: 'Customer',
    }),
    points: f.integer({
      label: 'Points',
      groups: { write: [...SYSTEM] },
      help: 'Everything earned and given, less what was taken back, spent or lost.',
    }),
    earned: f.integer({
      label: 'Earned lately',
      groups: { write: [...SYSTEM] },
      help: 'Points earned from orders in the program’s tier window.',
    }),
    tier: f.many2one('loyalty.tier', {
      ondelete: 'set null',
      label: 'Tier',
      groups: { write: [...SYSTEM] },
    }),
    entries: f.one2many('loyalty.entry', 'card'),
  },
  sqlConstraints: {
    oneCard: {
      unique: ['program', 'partner'],
      message: 'This customer already has a card of this program.',
    },
  },
});

const ENTRY_KINDS = {
  earn: 'Earned',
  reverse: 'Taken back',
  expire: 'Expired',
  adjust: 'Adjustment',
  redeem: 'Spent',
  refund: 'Given back',
} as const;

/** The ledger of a card. Never changed: a mistake is another line. */
export const LoyaltyEntry = defineModel('loyalty.entry', {
  label: 'Points',
  order: ['date desc', 'id desc'],
  companyScoped: { required: true },
  access: {
    'loyalty.user': ['read', 'export'],
    'loyalty.manager': ['read', 'create', 'export', 'import'],
  },
  fields: {
    card: f.many2one('loyalty.card', { required: true, ondelete: 'cascade' }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    kind: f.selection(ENTRY_KINDS, {
      required: true,
      default: 'adjust',
      groups: { write: [...SYSTEM] },
      help: 'Earned, taken back and expired lines are the server’s; a line added by hand is an adjustment.',
    }),
    points: f.integer({
      required: true,
      label: 'Points',
      help: 'Above zero: earned or given; below: taken back, spent or lost.',
    }),
    resModel: f.char({ size: 80, label: 'About (model)', groups: { write: [...SYSTEM] } }),
    resId: f.integer({ label: 'About (record)', groups: { write: [...SYSTEM] } }),
    note: f.char({ label: 'Why' }),
  },
  sqlConstraints: {
    notZero: { check: orm.sql`points <> 0`, message: 'A ledger line moves at least one point.' },
  },
  constraints: {
    // A card never owes points: what is taken off by hand is there to take.
    notBelowZero: {
      ...check('loyalty.entry', ['points', 'card'], (entries) =>
        overdrawn(entries.env as unknown as Env, entries.ids as readonly number[]),
      ),
      message: 'The card does not have that many points.',
    },
  },
});

const PROMOTION_KIND_LABELS = {
  percent: 'A percentage off',
  amount: 'An amount off',
  buy_get: 'Buy some, get some free',
} as const;

/**
 * A promotion (RFC 0034 §2.6): a percentage or an amount off — the whole order, a product or a category —, or
 * *buy X get Y*; by itself or with a code; between dates. Like a program, it is previewed on past orders before it
 * runs: what it would have taken off, and what share of the sales that is.
 */
export const LoyaltyPromotion = defineModel('loyalty.promotion', {
  label: 'Promotion',
  recName: 'name',
  order: ['id desc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['state', 'kind', 'value', 'dateFrom', 'dateTo'],
  access: { 'loyalty.user': READ, 'loyalty.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, help: 'What the customer reads on the order.' }),
    kind: f.selection(PROMOTION_KIND_LABELS, {
      required: true,
      default: 'percent',
      label: 'Gives',
      help: 'A percentage or an amount off what it applies to, or free units for units bought.',
    }),
    value: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Percentage or amount',
      help: 'A percentage off: 15 is 15 %. An amount off: in the company’s currency, before taxes.',
    }),
    product: f.many2one('product.product', { ondelete: 'cascade', label: 'Only this product' }),
    category: f.many2one('product.category', {
      ondelete: 'cascade',
      label: 'Only this category',
      help: 'What it applies to — and, for buy and get, what must be bought; empty: everything.',
    }),
    minimumOrder: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Orders from',
      help: 'The goods of the order must be worth this, before taxes.',
    }),
    buy: f.integer({ required: true, default: 0, label: 'Buy (units)' }),
    get: f.integer({
      required: true,
      default: 0,
      label: 'Get free (units)',
      help: 'For every Buy and Get units together, the cheapest Get are free; with a free product, Get of it for every Buy bought.',
    }),
    rewardProduct: f.many2one('product.product', {
      ondelete: 'cascade',
      label: 'Free product',
      help: 'Buy and get: the free units are of this product, when it is on the order; empty: of what was bought.',
    }),
    code: f.char({
      size: 40,
      label: 'Code',
      help: 'Only orders that carry this code get it; empty: every order it applies to.',
    }),
    dateFrom: f.date({ label: 'From' }),
    dateTo: f.date({ label: 'To' }),
    exclusive: f.boolean({
      default: false,
      label: 'Not with other promotions',
      help: 'It is taken alone, when that gives the customer more than the others together.',
    }),
    previewFrom: f.date({
      label: 'Preview from',
      help: 'Preview counts the confirmed orders from this day; empty: the month before this one.',
    }),
    previewTo: f.date({ label: 'Preview to' }),
    previewOrders: f.integer({ label: 'Orders', groups: { write: [...SYSTEM] } }),
    previewApplied: f.integer({
      label: 'Orders it would have applied to',
      groups: { write: [...SYSTEM] },
    }),
    previewDiscount: f.decimal({
      scale: 2,
      label: 'Taken off',
      groups: { write: [...SYSTEM] },
      help: 'What it would have cost over those orders — with a code, as if every customer had typed it.',
    }),
    previewRevenue: f.decimal({
      scale: 2,
      label: 'Sales before taxes',
      groups: { write: [...SYSTEM] },
    }),
    previewShare: f.decimal({
      scale: 2,
      label: 'Share of sales %',
      groups: { write: [...SYSTEM] },
    }),
    previewFree: f.integer({ label: 'Units given free', groups: { write: [...SYSTEM] } }),
    previewAt: f.datetime({ label: 'Previewed at', groups: { write: [...SYSTEM] } }),
    state: f.state({
      states: { draft: 'Draft', running: 'Running', ended: 'Ended' },
      initial: 'draft',
      help: 'Draft while it is written and previewed; running while orders may take it; ended after.',
      transitions: {
        look: {
          from: ['draft'],
          to: 'draft',
          after: records('loyalty.promotion', async (promotions) => {
            const env = promotions.env as unknown as Env;
            for (const id of promotions.ids) await previewPromotionOf(env, id as number);
          }),
        },
        launch: emitting('loyalty.promotion.launched', { from: ['draft'], to: 'running' }),
        finish: { from: ['running'], to: 'ended' },
      },
    }),
  },
  sqlConstraints: {
    sane: {
      check: orm.sql`value >= 0 AND minimum_order >= 0 AND buy >= 0 AND get >= 0
        AND (kind <> 'percent' OR value <= 100) AND (kind <> 'buy_get' OR (buy > 0 AND get > 0))`,
      message:
        'A percentage is from 0 to 100, an amount zero or more; buy and get both need a number of units.',
    },
    ordered: {
      check: orm.sql`date_to IS NULL OR date_from IS NULL OR date_to >= date_from`,
      message: 'A promotion ends on or after it starts.',
    },
  },
  constraints: {
    codeReads: {
      ...check('loyalty.promotion', ['code'], (promotions) =>
        promotions.filter((x) => x.code !== null && !/^[A-Z0-9_-]{2,40}$/.test(x.code)),
      ),
      message: 'A code is 2 to 40 capitals, digits, - or _.',
    },
  },
});

const VOUCHER_KINDS = { gift_card: 'Gift card', wallet: 'Wallet' } as const;
const voucherCode = (): string => {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  let code = 'GC';
  for (let n = 0; n < 12; n += 1)
    code += `${n % 4 === 0 ? '-' : ''}${letters[(bytes[n] as number) % 32]}`;
  return code;
};

/**
 * Money a customer holds with the company (RFC 0034 §2.6): a **gift card** — for whoever has its code — or a
 * **wallet** of one customer. What it holds is its ledger; an order takes from it, and gives back when cancelled.
 */
export const LoyaltyVoucher = defineModel('loyalty.voucher', {
  label: 'Wallet or gift card',
  recName: 'code',
  order: ['id desc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['dateExpiry', 'partner'],
  access: {
    'loyalty.user': ['read', 'export'],
    'loyalty.manager': ['read', 'write', 'create', 'export', 'import'],
  },
  fields: {
    code: f.char({
      size: 40,
      required: true,
      default: voucherCode,
      label: 'Code',
      groups: { write: [...SYSTEM] },
      help: 'What is typed on an order to pay with it.',
    }),
    kind: f.selection(VOUCHER_KINDS, {
      required: true,
      default: 'gift_card',
      help: 'A gift card pays for whoever has its code; a wallet only for its customer.',
    }),
    partner: f.many2one('res.partner', {
      ondelete: 'restrict',
      checkCompany: true,
      label: 'Customer',
      help: 'A wallet’s owner; on a gift card, who it was given to, if known.',
    }),
    dateExpiry: f.date({
      label: 'Valid until',
      help: 'After this day it pays nothing; empty: no end.',
    }),
    note: f.char({ label: 'Note' }),
    entries: f.one2many('loyalty.voucher.entry', 'voucher'),
    balance: f.decimal({
      scale: 2,
      store: true,
      label: 'Balance',
      help: 'What was loaded and given back, less what orders took.',
      ...compute('loyalty.voucher', 'balance', ['entries.amount'], (vouchers) => {
        for (const v of vouchers)
          v.balance = [...v.entries].reduce((sum, e) => sum.plus(e.amount), orm.toDecimal(0));
      }),
    }),
  },
  sqlConstraints: {
    oneCode: { unique: ['company', 'code'], message: 'Another wallet or gift card has this code.' },
  },
  constraints: {
    walletOwner: {
      ...check('loyalty.voucher', ['kind', 'partner'], (vouchers) =>
        vouchers.filter((v) => v.kind === 'wallet' && v.partner === null),
      ),
      message: 'A wallet belongs to a customer.',
    },
  },
});

const VOUCHER_ENTRY_KINDS = { load: 'Loaded', spend: 'Spent', refund: 'Given back' } as const;

/** The ledger of a wallet or a gift card. Never changed: a mistake is another line. */
export const LoyaltyVoucherEntry = defineModel('loyalty.voucher.entry', {
  label: 'Wallet or gift card movement',
  order: ['date desc', 'id desc'],
  companyScoped: { required: true },
  access: {
    'loyalty.user': ['read', 'export'],
    'loyalty.manager': ['read', 'create', 'export', 'import'],
  },
  fields: {
    voucher: f.many2one('loyalty.voucher', { required: true, ondelete: 'cascade' }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    kind: f.selection(VOUCHER_ENTRY_KINDS, {
      required: true,
      default: 'load',
      groups: { write: [...SYSTEM] },
      help: 'A line added by hand is a load — or, below zero, money taken off; orders write the others.',
    }),
    amount: f.decimal({
      scale: 2,
      required: true,
      label: 'Amount',
      help: 'Above zero: loaded or given back; below: spent or taken off.',
    }),
    resModel: f.char({ size: 80, label: 'About (model)', groups: { write: [...SYSTEM] } }),
    resId: f.integer({ label: 'About (record)', groups: { write: [...SYSTEM] } }),
    note: f.char({ label: 'Why' }),
  },
  sqlConstraints: {
    notZero: { check: orm.sql`amount <> 0`, message: 'A movement is for more than nothing.' },
  },
  constraints: {
    notBelowZero: {
      ...check('loyalty.voucher.entry', ['amount', 'voucher'], (entries) =>
        overspent(entries.env as unknown as Env, entries.ids as readonly number[]),
      ),
      message: 'It does not hold that much.',
    },
  },
});

/** The points an order earned and spent, and the wallet or gift card it took from. */
export const OrderLoyalty = extendModel('sale.order', {
  fields: {
    loyaltyPoints: f.integer({
      label: 'Points earned',
      groups: { write: [...SYSTEM] },
      help: 'What the customer’s loyalty card earned with this order, when it was confirmed.',
    }),
    loyaltyRedeem: f.integer({
      label: 'Points to spend',
      help: 'Type the points, then press Apply points and credit: they come off the order and leave the card.',
    }),
    voucherCode: f.char({
      size: 40,
      label: 'Gift card or wallet',
      help: 'Its code: it pays what the order still comes to, or all it holds.',
    }),
    promoCode: f.char({
      size: 40,
      label: 'Promotion code',
      help: 'For promotions that ask for one; the others apply by themselves with Apply promotions.',
    }),
    promotionAmount: f.decimal({
      scale: 2,
      label: 'Taken off by promotions',
      groups: { write: [...SYSTEM] },
    }),
    loyaltyRedeemed: f.integer({ label: 'Points spent', groups: { write: [...SYSTEM] } }),
    voucherUsed: f.decimal({
      scale: 2,
      label: 'Paid by gift card or wallet',
      groups: { write: [...SYSTEM] },
    }),
  },
  fieldOverrides: {
    state: {
      transitionsAdd: {
        // The running promotions that apply, each as a line below zero; pressed again, they are worked out anew.
        promote: {
          from: ['draft'],
          to: 'draft',
          after: records('sale.order', async (orders) => {
            const env = orders.env as unknown as Env;
            for (const id of orders.ids) await promoteOrder(env, id as number);
          }),
        },
        // Takes the points and the credit off the quotation, or changes what was taken: held from now on.
        credit: {
          from: ['draft'],
          to: 'draft',
          after: records('sale.order', async (orders) => {
            const env = orders.env as unknown as Env;
            for (const id of orders.ids) await applyCredits(env, id as number);
          }),
        },
      },
    },
  },
});

/** A line that takes points or a gift card off an order. */
export const LineLoyalty = extendModel('sale.order.line', {
  fields: {
    loyaltyKind: f.selection(
      { points: 'Loyalty points', voucher: 'Gift card or wallet', promotion: 'Promotion' },
      {
        label: 'Paid with',
        groups: { write: [...SYSTEM] },
        help: 'Set on the lines Loyalty adds: what they took is held until the order is cancelled.',
      },
    ),
    promotion: f.many2one('loyalty.promotion', {
      ondelete: 'set null',
      label: 'Promotion',
      groups: { write: [...SYSTEM] },
    }),
  },
});

/** The service products the credit lines of a company are charged as, made the first time. */
export const CompanyLoyalty = extendModel('res.company', {
  fields: {
    loyaltyPointsProduct: f.many2one('product.product', {
      ondelete: 'set null',
      label: 'Product of points spent',
      groups: { write: [...SYSTEM] },
    }),
    loyaltyVoucherProduct: f.many2one('product.product', {
      ondelete: 'set null',
      label: 'Product of gift cards and wallets',
      groups: { write: [...SYSTEM] },
    }),
    loyaltyPromotionProduct: f.many2one('product.product', {
      ondelete: 'set null',
      label: 'Product of promotions',
      groups: { write: [...SYSTEM] },
    }),
  },
});

// ---- reading

/** The entries among `ids` that leave their card below zero. */
async function overdrawn(env: Env, ids: readonly number[]): Promise<number[]> {
  return env.asSuperuser({ reason: 'a card’s balance' }, async (su) => {
    const out: number[] = [];
    const rows = (
      await su
        .model('loyalty.entry')
        .browse([...ids] as never)
        .load(['card', 'points', 'kind'])
    ).read(['id', 'card', 'points', 'kind']);
    for (const row of rows) {
      // An order taken back may leave a card that already spent the points short: that is the books' truth.
      if (Number(row['points']) > 0 || row['kind'] === 'reverse') continue;
      const all = await su.model('loyalty.entry').search({ where: { card: row['card'] as never } });
      if ([...all].reduce((sum, e) => sum + e.points, 0) < 0) out.push(Number(row['id']));
    }
    return out;
  });
}

/** The movements among `ids` that leave their wallet or gift card below zero. */
async function overspent(env: Env, ids: readonly number[]): Promise<number[]> {
  return env.asSuperuser({ reason: 'a wallet’s balance' }, async (su) => {
    const out: number[] = [];
    const rows = (
      await su
        .model('loyalty.voucher.entry')
        .browse([...ids] as never)
        .load(['voucher', 'amount'])
    ).read(['id', 'voucher', 'amount']);
    for (const row of rows) {
      if (cents(row['amount']) > 0) continue;
      const all = await su
        .model('loyalty.voucher.entry')
        .search({ where: { voucher: row['voucher'] as never } });
      if ([...all].reduce((sum, e) => sum + cents(e.amount), 0) < 0) out.push(Number(row['id']));
    }
    return out;
  });
}

/** The programs among `ids` that cannot run: no rule, or another program of the company runs. */
async function unready(env: Env, ids: readonly number[]): Promise<number[]> {
  return env.asSuperuser({ reason: 'a program launched' }, async (su) => {
    const out: number[] = [];
    for (const p of await su
      .model('loyalty.program')
      .browse([...ids] as never)
      .load({ rules: true, company: true })) {
      const other = await su.model('loyalty.program').search({
        where: { company: p.company.id, state: 'running', id: { ne: p.id } } as never,
        limit: 1,
      });
      if (p.rules.length === 0 || other.length > 0) out.push(p.id as number);
    }
    return out;
  });
}

interface Loaded {
  readonly id: number;
  readonly company: number;
  readonly pointValue: number;
  readonly autoEnrol: boolean;
  readonly tierMonths: number;
  readonly expireMonths: number | null;
  readonly redeemable: boolean;
  readonly redeemMaxPercent: number;
  readonly redeemMinPoints: number;
  readonly rules: readonly EarnRule[];
  readonly tiers: readonly Tier[];
}

async function loadProgram(su: Env, id: number): Promise<Loaded | null> {
  const [p] = await su
    .model('loyalty.program')
    .browse([id as never])
    .load({
      company: true,
      rules: { product: true, category: true },
      tiers: true,
    });
  if (p === undefined) return null;
  return {
    id: p.id as number,
    company: p.company.id as number,
    pointValue: cents(p.pointValue),
    autoEnrol: p.autoEnrol === true,
    tierMonths: p.tierMonths,
    expireMonths: p.expireMonths,
    redeemable: p.redeemable === true,
    redeemMaxPercent: p.redeemMaxPercent,
    redeemMinPoints: p.redeemMinPoints,
    rules: [...p.rules]
      .sort((a, b) => a.sequence - b.sequence || (a.id as number) - (b.id as number))
      .map((r) => ({
        id: r.id as number,
        amountPer: cents(r.amountPer),
        points: r.points,
        product: (r.product?.id as number | undefined) ?? null,
        category: (r.category?.id as number | undefined) ?? null,
        minimumOrder: cents(r.minimumOrder),
        dateFrom: r.dateFrom === null ? null : iso(r.dateFrom),
        dateTo: r.dateTo === null ? null : iso(r.dateTo),
      })),
    tiers: [...p.tiers].map((t) => ({
      id: t.id as number,
      minPoints: t.minPoints,
      multiplier: cents(t.multiplier),
    })),
  };
}

/** The running program of a company, if it has one. */
async function runningProgram(su: Env, company: number): Promise<Loaded | null> {
  const [found] = await su.model('loyalty.program').search({
    where: { company: company as never, state: 'running' } as never,
    limit: 1,
  });
  return found === undefined ? null : loadProgram(su, found.id as number);
}

/** Sales orders as the engine reads them. */
async function ordersOf(
  su: Env,
  ids: readonly number[],
): Promise<Map<number, Order & { partner: number }>> {
  const out = new Map<number, Order & { partner: number }>();
  if (ids.length === 0) return out;
  for (const o of await su
    .model('sale.order')
    .browse([...ids] as never)
    .load({ partner: true, lines: { product: { category: true } } }))
    out.set(o.id as number, {
      date: iso(o.dateOrder),
      partner: o.partner.id as number,
      // What earns: the goods, and everything that takes off them. A charge an app adds — a delivery fee — is
      // a product that cannot be sold by hand, and earns nothing.
      lines: [...o.lines]
        .filter((l) => l.product.saleOk !== false || cents(l.subtotal) < 0)
        .map((l) => ({
          product: l.product.id as number,
          category: (l.product.category?.id as number | undefined) ?? null,
          amount: cents(l.subtotal),
        })),
    });
  return out;
}

// ---- the preview

/**
 * What a program would have given (RFC 0034 §2.6): its rules over the company's confirmed orders of the preview's
 * period — the month before this one unless dates are given —, written on the program: orders, points, their
 * worth and its share of the sales. Nothing is earned.
 */
export async function previewProgram(env: Env, id: number): Promise<void> {
  await env.asSuperuser({ reason: 'a loyalty program previewed' }, async (su) => {
    const program = await loadProgram(su, id);
    if (program === null) return;
    const [dates] = (
      await su
        .model('loyalty.program')
        .browse([id as never])
        .load(['previewFrom', 'previewTo'])
    ).read(['previewFrom', 'previewTo']);
    const today = iso(su.today());
    const firstOfMonth = `${today.slice(0, 7)}-01`;
    const from =
      dates?.['previewFrom'] === null || dates?.['previewFrom'] === undefined
        ? monthsBefore(firstOfMonth, 1)
        : iso(dates['previewFrom']);
    const to =
      dates?.['previewTo'] === null || dates?.['previewTo'] === undefined
        ? iso(new Date(Date.parse(`${firstOfMonth}T00:00:00Z`) - 86_400_000))
        : iso(dates['previewTo']);
    const found = await su.model('sale.order').search({
      where: {
        company: program.company as never,
        state: { in: ['sale', 'done'] },
        dateOrder: { gte: from, lte: to },
      } as never,
    });
    const orders = [...(await ordersOf(su, found.ids.map(Number))).values()];
    const result = preview(program.rules, orders, program.pointValue);
    await su
      .model('loyalty.program')
      .browse([id as never])
      .write({
        previewFrom: from,
        previewTo: to,
        previewOrders: result.orders,
        previewEarning: result.earning,
        previewPoints: result.points,
        previewRevenue: money(result.revenue),
        // Points are whole and a point's value is in hundredths: so is the cost.
        previewCost: money(result.cost),
        previewShare: (result.share / 100).toFixed(2),
        previewAt: new Date(),
      } as never);
    await su.flush();
  });
}

// ---- cards and their ledger

/** A card's balance, what it earned lately and its tier, from its ledger. */
export async function refreshCard(su: Env, card: number, program: Loaded): Promise<void> {
  const entries = [...(await su.model('loyalty.entry').search({ where: { card: card as never } }))];
  const since = monthsBefore(iso(su.today()), program.tierMonths);
  const earned = entries
    .filter((e) => (e.kind === 'earn' || e.kind === 'reverse') && iso(e.date) >= since)
    .reduce((sum, e) => sum + e.points, 0);
  await su
    .model('loyalty.card')
    .browse([card as never])
    .write({
      points: entries.reduce((sum, e) => sum + e.points, 0),
      earned: Math.max(0, earned),
      tier: tierOf(program.tiers, Math.max(0, earned))?.id ?? null,
    } as never);
  await su.flush();
}

/** The customer's card in a program: theirs, or a new one when every customer joins; else none. */
async function cardOf(su: Env, program: Loaded, partner: number): Promise<number | null> {
  const [found] = await su.model('loyalty.card').search({
    where: { program: program.id as never, partner: partner as never } as never,
    limit: 1,
  });
  if (found !== undefined) return found.id as number;
  if (!program.autoEnrol) return null;
  const made = await su
    .model('loyalty.card')
    .create([{ program: program.id, partner, company: program.company } as never]);
  return made.ids[0] as number;
}

/**
 * A confirmed order earns (RFC 0034 §2.6): by the company's running program, on the customer's card — theirs, or
 * a new one when every customer joins —, at their tier, **once**: a second call for the same order finds the first
 * line. Returns the points.
 */
export async function earnOrder(env: Env, order: number): Promise<number> {
  return env.asSuperuser({ reason: 'loyalty points earned' }, async (su) => {
    const [o] = await su
      .model('sale.order')
      .browse([order as never])
      .load({ company: true });
    if (o === undefined || (o.state !== 'sale' && o.state !== 'done')) return 0;
    const program = await runningProgram(su, o.company.id as number);
    if (program === null) return 0;
    const read = (await ordersOf(su, [order])).get(order);
    if (read === undefined) return 0;
    const card = await cardOf(su, program, read.partner);
    if (card === null) return 0;
    const before = await su.model('loyalty.entry').search({
      where: { card: card as never, kind: 'earn', resModel: 'sale.order', resId: order } as never,
      limit: 1,
    });
    if (before.length > 0) return 0;
    const [loaded] = await su
      .model('loyalty.card')
      .browse([card as never])
      .load({ tier: true });
    const tier =
      program.tiers.find((t) => t.id === (loaded?.tier?.id as number | undefined)) ?? null;
    const earned = earn(program.rules, read, tier);
    if (earned.points <= 0) return 0;
    await su.model('loyalty.entry').create([
      {
        card,
        company: program.company,
        date: read.date,
        kind: 'earn',
        points: earned.points,
        resModel: 'sale.order',
        resId: order,
        note: `${o.name}${earned.multiplier === 100 ? '' : ` × ${(earned.multiplier / 100).toFixed(2)}`}`,
      } as never,
    ]);
    await su
      .model('sale.order')
      .browse([order as never])
      .write({ loyaltyPoints: earned.points } as never);
    await su.flush();
    await refreshCard(su, card, program);
    return earned.points;
  });
}

/** A cancelled order gives back what it earned, once. Returns the points taken back. */
export async function reverseOrder(env: Env, order: number): Promise<number> {
  return env.asSuperuser({ reason: 'loyalty points taken back' }, async (su) => {
    const all = su.withFlags({ checkCompany: false }) as Env;
    const [earned] = await all
      .model('loyalty.entry')
      .search({ where: { kind: 'earn', resModel: 'sale.order', resId: order } as never, limit: 1 })
      .then((rows) => rows.load({ card: { program: true } }));
    if (earned === undefined) return 0;
    const again = await all.model('loyalty.entry').search({
      where: { kind: 'reverse', resModel: 'sale.order', resId: order } as never,
      limit: 1,
    });
    if (again.length > 0) return 0;
    await su.model('loyalty.entry').create([
      {
        card: earned.card.id,
        company: earned.company.id,
        date: iso(su.today()),
        kind: 'reverse',
        points: -earned.points,
        resModel: 'sale.order',
        resId: order,
        note: 'The order was cancelled.',
      } as never,
    ]);
    await su
      .model('sale.order')
      .browse([order as never])
      .write({ loyaltyPoints: 0 } as never);
    await su.flush();
    const program = await loadProgram(su, earned.card.program.id as number);
    if (program !== null) await refreshCard(su, earned.card.id as number, program);
    return earned.points;
  });
}

// ---- promotions on an order

/** A promotion as the engine reads it. */
function promotionRow(x: {
  id: unknown;
  kind: string;
  value: unknown;
  product: { id: unknown } | null;
  category: { id: unknown } | null;
  minimumOrder: unknown;
  buy: number;
  get: number;
  rewardProduct: { id: unknown } | null;
  code: string | null;
  dateFrom: unknown;
  dateTo: unknown;
  exclusive: boolean | null;
}): Promotion {
  return {
    id: x.id as number,
    kind: x.kind as PromotionKind,
    // A percentage in hundredths of a percent, an amount in hundredths: both are the value times a hundred.
    value: cents(x.value),
    product: (x.product?.id as number | undefined) ?? null,
    category: (x.category?.id as number | undefined) ?? null,
    minimumOrder: cents(x.minimumOrder),
    buy: x.buy,
    get: x.get,
    rewardProduct: (x.rewardProduct?.id as number | undefined) ?? null,
    code: (x.code ?? '').trim().toUpperCase(),
    dateFrom: x.dateFrom === null ? null : iso(x.dateFrom),
    dateTo: x.dateTo === null ? null : iso(x.dateTo),
    exclusive: x.exclusive === true,
  };
}

/** The goods of sales orders, as the promotion engine reads them: the lines Loyalty added are left out. */
async function promoOrdersOf(su: Env, ids: readonly number[]): Promise<Map<number, PromoOrder>> {
  const out = new Map<number, PromoOrder>();
  if (ids.length === 0) return out;
  for (const o of await su
    .model('sale.order')
    .browse([...ids] as never)
    .load({ lines: { product: { category: true } } }))
    out.set(o.id as number, {
      date: iso(o.dateOrder),
      code: (o.promoCode ?? '').trim().toUpperCase(),
      lines: [...o.lines]
        // The goods: not what Loyalty added, nor an app's fees and coupons (products not sold by hand).
        .filter((l) => l.loyaltyKind === null && l.product.saleOk !== false)
        .map((l) => ({
          product: l.product.id as number,
          category: (l.product.category?.id as number | undefined) ?? null,
          quantity: Number(l.quantity),
          amount: cents(l.subtotal),
        })),
    });
  return out;
}

/**
 * What a promotion would have taken off (RFC 0034 §2.6): over the company's confirmed orders of the preview's
 * period — the month before this one unless dates are given —, written on the promotion. No order is touched.
 */
export async function previewPromotionOf(env: Env, id: number): Promise<void> {
  await env.asSuperuser({ reason: 'a promotion previewed' }, async (su) => {
    const [x] = await su
      .model('loyalty.promotion')
      .browse([id as never])
      .load({ company: true, product: true, category: true, rewardProduct: true });
    if (x === undefined) return;
    const today = iso(su.today());
    const firstOfMonth = `${today.slice(0, 7)}-01`;
    const from = x.previewFrom === null ? monthsBefore(firstOfMonth, 1) : iso(x.previewFrom);
    const to =
      x.previewTo === null
        ? iso(new Date(Date.parse(`${firstOfMonth}T00:00:00Z`) - 86_400_000))
        : iso(x.previewTo);
    const found = await su.model('sale.order').search({
      where: {
        company: x.company.id,
        state: { in: ['sale', 'done'] },
        dateOrder: { gte: from, lte: to },
      } as never,
    });
    // Its own dates are left out: the question is what it would cost on orders like those.
    const promotion = { ...promotionRow(x), dateFrom: null, dateTo: null };
    const orders = [...(await promoOrdersOf(su, found.ids.map(Number))).values()];
    const result = previewPromotion(promotion, orders);
    await su
      .model('loyalty.promotion')
      .browse([id as never])
      .write({
        previewFrom: from,
        previewTo: to,
        previewOrders: result.orders,
        previewApplied: result.applied,
        previewDiscount: money(result.discount),
        previewRevenue: money(result.revenue),
        previewShare: (result.share / 100).toFixed(2),
        previewFree: result.freeUnits,
        previewAt: new Date(),
      } as never);
    await su.flush();
  });
}

/**
 * Puts the running promotions on a quotation (RFC 0034 §2.6): the lines of earlier promotions go, and each
 * promotion that applies — together, or the one that goes alone when it gives more — is a line below zero with
 * its name. Points and credit already taken are worked out again on what the order now comes to.
 */
export async function promoteOrder(env: Env, order: number): Promise<void> {
  await env.asSuperuser({ reason: 'promotions on an order' }, async (su) => {
    const [o] = await su
      .model('sale.order')
      .browse([order as never])
      .load({ company: true });
    if (o === undefined) return;
    if (o.state !== 'draft')
      refuseCredit(
        'state',
        'Promotions are applied to a quotation.',
        'Not once it is sent or confirmed.',
      );
    const old = await su.model('sale.order.line').search({
      where: { order: order as never, loyaltyKind: 'promotion' } as never,
    });
    if (old.length > 0) await old.unlink();
    await su.flush();
    const companyId = o.company.id as number;
    const running = await su
      .model('loyalty.promotion')
      .search({
        where: { company: companyId as never, state: 'running' } as never,
        order: ['id asc'],
      })
      .then((rows) => rows.load({ product: true, category: true, rewardProduct: true }));
    const names = new Map([...running].map((x) => [x.id as number, x.name]));
    const read = (await promoOrdersOf(su, [order])).get(order);
    const code = (o.promoCode ?? '').trim().toUpperCase();
    if (code !== '' && ![...running].some((x) => (x.code ?? '').toUpperCase() === code))
      refuseCredit(
        'promoCode',
        'No running promotion has this code.',
        'Check the code, or leave it empty.',
      );
    const discounts =
      read === undefined ? [] : applyPromotions([...running].map(promotionRow), read);
    let taken = 0;
    for (const d of discounts) {
      taken += d.amount;
      await su.model('sale.order.line').create([
        {
          order,
          product: await creditProduct(su, companyId, 'promotion'),
          name: names.get(d.promotion) ?? 'Promotion',
          quantity: '1',
          priceUnit: money(-d.amount),
          loyaltyKind: 'promotion',
          promotion: d.promotion,
        } as never,
      ]);
    }
    await su
      .model('sale.order')
      .browse([order as never])
      .write({ promotionAmount: money(taken) } as never);
    await su.flush();
    // What points and a gift card may pay depends on what the order comes to now.
    if ((o.loyaltyRedeemed ?? 0) > 0 || cents(o.voucherUsed) > 0) await applyCredits(su, order);
  });
}

// ---- spending: points and credit on an order

const refuseCredit = (field: string, message: string, hint: string): never => {
  throw new orm.ValidationError('sale.order', [field], message, hint);
};

/** The product a credit line is charged as: the company's, made the first time. */
async function creditProduct(
  su: Env,
  company: number,
  kind: 'points' | 'voucher' | 'promotion',
): Promise<number> {
  const key =
    kind === 'points'
      ? 'loyaltyPointsProduct'
      : kind === 'voucher'
        ? 'loyaltyVoucherProduct'
        : 'loyaltyPromotionProduct';
  const [c] = await su
    .model('res.company')
    .browse([company as never])
    .load({
      loyaltyPointsProduct: true,
      loyaltyVoucherProduct: true,
      loyaltyPromotionProduct: true,
    });
  const have = c?.[key] ?? null;
  if (have !== null) return have.id as number;
  const made = (
    await su.model('product.product').create([
      {
        name:
          kind === 'points'
            ? 'Loyalty points'
            : kind === 'voucher'
              ? 'Gift card or wallet'
              : 'Promotion',
        kind: 'service',
        saleOk: false,
        purchaseOk: false,
      } as never,
    ])
  ).ids[0] as number;
  await su
    .model('res.company')
    .browse([company as never])
    .write({ [key]: made } as never);
  return made;
}

/**
 * Gives back what an order holds (RFC 0034 §2.6): the points it took from a card and the money it took from
 * wallets and gift cards, as far as nothing gave them back yet — so a second call gives nothing. With
 * `keepLines`, the order's lines stay as they are (a cancelled order is not rewritten).
 */
export async function releaseCredits(
  su: Env,
  order: number,
  options: { readonly keepLines?: boolean } = {},
): Promise<void> {
  if (options.keepLines !== true) {
    const lines = await su.model('sale.order.line').search({
      where: { order: order as never, loyaltyKind: { in: ['points', 'voucher'] } } as never,
    });
    if (lines.length > 0) await lines.unlink();
  }
  const today = iso(su.today());
  const about = { resModel: 'sale.order', resId: order };
  // Points, by card.
  const held = new Map<number, number>();
  for (const e of await su
    .model('loyalty.entry')
    .search({ where: { ...about, kind: { in: ['redeem', 'refund'] } } as never })
    .then((rows) => rows.load(['card'])))
    held.set(e.card.id as number, (held.get(e.card.id as number) ?? 0) + e.points);
  for (const [card, net] of held) {
    if (net >= 0) continue;
    const [c] = await su
      .model('loyalty.card')
      .browse([card as never])
      .load({ program: true, company: true });
    if (c === undefined) continue;
    await su.model('loyalty.entry').create([
      {
        card,
        company: c.company.id,
        date: today,
        kind: 'refund',
        points: -net,
        ...about,
        note: 'Taken off the order.',
      } as never,
    ]);
    await su.flush();
    const program = await loadProgram(su, c.program.id as number);
    if (program !== null) await refreshCard(su, card, program);
  }
  // Money, by wallet or gift card.
  const taken = new Map<number, number>();
  const company = new Map<number, number>();
  for (const e of await su
    .model('loyalty.voucher.entry')
    .search({ where: { ...about, kind: { in: ['spend', 'refund'] } } as never })
    .then((rows) => rows.load(['voucher', 'company']))) {
    taken.set(e.voucher.id as number, (taken.get(e.voucher.id as number) ?? 0) + cents(e.amount));
    company.set(e.voucher.id as number, e.company.id as number);
  }
  for (const [voucher, net] of taken) {
    if (net >= 0) continue;
    await su.model('loyalty.voucher.entry').create([
      {
        voucher,
        company: company.get(voucher),
        date: today,
        kind: 'refund',
        amount: money(-net),
        ...about,
        note: 'Taken off the order.',
      } as never,
    ]);
  }
  await su.flush();
}

/**
 * Takes points and credit off a quotation (RFC 0034 §2.6): whatever it held before is given back first, then the
 * points asked for — no more than the card holds or the program lets points pay — and the gift card or wallet,
 * for what the order still comes to. Each is a line below zero on the order and a line in its ledger: held from
 * now on, and given back if the order is cancelled. Refuses, in words, what cannot be taken.
 */
export async function applyCredits(env: Env, order: number): Promise<void> {
  await env.asSuperuser({ reason: 'points and credit on an order' }, async (su) => {
    const [o] = await su
      .model('sale.order')
      .browse([order as never])
      .load({ partner: true, company: true });
    if (o === undefined) return;
    if (o.state !== 'draft')
      refuseCredit(
        'state',
        'Points and credit are applied to a quotation.',
        'Not once it is sent or confirmed.',
      );
    await releaseCredits(su, order);
    const companyId = o.company.id as number;
    const [fresh] = (
      await su
        .model('sale.order')
        .browse([order as never])
        .load(['amountTotal'])
    ).read(['amountTotal']);
    let due = cents(fresh?.['amountTotal']);
    const today = iso(su.today());
    let spent = 0;
    const asked = o.loyaltyRedeem ?? 0;
    if (asked > 0) {
      const program = await runningProgram(su, companyId);
      if (program === null || !program.redeemable)
        refuseCredit(
          'loyaltyRedeem',
          'Points cannot be spent now.',
          'No running program lets points be spent.',
        );
      const running = program as Loaded;
      const [card] = await su.model('loyalty.card').search({
        where: { program: running.id as never, partner: o.partner.id } as never,
        limit: 1,
      });
      if (card === undefined)
        refuseCredit(
          'loyaltyRedeem',
          'This customer has no loyalty card.',
          'Give them one in Loyalty › Cards.',
        );
      const cardId = (card as { id: unknown }).id as number;
      const balance = [
        ...(await su.model('loyalty.entry').search({ where: { card: cardId as never } })),
      ].reduce((sum, e) => sum + e.points, 0);
      const limit = redeemLimit({
        balance,
        pointValue: running.pointValue,
        orderTotal: due,
        maxPercent: running.redeemMaxPercent,
      });
      if (asked > limit.points)
        refuseCredit(
          'loyaltyRedeem',
          `Only ${limit.points} point(s) can be spent on this order: the card holds ${balance}, and points pay at most ${running.redeemMaxPercent} % of it.`,
          'Type fewer points.',
        );
      if (asked < running.redeemMinPoints)
        refuseCredit(
          'loyaltyRedeem',
          `Points are spent from ${running.redeemMinPoints} at a time.`,
          'Type more points, or none.',
        );
      const amount = asked * running.pointValue;
      await su.model('sale.order.line').create([
        {
          order,
          product: await creditProduct(su, companyId, 'points'),
          name: `${asked} loyalty points`,
          quantity: '1',
          priceUnit: money(-amount),
          loyaltyKind: 'points',
        } as never,
      ]);
      await su.model('loyalty.entry').create([
        {
          card: cardId,
          company: companyId,
          date: today,
          kind: 'redeem',
          points: -asked,
          resModel: 'sale.order',
          resId: order,
          note: o.name,
        } as never,
      ]);
      await su.flush();
      await refreshCard(su, cardId, running);
      due -= amount;
      spent = asked;
    }
    let paid = 0;
    const code = (o.voucherCode ?? '').trim().toUpperCase();
    if (code !== '') {
      const [v] = await su
        .model('loyalty.voucher')
        .search({ where: { code, company: companyId as never } as never, limit: 1 })
        .then((rows) => rows.load({ partner: true }));
      if (v === undefined)
        refuseCredit('voucherCode', 'No gift card or wallet has this code.', 'Check the code.');
      const voucher = v as NonNullable<typeof v>;
      if (voucher.dateExpiry !== null && iso(voucher.dateExpiry) < today)
        refuseCredit(
          'voucherCode',
          `It was valid until ${iso(voucher.dateExpiry)}.`,
          'Use another.',
        );
      if (voucher.kind === 'wallet' && voucher.partner?.id !== o.partner.id)
        refuseCredit(
          'voucherCode',
          'This wallet belongs to another customer.',
          'Use the customer’s own.',
        );
      const balance = cents(voucher.balance);
      if (balance <= 0)
        refuseCredit('voucherCode', 'It holds nothing.', 'Load it, or use another.');
      paid = voucherUse(balance, due);
      if (paid > 0) {
        await su.model('sale.order.line').create([
          {
            order,
            product: await creditProduct(su, companyId, 'voucher'),
            name: `${voucher.kind === 'wallet' ? 'Wallet' : 'Gift card'} ${voucher.code}`,
            quantity: '1',
            priceUnit: money(-paid),
            loyaltyKind: 'voucher',
          } as never,
        ]);
        await su.model('loyalty.voucher.entry').create([
          {
            voucher: voucher.id,
            company: companyId,
            date: today,
            kind: 'spend',
            amount: money(-paid),
            resModel: 'sale.order',
            resId: order,
            note: o.name,
          } as never,
        ]);
      }
    }
    await su
      .model('sale.order')
      .browse([order as never])
      .write({ loyaltyRedeemed: spent, voucherUsed: money(paid) } as never);
    await su.flush();
  });
}

/** A cancelled order gives back the points and the credit it held, once; its lines stay as they were. */
export async function releaseOrder(env: Env, order: number): Promise<void> {
  await env.asSuperuser({ reason: 'points and credit given back' }, async (su) => {
    await releaseCredits(su.withFlags({ checkCompany: false }) as Env, order, { keepLines: true });
    await su
      .model('sale.order')
      .browse([order as never])
      .write({ loyaltyRedeemed: 0, voucherUsed: '0' } as never);
    await su.flush();
  });
}

/**
 * The daily round (RFC 0034 §2.6), for the company of `env`: on every card of a program whose points expire, what
 * grew too old is written off — once: the line itself makes the next answer zero —, and every card's balance,
 * recent earnings and tier are brought up to date. Returns the points written off.
 */
export async function ageCards(env: Env, today: string = iso(env.today())): Promise<number> {
  return env.asSuperuser({ reason: 'loyalty cards aged' }, async (su) => {
    let lost = 0;
    const programs = await su
      .model('loyalty.program')
      .search({ where: { state: { in: ['running', 'ended'] } } as never });
    for (const found of programs) {
      const program = await loadProgram(su, found.id as number);
      if (program === null) continue;
      const cards = await su
        .model('loyalty.card')
        .search({ where: { program: program.id as never } });
      for (const card of cards) {
        if (program.expireMonths !== null) {
          const entries = [
            ...(await su.model('loyalty.entry').search({ where: { card: card.id } as never })),
          ].map((e) => ({ date: iso(e.date), points: e.points }));
          const old = expiredPoints(entries, monthsBefore(today, program.expireMonths));
          if (old > 0) {
            await su.model('loyalty.entry').create([
              {
                card: card.id,
                company: program.company,
                date: today,
                kind: 'expire',
                points: -old,
                note: `Not used in ${program.expireMonths} months.`,
              } as never,
            ]);
            await su.flush();
            lost += old;
          }
        }
        await refreshCard(su, card.id as number, program);
      }
    }
    return lost;
  });
}

export const loyaltyShutro = defineModule({
  name: 'loyalty',
  version: '0.1.0',
  depends: [contactsShutro, productShutro, salesShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: 'loyalty.user',
      label: 'Loyalty user',
      implies: ['sales.user'],
    }),
    orm.defineGroup({
      code: 'loyalty.manager',
      label: 'Loyalty manager',
      implies: ['loyalty.user'],
    }),
  ],
  sequences: [orm.defineSequence({ code: 'loyalty.card', prefix: 'LC', padding: 7 })],
  models: [
    LoyaltyProgram,
    LoyaltyRule,
    LoyaltyTier,
    LoyaltyCard,
    LoyaltyEntry,
    LoyaltyVoucher,
    LoyaltyVoucherEntry,
    LoyaltyPromotion,
  ],
  extensions: [OrderLoyalty, LineLoyalty, CompanyLoyalty],
});
