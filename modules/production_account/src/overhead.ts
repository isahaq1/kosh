/**
 * Overheads and costing (RFC 0031 §3.5). A **costing master** on a product or a category, valid between dates,
 * lists overheads: a fixed amount per order, a percentage of the material cost or an amount per unit produced,
 * each absorbed into an account. When an order produces, its overheads are **applied** (lines kept on the order,
 * part of what the product is valued at, posted into Work in progress against the absorbed-overhead accounts). At
 * **month end** an allocation compares each account's actual overhead (its debits in the month) with what the
 * month's orders absorbed and spreads the difference over those orders by produced quantity or by cost — onto the
 * stock still on hand and the cost of what was sold —, posted once; a posted month is closed.
 */
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  type Env,
  extendModel,
  f,
  records,
} from './.kosh/bindings.js';

const zero = orm.toDecimal(0);
const money = (d: Decimal) => d.toDecimalPlaces(2);
const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;

const METHODS = {
  fixed: 'Fixed amount per order',
  percent: 'Percentage of the material cost',
  unit: 'Per unit produced',
} as const;

function dayOf(v: unknown): string {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

/** The first and last day of the month of a date. */
export function monthOf(day: string): { from: string; to: string } {
  const [y, m] = day.slice(0, 10).split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

export const ProductionCosting = defineModel('production.costing', {
  label: 'Costing master',
  recName: 'name',
  order: ['name asc', 'id asc'],
  companyScoped: { required: true },
  tracking: ['name', 'product', 'category', 'validFrom', 'validTo', 'active'],
  access: { 'production_account.user': READ, 'production.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true }),
    active: f.boolean({ required: true, default: true }),
    product: f.many2one('product.product', {
      ondelete: 'cascade',
      help: 'The product the overheads apply to; a product’s own master comes before its category’s.',
    }),
    category: f.many2one('product.category', {
      ondelete: 'cascade',
      help: 'Every product of the category, when no product is named.',
    }),
    validFrom: f.date({ label: 'Valid from' }),
    validTo: f.date({ label: 'Valid to' }),
    lines: f.one2many('production.costing.line', 'costing', { label: 'Overheads' }),
    note: f.text(),
  },
  constraints: {
    scope: {
      ...check('production.costing', ['product', 'category'], async (rows) =>
        [...(await rows.load({}))]
          .filter((r) => r.product === null && r.category === null)
          .map((r) => r.id),
      ),
      message: 'A costing master applies to a product or to a category.',
    },
  },
});

export const ProductionCostingLine = defineModel('production.costing.line', {
  label: 'Overhead rate',
  order: ['sequence asc', 'id asc'],
  access: { 'production_account.user': READ, 'production.manager': ALL },
  fields: {
    costing: f.many2one('production.costing', { required: true, ondelete: 'cascade' }),
    sequence: f.integer({ required: true, default: 10 }),
    name: f.char({ required: true, label: 'Overhead' }),
    account: f.many2one('account.account', {
      required: true,
      ondelete: 'restrict',
      label: 'Overhead account',
      help: 'Credited with what orders absorb; its own debits are the actual overhead, compared at month end.',
    }),
    method: f.selection(METHODS, {
      required: true,
      default: 'percent',
      help: 'A fixed amount for each order, a percentage of the materials consumed, or an amount per unit produced.',
    }),
    amount: f.decimal({
      scale: 4,
      required: true,
      default: '0',
      label: 'Rate',
      help: 'The amount, the percentage or the amount per unit, by the method.',
    }),
  },
  sqlConstraints: {
    rate: { check: orm.sql`amount >= 0`, message: 'A rate is not negative.' },
  },
});

export const ProductionOrderOverhead = defineModel('production.order.overhead', {
  label: 'Applied overhead',
  order: ['production asc', 'id asc'],
  access: { 'production_account.user': READ, 'production.manager': READ },
  fields: {
    production: f.many2one('production.order', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true, label: 'Overhead' }),
    account: f.many2one('account.account', { required: true, ondelete: 'restrict' }),
    method: f.selection(METHODS, {
      required: true,
      help: 'How the rate was applied: per order, of the material cost, or per unit produced.',
    }),
    rate: f.decimal({ scale: 4, required: true, default: '0' }),
    amount: f.decimal({ scale: 2, required: true, default: '0' }),
    costing: f.many2one('production.costing', { ondelete: 'set null', label: 'Costing master' }),
  },
});

/** The order's overheads: applied when it produces, part of the product's value beside materials and operations. */
export const OrderOverhead = extendModel('production.order', {
  fields: {
    overheads: f.one2many('production.order.overhead', 'production', { label: 'Overheads' }),
    overheadCost: f.decimal({
      scale: 2,
      store: true,
      label: 'Overhead',
      help: 'The overheads applied when the order produced, from its costing master.',
      ...compute('production.order', 'overheadCost', ['overheads.amount'], (orders) => {
        for (const o of orders)
          o.overheadCost = [...o.overheads].reduce((s, l) => s.plus(l.amount), zero);
      }),
    }),
    fullCost: f.decimal({
      scale: 2,
      store: true,
      label: 'Full cost',
      help: 'Materials, operations and overhead together.',
      ...compute('production.order', 'fullCost', ['totalCost', 'overheadCost'], (orders) => {
        for (const o of orders) o.fullCost = (o.totalCost ?? zero).plus(o.overheadCost ?? zero);
      }),
    }),
  },
});

type CostingRow = {
  id: Id<'production.costing'>;
  validFrom: unknown;
  validTo: unknown;
  lines: Iterable<{
    name: string;
    method: keyof typeof METHODS;
    amount: Decimal;
    account: { id: Id<'account.account'> };
  }>;
};

function validOn(c: { validFrom: unknown; validTo: unknown }, day: string): boolean {
  const from = c.validFrom === null ? null : dayOf(c.validFrom);
  const to = c.validTo === null ? null : dayOf(c.validTo);
  return (from === null || from <= day) && (to === null || to >= day);
}

/** The costing master valid on a day for a product: the product's own first, else its category's. */
async function costingFor(
  env: Env,
  product: Id<'product.product'>,
  day: string,
): Promise<CostingRow | null> {
  const own = await (
    await env
      .model('production.costing')
      .search({ where: { active: true, product }, order: ['id desc'] })
  ).load({ lines: { account: true } });
  const mine = [...own].find((c) => validOn(c, day));
  if (mine !== undefined) return mine as unknown as CostingRow;
  const [p] = await env.model('product.product').browse([product]).load({});
  if (p === undefined || p.category === null) return null;
  const byCategory = await (
    await env.model('production.costing').search({
      where: { active: true, category: p.category.id, product: { isNull: true } } as never,
      order: ['id desc'],
    })
  ).load({ lines: { account: true } });
  return (
    ([...byCategory].find((c) => validOn(c, day)) as unknown as CostingRow | undefined) ?? null
  );
}

/**
 * Applies the costing master to an order once, when it produces: a line per overhead with the amount it works out
 * to for what was consumed and produced. Returns the lines (the ones already applied on a second call).
 */
export async function applyOverheads(
  env: Env,
  order: Id<'production.order'>,
  consumedValue: Decimal,
  produced: Decimal,
): Promise<{
  total: Decimal;
  lines: { account: Id<'account.account'>; amount: Decimal; name: string }[];
}> {
  return env.asSuperuser({ reason: 'production overheads' }, async (su) => {
    const [o] = await su.model('production.order').browse([order]).load({ overheads: true });
    if (o === undefined) return { total: zero, lines: [] };
    if (o.overheads.length === 0) {
      const costing = await costingFor(su as never, o.product.id, dayOf(su.today()));
      if (costing !== null) {
        for (const l of costing.lines) {
          const amount =
            l.method === 'fixed'
              ? l.amount
              : l.method === 'percent'
                ? consumedValue.times(l.amount).div(100)
                : produced.times(l.amount);
          if (amount.lte(0)) continue;
          await su.model('production.order.overhead').create([
            {
              production: o.id,
              name: l.name,
              account: l.account.id,
              method: l.method,
              rate: l.amount,
              amount: money(amount),
              costing: costing.id,
            },
          ]);
        }
        await su.flush();
      }
    }
    const [again] = await su
      .model('production.order')
      .browse([order])
      .load({ overheads: { account: true } });
    const lines = [...(again?.overheads ?? [])].map((l) => ({
      account: l.account.id,
      amount: l.amount,
      name: l.name,
    }));
    return { total: lines.reduce((s, l) => s.plus(l.amount), zero), lines };
  });
}

export const ProductionOverheadAllocation = defineModel('production.overhead.allocation', {
  label: 'Overhead allocation',
  recName: 'name',
  order: ['month desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'month', 'distribution'],
  access: { 'production_account.user': READ, 'production.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({
      required: true,
      sequence: { code: 'production.overhead.allocation', dateField: 'month' },
      label: 'Reference',
    }),
    month: f.date({ required: true, help: 'Any day of the month allocated.' }),
    distribution: f.selection(
      { quantity: 'By produced quantity', cost: 'By full cost' },
      {
        required: true,
        default: 'quantity',
        help: 'How the difference is spread over the month’s done orders.',
      },
    ),
    lines: f.one2many('production.overhead.allocation.line', 'allocation', { label: 'Accounts' }),
    shares: f.one2many('production.overhead.allocation.share', 'allocation', {
      label: 'Allocated to',
    }),
    difference: f.decimal({
      scale: 2,
      store: true,
      label: 'Under-absorbed',
      help: 'Actual overhead beyond what the month’s orders absorbed; negative: over-absorbed.',
      ...compute('production.overhead.allocation', 'difference', ['lines.difference'], (rows) => {
        for (const a of rows)
          a.difference = [...a.lines].reduce((s, l) => s.plus(l.difference ?? zero), zero);
      }),
    }),
    move: f.many2one('account.move', { ondelete: 'set null', label: 'Entry' }),
    note: f.text(),
    state: f.state({
      states: { draft: 'Draft', posted: 'Posted', cancel: 'Cancelled' },
      initial: 'draft',
      help: 'Drafted and worked out; posted once, which closes the month.',
      transitions: {
        /** The month's actual against absorbed per account, and the shares of the difference. */
        reckon: {
          from: ['draft'],
          to: 'draft',
          after: records('production.overhead.allocation', async (rows) => {
            const env = rows.env as unknown as Env;
            await env.flush();
            for (const id of rows.ids) await reckonAllocation(env, id);
          }),
        },
        post: {
          from: ['draft'],
          to: 'posted',
          guard: records('production.overhead.allocation', async (rows) => {
            const env = rows.env as unknown as Env;
            const out: Id<'production.overhead.allocation'>[] = [];
            for (const a of await rows.load({ lines: true, shares: true })) {
              const { from, to } = monthOf(dayOf(a.month));
              const closed = await env.model('production.overhead.allocation').search({
                where: {
                  company: a.company.id,
                  state: 'posted',
                  month: { gte: from, lte: to },
                  id: { ne: a.id },
                } as never,
                limit: 1,
              });
              if (
                closed.length > 0 ||
                a.lines.length === 0 ||
                a.shares.length === 0 ||
                (a.difference ?? zero).eq(0)
              )
                out.push(a.id);
            }
            return out;
          }),
          message:
            'Work the month out first, with a difference to allocate and done orders to carry it; a month with a posted allocation is closed.',
          after: records('production.overhead.allocation', async (rows) => {
            const env = rows.env as unknown as Env;
            await env.flush();
            for (const id of rows.ids) await postAllocation(env, id);
            for (const a of await rows.load({}))
              await env.emit('production.overhead.allocation.posted', { id: a.id });
          }),
        },
        cancel: { from: ['draft'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
      extensible: true,
    }),
  },
});

export const ProductionOverheadAllocationLine = defineModel('production.overhead.allocation.line', {
  label: 'Overhead account for the month',
  order: ['allocation asc', 'id asc'],
  access: { 'production_account.user': READ, 'production.manager': READ },
  fields: {
    allocation: f.many2one('production.overhead.allocation', {
      required: true,
      ondelete: 'cascade',
    }),
    account: f.many2one('account.account', { required: true, ondelete: 'restrict' }),
    actual: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      help: 'The account’s debits in the month: the overhead spent.',
    }),
    absorbed: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      help: 'What the month’s done orders absorbed into the account.',
    }),
    difference: f.decimal({
      scale: 2,
      store: true,
      help: 'Actual less absorbed.',
      ...compute(
        'production.overhead.allocation.line',
        'difference',
        ['actual', 'absorbed'],
        (rows) => {
          for (const l of rows) l.difference = l.actual.minus(l.absorbed);
        },
      ),
    }),
  },
});

export const ProductionOverheadAllocationShare = defineModel(
  'production.overhead.allocation.share',
  {
    label: 'Allocated overhead',
    order: ['allocation asc', 'id asc'],
    access: { 'production_account.user': READ, 'production.manager': READ },
    fields: {
      allocation: f.many2one('production.overhead.allocation', {
        required: true,
        ondelete: 'cascade',
      }),
      order: f.many2one('production.order', {
        required: true,
        ondelete: 'restrict',
        label: 'Production order',
      }),
      product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
      quantity: f.decimal({ scale: 4, required: true, default: '0', label: 'Produced' }),
      share: f.decimal({ scale: 4, required: true, default: '0', label: 'Share %' }),
      amount: f.decimal({ scale: 2, required: true, default: '0' }),
    },
  },
);

/** The month's done orders of the company: those that produced in the month. */
async function doneOrders(env: Env, company: Id<'res.company'>, from: string, to: string) {
  return (
    await env.model('production.order').search({
      where: { company, state: 'done', manufacturingDate: { gte: from, lte: to } } as never,
      order: ['id asc'],
    })
  ).load({ overheads: true, product: true });
}

/** Actual against absorbed per overhead account, and the month's done orders' shares of the difference. */
export async function reckonAllocation(
  env: Env,
  id: Id<'production.overhead.allocation'>,
): Promise<void> {
  await env.asSuperuser({ reason: 'overhead allocation' }, async (su) => {
    const [a] = await su
      .model('production.overhead.allocation')
      .browse([id])
      .load({ lines: true, shares: true, company: true });
    if (a === undefined) return;
    if (a.lines.length > 0) await a.lines.unlink();
    if (a.shares.length > 0) await a.shares.unlink();
    const { from, to } = monthOf(dayOf(a.month));
    const orders = [...(await doneOrders(su as never, a.company.id, from, to))];
    // The accounts: every overhead account of the company's costing masters, and those the orders absorbed into.
    const accounts = new Set<number>();
    const absorbed = new Map<number, Decimal>();
    for (const c of await su
      .model('production.costing.line')
      .search({ where: { 'costing.company': a.company.id } as never })
      .then((r) => r.load({})))
      accounts.add(c.account.id as number);
    for (const o of orders)
      for (const l of o.overheads) {
        accounts.add(l.account.id as number);
        absorbed.set(
          l.account.id as number,
          (absorbed.get(l.account.id as number) ?? zero).plus(l.amount),
        );
      }
    for (const account of accounts) {
      const lines = await (
        await su.model('account.move.line').search({
          where: { account, date: { gte: from, lte: to }, 'move.state': 'posted' } as never,
        })
      ).load(['debit']);
      const actual = [...lines].reduce((s, l) => s.plus(l.debit.amount), zero);
      await su.model('production.overhead.allocation.line').create([
        {
          allocation: a.id,
          account: account as never,
          actual: money(actual),
          absorbed: money(absorbed.get(account) ?? zero),
        },
      ] as never);
    }
    await su.flush();
    const [again] = await su
      .model('production.overhead.allocation')
      .browse([id])
      .load({ lines: true });
    const difference = [...(again?.lines ?? [])].reduce(
      (s, l) => s.plus(l.actual.minus(l.absorbed)),
      zero,
    );
    // The shares: by produced quantity or by full cost, the rounding on the last.
    const weights = orders.map((o) =>
      a.distribution === 'cost'
        ? ((o as unknown as { fullCost: Decimal | null }).fullCost ?? o.totalCost ?? zero)
        : (o.producedQty ?? o.quantity),
    );
    const total = weights.reduce((s, w) => s.plus(w), zero);
    let left = money(difference);
    for (const [i, o] of orders.entries()) {
      const w = weights[i] ?? zero;
      const share = total.gt(0) ? w.div(total).times(100).toDecimalPlaces(4) : zero;
      const amount = i === orders.length - 1 ? left : money(difference.times(share).div(100));
      left = left.minus(amount);
      await su.model('production.overhead.allocation.share').create([
        {
          allocation: a.id,
          order: o.id,
          product: o.product.id,
          quantity: o.producedQty ?? o.quantity,
          share,
          amount,
        },
      ] as never);
    }
    await su.flush();
  });
}

/**
 * Posts the allocation once: each account's difference credited (debited when over-absorbed) against the stock
 * valuation account for what is still on hand and the cost of sales for what was sold, per order; the layers and
 * the average costs follow.
 */
export async function postAllocation(
  env: Env,
  id: Id<'production.overhead.allocation'>,
): Promise<void> {
  const { stockAccountsOf } = await import('@kosh/stock_account');
  const [a] = await env
    .model('production.overhead.allocation')
    .browse([id])
    .load({
      lines: true,
      shares: { order: true, product: { category: true } },
      company: { currency: true },
    });
  if (a === undefined) return;
  const accounts = await stockAccountsOf(env as never, a.company.id as never);
  if (accounts === null)
    throw new orm.ValidationError(
      'production.overhead.allocation',
      ['state'],
      'The company has no chart of accounts.',
      'Install a chart of accounts (Accounting › Configuration).',
    );
  const entryLines: { account: number; debit: Decimal; credit: Decimal; name: string }[] = [];
  const updates: { layer: number; product: number; toStock: Decimal }[] = [];
  for (const s of a.shares) {
    if (s.amount.eq(0)) continue;
    const output = s.order.output?.id ?? null;
    const [layer] =
      output === null
        ? []
        : await (
            await env.model('stock.valuation.layer').search({
              where: { picking: output, product: s.product.id, quantity: { gt: '0' } } as never,
              limit: 1,
            })
          ).load(['quantity', 'remainingQty']);
    const onHand =
      layer === undefined || layer.quantity.lte(0) ? zero : layer.remainingQty.div(layer.quantity);
    const toStock = money(s.amount.times(onHand.gt(1) ? orm.toDecimal(1) : onHand));
    const toCogs = s.amount.minus(toStock);
    const category = s.product.category as unknown as {
      stockValuationAccount?: { id: number } | null;
      stockCogsAccount?: { id: number } | null;
    } | null;
    const name = `${a.name} ${s.product.name}`;
    if (!toStock.eq(0)) {
      entryLines.push({
        account: category?.stockValuationAccount?.id ?? (accounts.valuation as number),
        debit: toStock.gt(0) ? toStock : zero,
        credit: toStock.lt(0) ? zero.minus(toStock) : zero,
        name,
      });
      if (layer !== undefined)
        updates.push({ layer: layer.id as number, product: s.product.id as number, toStock });
    }
    if (!toCogs.eq(0))
      entryLines.push({
        account: category?.stockCogsAccount?.id ?? (accounts.cogs as number),
        debit: toCogs.gt(0) ? toCogs : zero,
        credit: toCogs.lt(0) ? zero.minus(toCogs) : zero,
        name: `${name} (sold)`,
      });
  }
  for (const l of a.lines) {
    const d = l.difference ?? zero;
    if (d.eq(0)) continue;
    entryLines.push({
      account: l.account.id as number,
      debit: d.lt(0) ? zero.minus(d) : zero,
      credit: d.gt(0) ? d : zero,
      name: `${a.name} overhead`,
    });
  }
  if (entryLines.length === 0) return;
  const made = await env.model('account.move').create([
    {
      kind: 'entry',
      journal: accounts.journal,
      company: a.company.id,
      currency: a.company.currency?.id,
      date: monthOf(dayOf(a.month)).to,
      ref: a.name,
      lines: {
        create: entryLines.map((l) => ({
          account: l.account,
          name: l.name,
          debit: l.debit.toFixed(2),
          credit: l.credit.toFixed(2),
        })),
      },
    } as never,
  ]);
  await env.withGrants({ grants: ['account.post'], reason: `${a.name} posted` }, (e) =>
    e.model('account.move').browse(made.ids).post(),
  );
  await env.asSuperuser({ reason: `overhead allocation ${String(a.name)} posted` }, async (su) => {
    for (const u of updates) {
      const [layer] = await su
        .model('stock.valuation.layer')
        .browse([u.layer as never])
        .load(['remainingValue', 'value']);
      if (layer !== undefined)
        await layer.write({
          value: layer.value.plus(u.toStock),
          remainingValue: layer.remainingValue.plus(u.toStock),
        });
      const [p] = await su
        .model('product.product')
        .browse([u.product as never])
        .load({ category: true });
      if (p === undefined) continue;
      const fifo = (p.costMethod ?? p.category?.costMethod ?? 'average') === 'fifo';
      if (!fifo && (p.qtyOnHand ?? zero).gt(0))
        await su
          .model('product.product')
          .browse([u.product as never])
          .write({
            standardPrice: money(p.standardPrice.plus(u.toStock.div(p.qtyOnHand ?? zero))),
          });
    }
    await su
      .model('production.overhead.allocation')
      .browse([id])
      .write({ move: made.ids[0] } as never);
    await su.flush();
  });
}
