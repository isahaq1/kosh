/**
 * The data layer of the Production ↔ Accounting bridge (RFC 0021, Production step 2): a product made enters stock at
 * what its order consumed (the components' valuation) plus its operations (minutes at the work centres' rates), and
 * the operations are posted into Work in progress against Production labour and overhead — so what goes into Work in
 * progress for an order comes out of it with the product, to the cent.
 */

import { productionShutro } from '@kosh/production';
import { type Decimal, type Id, type Module, type ModuleBase, orm } from '@kosh/server/orm';
import { stockShutro } from '@kosh/stock';
import { stockAccountShutro, stockAccountsOf } from '@kosh/stock_account';
import { defineModule, type Env, extendModel, f, type Records } from './.kosh/bindings.js';
import {
  applyOverheads,
  OrderOverhead,
  ProductionCosting,
  ProductionCostingLine,
  ProductionOrderOverhead,
  ProductionOverheadAllocation,
  ProductionOverheadAllocationLine,
  ProductionOverheadAllocationShare,
} from './overhead.js';

const zero = orm.toDecimal(0);
const money = (d: Decimal) => d.toDecimalPlaces(2);

/** The labour and overhead account: its code in the chart, made when missing. */
export const LABOUR_ACCOUNT = {
  code: '5200',
  name: 'Production labour and overhead',
  type: 'expense_direct_cost',
} as const;

/** The production order an output transfer belongs to, with what its components cost. */
async function madeBy(env: Env, picking: Id<'stock.picking'>) {
  const [order] = await (
    await env.model('production.order').search({ where: { output: picking }, limit: 1 })
  ).load({});
  if (order === undefined) return null;
  const [bill] =
    order.bom === null
      ? []
      : await env.model('production.bom').browse([order.bom.id]).load({ byproducts: true });
  const shares = new Map<number, Decimal>(
    [...(bill?.byproducts ?? [])].map((b) => [b.product.id, b.costShare]),
  );
  let consumed = zero;
  if (order.consumption !== null) {
    const layers = await (
      await env.model('stock.valuation.layer').search({ where: { picking: order.consumption.id } })
    ).load(['value']);
    consumed = [...layers].reduce((s, l) => s.minus(l.value), zero); // out layers are negative
  }
  // The overheads of its costing master, applied once for what it consumed and produced (RFC 0031 §3.5).
  const overhead = await applyOverheads(
    env,
    order.id,
    consumed,
    order.producedQty ?? order.quantity,
  );
  return {
    order,
    consumed,
    operations: order.operationCost ?? zero,
    shares,
    overhead: overhead.total,
    overheadLines: overhead.lines,
  };
}

export const OutputCost = extendModel('stock.move', {
  overrides: {
    // The product made costs what was consumed plus the operations, per unit.
    incomingUnitCost: async function (
      this: unknown,
      next: () => Promise<Map<number, string>>,
    ): Promise<Map<number, string>> {
      const out = await next();
      const moves = this as Records<'stock.move'>;
      const env = moves.env as unknown as Env;
      for (const m of await moves.load({ picking: { source: true }, product: true })) {
        if (m.picking.kind !== 'production' || m.picking.source.usage !== 'production') continue;
        const made = await madeBy(env, m.picking.id);
        if (made === null || m.productQty === null || m.productQty.lte(0)) continue;
        // A by-product carries its share of the cost; the product made, the rest.
        const total = made.consumed.plus(made.operations).plus(made.overhead);
        const others = [...made.shares.values()].reduce((s, x) => s.plus(x), zero);
        const share =
          m.product.id === made.order.product.id
            ? orm.toDecimal(100).minus(others)
            : (made.shares.get(m.product.id) ?? zero);
        const unit = total.times(share).div(100).div(m.productQty);
        out.set(m.id, unit.toDecimalPlaces(4).toString());
      }
      return out;
    },
  },
});

export const OperationsPosted = extendModel('stock.picking', {
  overrides: {
    // Once a product is made, its operations go into Work in progress.
    validated: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const pickings = this as Records<'stock.picking'>;
      const env = pickings.env as unknown as Env;
      for (const p of await pickings.load({ source: true, company: true })) {
        if (p.kind !== 'production' || p.source.usage !== 'production') continue;
        const made = await madeBy(env, p.id);
        if (made === null || (made.operations.lte(0) && made.overhead.lte(0))) continue;
        const accounts = await stockAccountsOf(env as never, p.company.id);
        if (accounts === null) continue;
        const labour =
          (
            await env
              .model('account.account')
              .search({ where: { company: p.company.id, code: LABOUR_ACCOUNT.code }, limit: 1 })
          ).ids[0] ??
          (
            await env
              .model('account.account')
              .create([{ ...LABOUR_ACCOUNT, company: p.company.id }])
          ).ids[0];
        if (labour === undefined) continue;
        const [company] = await env.model('res.company').browse([p.company.id]).load({});
        const amount = money(made.operations);
        const name = `${made.order.name} operations and overhead`;
        // Work in progress takes the operations and the overheads; each comes out of its own account.
        const credits = [
          ...(amount.gt(0) ? [{ account: labour, debit: zero, credit: amount, name }] : []),
          ...made.overheadLines.map((l) => ({
            account: l.account,
            debit: zero,
            credit: money(l.amount),
            name: `${made.order.name} ${l.name}`,
          })),
        ];
        const entry = await env.model('account.move').create([
          {
            kind: 'entry',
            journal: accounts.journal,
            company: p.company.id,
            currency: company?.currency.id,
            date: env.today(),
            ref: name,
            lines: {
              create: [
                {
                  account: accounts.production,
                  debit: money(amount.plus(made.overhead)),
                  credit: zero,
                  name,
                },
                ...credits,
              ],
            },
          },
        ] as never);
        await env.withGrants({ grants: ['account.post'], reason: name }, (e) =>
          e.model('account.move').browse(entry.ids).post(),
        );
      }
    },
  },
});

/** Where a work centre's operation costs are expensed (RFC 0031 §3.2); empty: the company's production account. */
export const WorkcenterExpense = extendModel('production.workcenter', {
  fields: {
    expenseAccount: f.many2one('account.account', {
      ondelete: 'set null',
      label: 'Expense account',
      help: 'The account the centre’s operation costs are expensed to; empty: Production’s default.',
    }),
  },
});

// Named so the module's type stays short enough to emit (TS7056) with every model Products and Production carry.
const DEPENDS: readonly ModuleBase[] = [productionShutro, stockShutro, stockAccountShutro];
const MODELS = [
  ProductionCosting,
  ProductionCostingLine,
  ProductionOrderOverhead,
  ProductionOverheadAllocation,
  ProductionOverheadAllocationLine,
  ProductionOverheadAllocationShare,
] as const;
const EXTENSIONS = [OutputCost, OperationsPosted, WorkcenterExpense, OrderOverhead] as const;

export const productionAccountShutro: Module<
  typeof MODELS,
  readonly ModuleBase[],
  typeof EXTENSIONS
> = defineModule({
  name: 'production_account',
  version: '0.2.0',
  depends: DEPENDS,
  groups: [
    orm.defineGroup({
      code: 'production_account.user',
      label: 'Production valued',
      implies: ['production.user'],
    }),
  ],
  sequences: [
    orm.defineSequence({
      code: 'production.overhead.allocation',
      prefix: 'OVH/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
  ],
  models: MODELS,
  extensions: EXTENSIONS,
});
