/**
 * Landed costs (RFC 0030 §3.3). Freight, customs duty, insurance or LC charges that belong to goods received are
 * added to their value: a landed cost names the receipts and its costs (a landed-cost product, an amount, how it
 * is split — by quantity, weight, volume, value, or equally). The split is previewed line by line before posting;
 * posting adds each receipt line's share to its stock value — to the stock still on hand (and its average cost), to
 * the cost of goods sold for what has already left — in one entry against the costs' expense accounts, once.
 */
import { emitting, HttpProblem } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import { compute, defineModel, type Env, extendModel, f, records } from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;
const zero = orm.toDecimal(0);
const money = (d: Decimal) => d.toDecimalPlaces(2);

const SPLIT = {
  quantity: 'By quantity',
  weight: 'By weight',
  volume: 'By volume',
  value: 'By value',
  equal: 'Equally',
} as const;

/** A service bought as a landed cost, and how its amount is split by default. */
export const ProductLanded = extendModel('product.product', {
  fields: {
    landedCost: f.boolean({
      default: false,
      label: 'Landed cost',
      help: 'A cost of bringing goods in (freight, customs duty, insurance): added to the goods’ value with a landed cost.',
    }),
    landedSplit: f.selection(SPLIT, {
      default: 'value',
      label: 'Split',
      help: 'How its amount is shared between the goods by default.',
    }),
  },
});

export const StockLandedCost = defineModel('stock.landed.cost', {
  label: 'Landed cost',
  recName: 'name',
  order: ['date desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state'],
  access: {
    'stock_account.user': ['read', 'write', 'create'],
    'account.user': ALL,
    'account.manager': ALL,
  },
  fields: {
    name: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'stock.landed.cost', dateField: 'date' },
      label: 'Reference',
    }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    pickings: f.many2many('stock.picking', {
      relation: 'stock_landed_cost_picking_rel',
      label: 'Receipts',
      help: 'The done receipts whose goods carry these costs.',
    }),
    lines: f.one2many('stock.landed.cost.line', 'cost', { label: 'Costs' }),
    vendorBill: f.many2one('account.move', { ondelete: 'set null', label: 'Vendor bill' }),
    move: f.many2one('account.move', { ondelete: 'restrict', label: 'Entry' }),
    amountTotal: f.decimal({
      scale: 2,
      store: true,
      label: 'Total',
      help: 'The sum of its costs, added to the goods’ value when posted.',
      ...compute('stock.landed.cost', 'amountTotal', ['lines.amount'], (costs) => {
        for (const c of costs)
          c.amountTotal = [...c.lines].reduce((s, l) => s.plus(l.amount), zero);
      }),
    }),
    note: f.text(),
    state: f.state({
      states: { draft: 'Draft', posted: 'Posted', cancel: 'Cancelled' },
      initial: 'draft',
      help: 'A draft can be changed and previewed; posted, its costs are in the goods’ value and the books.',
      transitions: {
        post: emitting('stock.landed.cost.posted', {
          from: ['draft'],
          to: 'posted',
          after: records('stock.landed.cost', async (costs): Promise<void> => {
            for (const id of costs.ids)
              await postLandedCost(costs.env as unknown as Env, id as number);
          }),
        }),
        cancel: { from: ['draft'], to: 'cancel' },
      },
    }),
  },
});

export const StockLandedCostLine = defineModel('stock.landed.cost.line', {
  label: 'Landed cost line',
  access: {
    'stock_account.user': ['read', 'write', 'create', 'unlink'],
    'account.user': ['read', 'write', 'create', 'unlink'],
    'account.manager': ['read', 'write', 'create', 'unlink'],
  },
  fields: {
    cost: f.many2one('stock.landed.cost', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', {
      required: true,
      ondelete: 'restrict',
      label: 'Cost',
      help: 'A landed-cost product: freight, customs duty, insurance.',
    }),
    name: f.char({ label: 'Description' }),
    amount: f.decimal({ scale: 2, required: true, default: '0', label: 'Amount' }),
    split: f.selection(SPLIT, {
      required: true,
      default: 'value',
      label: 'Split',
      help: 'How the amount is shared between the receipts’ lines.',
    }),
  },
});

/** One receipt line's share of the costs. */
export interface Share {
  readonly move: number;
  readonly picking: string;
  readonly product: string;
  readonly quantity: string;
  readonly value: string;
  /** The share of each cost line, by cost line. */
  readonly shares: Readonly<Record<number, string>>;
  readonly added: string;
  /** Of what is added, what goes to the stock still on hand and what to the cost of goods sold. */
  readonly toStock: string;
  readonly toCogs: string;
}

type Loaded = Awaited<ReturnType<typeof loadCost>>;

async function loadCost(env: Env, id: number) {
  const [cost] = await env
    .model('stock.landed.cost')
    .browse([id as never])
    .load({
      lines: { product: true },
      pickings: { moves: { product: { category: true } } },
      company: true,
    });
  if (cost === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', 'No such landed cost.');
  return cost;
}

/** Splits each cost line between the receipts' lines, rounding so the shares add up to the line. */
async function split(env: Env, cost: Loaded): Promise<Share[]> {
  const moves = [...cost.pickings].flatMap((p) =>
    [...p.moves].map((m) => ({ m, picking: String(p.name), state: p.state, kind: p.kind })),
  );
  if (moves.length === 0)
    throw new HttpProblem(
      409,
      'no-receipts',
      'No receipts',
      'Choose the receipts these costs belong to.',
    );
  const bad = moves.find((x) => x.state !== 'done' || x.kind !== 'receipt');
  if (bad !== undefined)
    throw new HttpProblem(
      409,
      'not-received',
      'Not received',
      `${bad.picking} is not a done receipt.`,
    );
  // Each line's value: its incoming layer's.
  const layers = await (
    await env
      .model('stock.valuation.layer')
      .search({ where: { move: { in: moves.map((x) => x.m.id) }, quantity: { gt: '0' } } as never })
  ).load({ move: true });
  const layerOf = new Map(layers.map((l) => [l.move?.id as number, l]));
  const basis = (method: string, x: (typeof moves)[number]): Decimal => {
    const qty = x.m.doneQty ?? zero;
    if (method === 'quantity') return qty;
    if (method === 'weight') return qty.times(x.m.product.weight ?? zero);
    if (method === 'volume') return qty.times(x.m.product.volume ?? zero);
    if (method === 'value') return layerOf.get(x.m.id)?.value ?? zero;
    return orm.toDecimal(1);
  };
  const shares = new Map<number, Map<number, Decimal>>();
  for (const line of cost.lines) {
    const weights = moves.map((x) => basis(line.split, x));
    const total = weights.reduce((s, w) => s.plus(w), zero);
    if (total.lte(0))
      throw new HttpProblem(
        409,
        'no-basis',
        'Nothing to split by',
        `${String(line.product.name)}: the receipts' lines have no ${line.split} to split by.`,
      );
    let left = line.amount;
    moves.forEach((x, i) => {
      const part =
        i === moves.length - 1 ? left : money(line.amount.times(weights[i] as Decimal).div(total));
      left = left.minus(part);
      const byLine = shares.get(x.m.id) ?? new Map<number, Decimal>();
      byLine.set(line.id as number, part);
      shares.set(x.m.id, byLine);
    });
  }
  return moves.map((x) => {
    const byLine = shares.get(x.m.id) ?? new Map<number, Decimal>();
    const added = [...byLine.values()].reduce((s, v) => s.plus(v), zero);
    const layer = layerOf.get(x.m.id);
    const qty = layer?.quantity ?? x.m.doneQty ?? zero;
    // What is still on hand: FIFO layers say so; average cost knows only the product's stock (at most this line).
    const fifo =
      (x.m.product.costMethod ?? x.m.product.category?.costMethod ?? 'average') === 'fifo';
    const onHand = x.m.product.qtyOnHand ?? zero;
    const remaining = fifo ? (layer?.remainingQty ?? qty) : onHand.lt(qty) ? onHand : qty;
    const toStock = qty.gt(0) ? money(added.times(remaining).div(qty)) : zero;
    return {
      move: x.m.id as number,
      picking: x.picking,
      product: String(x.m.product.name),
      quantity: (x.m.doneQty ?? zero).toString(),
      value: (layer?.value ?? zero).toFixed(2),
      shares: Object.fromEntries([...byLine].map(([k, v]) => [k, v.toFixed(2)])),
      added: added.toFixed(2),
      toStock: toStock.toFixed(2),
      toCogs: added.minus(toStock).toFixed(2),
    };
  });
}

/** The split of a landed cost, line by line, before it is posted. */
export async function previewLandedCost(env: Env, id: number): Promise<Share[]> {
  return split(env, await loadCost(env, id));
}

/** Posts a landed cost: each receipt line's share to its stock value (and average cost) or the cost of goods sold. */
async function postLandedCost(env: Env, id: number): Promise<void> {
  const cost = await loadCost(env, id);
  if ([...cost.lines].length === 0)
    throw new orm.ValidationError(
      'stock.landed.cost',
      ['lines'],
      'A landed cost needs its costs.',
      'Add the freight, duty or other charges.',
    );
  const shares = await split(env, cost);
  // Imported here: module.ts registers this file's models (a static import would be a cycle).
  const { stockAccountsOf } = await import('./module.js');
  const accounts = await stockAccountsOf(env as never, cost.company.id as never);
  if (accounts === null)
    throw new orm.ValidationError(
      'stock.landed.cost',
      ['state'],
      'The company has no chart of accounts.',
      'Install a chart of accounts (Accounting › Configuration).',
    );
  const lines: { account: number; debit: Decimal; credit: Decimal; name: string }[] = [];
  const updates: { move: number; product: number; toStock: Decimal }[] = [];
  for (const s of shares) {
    const toStock = orm.toDecimal(s.toStock);
    const toCogs = orm.toDecimal(s.toCogs);
    const [m] = await env
      .model('stock.move')
      .browse([s.move as never])
      .load({ product: { category: true } });
    if (m === undefined) continue;
    const product = m.product;
    if (toStock.gt(0)) {
      lines.push({
        account:
          (product.category?.stockValuationAccount?.id as number | undefined) ??
          (accounts.valuation as number),
        debit: toStock,
        credit: zero,
        name: `${cost.name} ${product.name}`,
      });
      // The stock still on hand carries it: its layer's value, and the average cost (applied once posted).
      updates.push({ move: s.move, product: product.id as number, toStock });
    }
    if (toCogs.gt(0))
      lines.push({
        account:
          (product.category?.stockCogsAccount?.id as number | undefined) ??
          (accounts.cogs as number),
        debit: toCogs,
        credit: zero,
        name: `${cost.name} ${product.name} (sold)`,
      });
  }
  // Against each cost's expense account (where its bill put it), else the stock interim account.
  for (const line of cost.lines) {
    const [p] = await env
      .model('product.product')
      .browse([line.product.id])
      .load({ category: true });
    const own = (p as unknown as { expenseAccount?: { id: number } | null })?.expenseAccount?.id;
    const category = (p?.category as unknown as { expenseAccount?: { id: number } | null } | null)
      ?.expenseAccount?.id;
    lines.push({
      account: own ?? category ?? (accounts.interim as number),
      debit: zero,
      credit: line.amount,
      name: `${cost.name} ${line.name ?? line.product.name}`,
    });
  }
  const made = await env.model('account.move').create([
    {
      kind: 'entry',
      journal: accounts.journal,
      company: cost.company.id,
      currency: cost.company.currency?.id,
      date: cost.date,
      ref: cost.name,
      lines: {
        create: lines.map((l) => ({
          account: l.account,
          name: l.name,
          debit: l.debit.toFixed(2),
          credit: l.credit.toFixed(2),
        })),
      },
    } as never,
  ]);
  await made.post();
  // The entry is the user's (their Accounting rights decide); the layers and costs follow it as the system.
  await env.asSuperuser({ reason: `landed cost ${String(cost.name)} posted` }, async (su) => {
    for (const u of updates) {
      const [layer] = await (
        await su
          .model('stock.valuation.layer')
          .search({ where: { move: u.move, quantity: { gt: '0' } } as never, limit: 1 })
      ).load(['remainingValue', 'value']);
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
  });
  await env
    .model('stock.landed.cost')
    .browse([id as never])
    .write({ move: made.ids[0] } as never);
}

/** A draft landed cost from a vendor bill's landed-cost lines (the receipts chosen afterwards). */
export async function landedCostFromBill(env: Env, billId: number): Promise<{ id: number }> {
  const [bill] = await env
    .model('account.move')
    .browse([billId as never])
    .load({ lines: { product: true }, company: true });
  if (bill === undefined || bill.kind !== 'in_invoice')
    throw new HttpProblem(404, 'missing-record', 'Not found', 'No such vendor bill.');
  const costs = [...bill.lines].filter(
    (l) =>
      l.lineKind === 'product' &&
      (l.product as unknown as { landedCost?: boolean } | null)?.landedCost === true,
  );
  if (costs.length === 0)
    throw new HttpProblem(
      409,
      'no-landed-costs',
      'No landed costs',
      'This bill has no line of a landed-cost product (freight, duty, insurance).',
    );
  const made = await env.model('stock.landed.cost').create([
    {
      company: bill.company.id,
      vendorBill: bill.id,
      date: bill.date,
      lines: {
        create: costs.map((l) => ({
          product: l.product?.id,
          name: l.name,
          amount: (l.subtotal?.amount ?? zero).toFixed(2),
          split: (l.product as unknown as { landedSplit?: string } | null)?.landedSplit ?? 'value',
        })),
      },
    } as never,
  ]);
  return { id: made.ids[0] as number };
}
