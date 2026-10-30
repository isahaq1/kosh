/**
 * The data layer of the Stockroom ↔ Accounting bridge (RFC 0021 step 3, perpetual valuation): every validated
 * transfer that brings goods into stock or takes them out is valued — at the product's average cost, or FIFO from
 * the receipts still in stock — in a valuation layer, and posted at once in the Stock journal: a receipt to
 * Inventory against Goods received not billed, a delivery to Cost of goods sold, a count's gain or loss to Stock
 * adjustments. Internal moves keep their value. The stock's value at a date is the sum of its layers.
 */
import { accountingShutro } from '@kosh/accounting';
import { productShutro } from '@kosh/product';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import { stockShutro } from '@kosh/stock';
import {
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  method,
  type Records,
} from './.kosh/bindings.js';

const zero = orm.toDecimal(0);
const money = (d: Decimal) => d.toDecimalPlaces(2);

/** The accounts this bridge adds to a chart (by code), when the chart has none with that code. */
export const STOCK_ACCOUNTS = [
  { code: '2150', name: 'Goods received not billed', type: 'liability_current' },
  { code: '5100', name: 'Stock adjustments', type: 'expense_direct_cost' },
  { code: '5110', name: 'Price differences', type: 'expense_direct_cost' },
] as const;
const COMPANY_DEFAULTS = {
  stockValuationAccount: '1200',
  stockInterimAccount: '2150',
  stockCogsAccount: '5000',
  stockAdjustmentAccount: '5100',
  stockPriceDiffAccount: '5110',
} as const;

export const CategoryValuation = extendModel('product.category', {
  fields: {
    costMethod: f.selection(
      { average: 'Average cost', fifo: 'First in, first out (FIFO)' },
      { label: 'Cost method' },
    ),
    stockValuationAccount: f.many2one('account.account', { label: 'Inventory account' }),
    stockCogsAccount: f.many2one('account.account', { label: 'Cost of goods sold account' }),
  },
});

export const ProductValuation = extendModel('product.product', {
  fields: {
    /** Empty: the category's, else average cost. */
    costMethod: f.selection(
      { average: 'Average cost', fifo: 'First in, first out (FIFO)' },
      { label: 'Cost method' },
    ),
    valuationLayers: f.one2many('stock.valuation.layer', 'product'),
  },
});

export const CompanyStockAccounts = extendModel('res.company', {
  fields: {
    stockJournal: f.many2one('account.journal', { label: 'Stock journal' }),
    stockValuationAccount: f.many2one('account.account', { label: 'Inventory account' }),
    stockInterimAccount: f.many2one('account.account', {
      label: 'Goods received not billed account',
    }),
    stockCogsAccount: f.many2one('account.account', { label: 'Cost of goods sold account' }),
    stockAdjustmentAccount: f.many2one('account.account', { label: 'Stock adjustments account' }),
    stockPriceDiffAccount: f.many2one('account.account', { label: 'Price differences account' }),
  },
});

/**
 * What a validated transfer did to a product's value: in (positive) or out (negative), at what unit cost, with its
 * entry; an incoming layer keeps what of it is still in stock (FIFO). Written only by validations.
 */
export const StockValuationLayer = defineModel('stock.valuation.layer', {
  label: 'Stock valuation',
  order: ['id asc'],
  companyScoped: { required: true },
  access: {
    'stock_account.user': ['read', 'export'],
    'stock.manager': ['read', 'export'],
    'account.user': ['read', 'export'],
    'account.manager': ['read', 'export'],
  },
  fields: {
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    picking: f.many2one('stock.picking', { ondelete: 'set null', label: 'Transfer' }),
    move: f.many2one('stock.move', { ondelete: 'set null', label: 'Transfer line' }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    /** In the product's unit: positive in, negative out. */
    quantity: f.decimal({ scale: 4, required: true }),
    unitCost: f.decimal({ scale: 4, required: true, default: '0', label: 'Unit cost' }),
    value: f.decimal({ scale: 2, required: true, default: '0' }),
    remainingQty: f.decimal({ scale: 4, required: true, default: '0', label: 'Still in stock' }),
    remainingValue: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Value still in stock',
    }),
    accountMove: f.many2one('account.move', { ondelete: 'set null', label: 'Entry' }),
  },
});

export const PickingLayers = extendModel('stock.picking', {
  fields: {
    valuationLayers: f.one2many('stock.valuation.layer', 'picking'),
  },
});

/**
 * The accounts and the Stock journal of a company, made when missing: the bridge's accounts are added to the
 * company's chart, the company's defaults point to them. Null when the company has no chart yet.
 */
export async function stockAccountsOf(
  env: Env,
  company: Id<'res.company'>,
): Promise<{
  journal: Id<'account.journal'>;
  valuation: Id<'account.account'>;
  interim: Id<'account.account'>;
  cogs: Id<'account.account'>;
  adjustment: Id<'account.account'>;
  priceDiff: Id<'account.account'>;
} | null> {
  const [c] = await env.model('res.company').browse([company]).load({});
  if (c === undefined) return null;
  const chart = await env.model('account.account').search({ where: { company }, limit: 1 });
  if (chart.length === 0) return null;
  const byCode = async (code: string) =>
    (await env.model('account.account').search({ where: { company, code }, limit: 1 })).ids[0];
  for (const a of STOCK_ACCOUNTS)
    if ((await byCode(a.code)) === undefined)
      await env.model('account.account').create([{ ...a, company }]);
  const changes: Record<string, unknown> = {};
  for (const [field, code] of Object.entries(COMPANY_DEFAULTS))
    if (c[field as keyof typeof c] === null) changes[field] = (await byCode(code)) ?? null;
  if (c.stockJournal === null) {
    const existing = await env
      .model('account.journal')
      .search({ where: { company, code: 'STJ' }, limit: 1 });
    changes['stockJournal'] =
      existing.ids[0] ??
      (
        await env
          .model('account.journal')
          .create([{ name: 'Stock', code: 'STJ', type: 'general', company }])
      ).ids[0];
  }
  if (Object.keys(changes).length > 0)
    await env
      .model('res.company')
      .browse([company])
      .write(changes as never);
  const [after] = await env.model('res.company').browse([company]).load({});
  if (
    after?.stockJournal == null ||
    after.stockValuationAccount == null ||
    after.stockInterimAccount == null ||
    after.stockCogsAccount == null ||
    after.stockAdjustmentAccount == null ||
    after.stockPriceDiffAccount == null
  )
    return null;
  return {
    journal: after.stockJournal.id,
    valuation: after.stockValuationAccount.id,
    interim: after.stockInterimAccount.id,
    cogs: after.stockCogsAccount.id,
    adjustment: after.stockAdjustmentAccount.id,
    priceDiff: after.stockPriceDiffAccount.id,
  };
}

/**
 * Values the validated transfers' goods and posts them (see the module's documentation). Incoming stock is valued
 * at `incomingUnitCost` (the product's cost; a bridge may know better, a purchase order's price); outgoing stock at
 * the average cost or, FIFO, from the oldest incoming layers still in stock.
 */
async function valueTransfers(pickings: Records<'stock.picking'>): Promise<void> {
  const env = pickings.env;
  const loaded = await pickings.load({
    source: true,
    destination: true,
    company: true,
    partner: true,
    moves: { product: { category: true } },
  });
  for (const p of loaded) {
    const incoming = p.source.usage !== 'internal' && p.destination.usage === 'internal';
    const outgoing = p.source.usage === 'internal' && p.destination.usage !== 'internal';
    if (!incoming && !outgoing) continue;
    const accounts = await stockAccountsOf(env, p.company.id);
    if (accounts === null) continue; // no chart yet: nothing to post to
    const costs = incoming
      ? await env
          .model('stock.move')
          .browse([...p.moves].map((m) => m.id))
          .incomingUnitCost()
      : new Map<number, string>();
    const lines: {
      account: Id<'account.account'>;
      debit: Decimal;
      credit: Decimal;
      name: string;
    }[] = [];
    const layers: Record<string, unknown>[] = [];
    for (const m of p.moves) {
      const quantity = m.doneQty ?? zero;
      if (quantity.lte(0)) continue;
      const product = m.product;
      const fifo = (product.costMethod ?? product.category?.costMethod ?? 'average') === 'fifo';
      let value = zero;
      if (incoming) {
        const given = costs.get(m.id);
        const unit = given === undefined ? product.standardPrice : orm.toDecimal(given);
        value = money(quantity.times(unit));
        if (!fifo) {
          // The average weighs what was on hand before this receipt (the quants already hold it).
          const [now] = await env.model('product.product').browse([product.id]).load(['qtyOnHand']);
          const before = (now?.qtyOnHand ?? quantity).minus(quantity);
          const total = before.gt(0) ? before.plus(quantity) : quantity;
          const cost = before.gt(0)
            ? before.times(product.standardPrice).plus(value).div(total)
            : unit;
          await env
            .model('product.product')
            .browse([product.id])
            .write({ standardPrice: money(cost) });
        }
        layers.push({
          company: p.company.id,
          product: product.id,
          picking: p.id,
          move: m.id,
          quantity,
          unitCost: unit,
          value,
          remainingQty: quantity,
          remainingValue: value,
        });
      } else {
        let left = quantity;
        if (fifo) {
          const open = await (
            await env.model('stock.valuation.layer').search({
              where: { company: p.company.id, product: product.id, remainingQty: { gt: '0' } },
              order: ['id asc'],
            })
          ).load(['remainingQty', 'remainingValue']);
          for (const layer of open) {
            if (left.lte(0)) break;
            const take = left.lt(layer.remainingQty) ? left : layer.remainingQty;
            const part = take.eq(layer.remainingQty)
              ? layer.remainingValue
              : money(layer.remainingValue.times(take).div(layer.remainingQty));
            value = value.plus(part);
            left = left.minus(take);
            await layer.write({
              remainingQty: layer.remainingQty.minus(take),
              remainingValue: layer.remainingValue.minus(part),
            });
          }
        }
        // Average cost, or FIFO beyond the layers (stock from before valuation): the product's cost.
        if (left.gt(0)) value = value.plus(money(left.times(product.standardPrice)));
        layers.push({
          company: p.company.id,
          product: product.id,
          picking: p.id,
          move: m.id,
          quantity: quantity.negated(),
          unitCost: quantity.gt(0) ? money(value.div(quantity)) : zero,
          value: value.negated(),
          remainingQty: zero,
          remainingValue: zero,
        });
      }
      if (value.lte(0)) continue;
      const against =
        p.kind === 'adjustment'
          ? accounts.adjustment
          : incoming
            ? accounts.interim
            : (product.category?.stockCogsAccount?.id ?? accounts.cogs);
      const stock = product.category?.stockValuationAccount?.id ?? accounts.valuation;
      const label = `${p.name} ${product.name}`;
      if (incoming) {
        lines.push({ account: stock, debit: value, credit: zero, name: label });
        lines.push({ account: against, debit: zero, credit: value, name: label });
      } else {
        lines.push({ account: against, debit: value, credit: zero, name: label });
        lines.push({ account: stock, debit: zero, credit: value, name: label });
      }
    }
    let entry: Id<'account.move'> | null = null;
    if (lines.length > 0) {
      const [company] = await env.model('res.company').browse([p.company.id]).load({});
      const made = await env.model('account.move').create([
        {
          kind: 'entry',
          journal: accounts.journal,
          company: p.company.id,
          currency: company?.currency.id,
          date: env.today(),
          ref: p.origin ? `${p.name} (${p.origin})` : p.name,
          partner: p.partner?.id ?? null,
          lines: { create: lines },
        },
      ] as never);
      await env.withGrants({ grants: ['account.post'], reason: `stock valuation ${p.name}` }, (e) =>
        e.model('account.move').browse(made.ids).post(),
      );
      entry = made.ids[0] ?? null;
    }
    if (layers.length > 0)
      await env
        .model('stock.valuation.layer')
        .create(layers.map((l) => ({ ...l, accountMove: entry })) as never);
  }
}

export const MoveCost = extendModel('stock.move', {
  methods: {
    /**
     * What each of these lines' stock costs when it comes in, by line, in the product's unit, as a decimal string:
     * the product's cost. A bridge that knows better overrides it (a purchase order's price).
     */
    incomingUnitCost: method('stock.move', async function (): Promise<Map<number, string>> {
      const out = new Map<number, string>();
      for (const m of await this.load({ product: true }))
        out.set(m.id, m.product.standardPrice.toString());
      return out;
    }),
  },
});

export const PickingValued = extendModel('stock.picking', {
  overrides: {
    // A validated transfer's stock is valued and posted.
    validated: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      await valueTransfers(this as Records<'stock.picking'>);
    },
  },
});

export const stockAccountShutro = defineModule({
  name: 'stock_account',
  version: '0.1.0',
  depends: [stockShutro, accountingShutro, productShutro],
  groups: [
    orm.defineGroup({
      code: 'stock_account.user',
      label: 'Stock valuation',
      implies: ['stock.user'],
    }),
  ],
  models: [StockValuationLayer],
  extensions: [
    CategoryValuation,
    ProductValuation,
    CompanyStockAccounts,
    PickingLayers,
    MoveCost,
    PickingValued,
  ],
});
