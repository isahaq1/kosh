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
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { productShutro } from '@kosh/product';
import { salesShutro } from '@kosh/sales';
import { emitting } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import {
  check,
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
  type Tier,
  tierOf,
} from './engine.js';

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
      check: orm.sql`point_value >= 0 AND tier_months > 0 AND (expire_months IS NULL OR expire_months > 0)`,
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

/** The points an order earned, on the order. */
export const OrderLoyalty = extendModel('sale.order', {
  fields: {
    loyaltyPoints: f.integer({
      label: 'Points earned',
      groups: { write: [...SYSTEM] },
      help: 'What the customer’s loyalty card earned with this order, when it was confirmed.',
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
      lines: [...o.lines].map((l) => ({
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
  models: [LoyaltyProgram, LoyaltyRule, LoyaltyTier, LoyaltyCard, LoyaltyEntry],
  extensions: [OrderLoyalty],
});
