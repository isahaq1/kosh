/**
 * The data layer of the Production ↔ Accounting bridge (RFC 0021, Production step 2): a product made enters stock at
 * what its order consumed (the components' valuation) plus its operations (minutes at the work centres' rates), and
 * the operations are posted into Work in progress against Production labour and overhead — so what goes into Work in
 * progress for an order comes out of it with the product, to the cent.
 */

import { mrpShutro } from '@kosh/mrp';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import { stockShutro } from '@kosh/stock';
import { stockAccountShutro, stockAccountsOf } from '@kosh/stock_account';
import { defineModule, type Env, extendModel, type Records } from './.kosh/bindings.js';

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
    await env.model('mrp.production').search({ where: { output: picking }, limit: 1 })
  ).load({});
  if (order === undefined) return null;
  let consumed = zero;
  if (order.consumption !== null) {
    const layers = await (
      await env.model('stock.valuation.layer').search({ where: { picking: order.consumption.id } })
    ).load(['value']);
    consumed = [...layers].reduce((s, l) => s.minus(l.value), zero); // out layers are negative
  }
  return { order, consumed, operations: order.operationCost ?? zero };
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
      for (const m of await moves.load({ picking: { source: true } })) {
        if (m.picking.kind !== 'production' || m.picking.source.usage !== 'production') continue;
        const made = await madeBy(env, m.picking.id);
        if (made === null || m.productQty === null || m.productQty.lte(0)) continue;
        const unit = made.consumed.plus(made.operations).div(m.productQty);
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
        if (made === null || made.operations.lte(0)) continue;
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
        const name = `${made.order.name} operations`;
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
                { account: accounts.production, debit: amount, credit: zero, name },
                { account: labour, debit: zero, credit: amount, name },
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

export const mrpAccountShutro = defineModule({
  name: 'mrp_account',
  version: '0.1.0',
  depends: [mrpShutro, stockShutro, stockAccountShutro],
  groups: [
    orm.defineGroup({
      code: 'mrp_account.user',
      label: 'Production valued',
      implies: ['mrp.user'],
    }),
  ],
  models: [],
  extensions: [OutputCost, OperationsPosted],
});
