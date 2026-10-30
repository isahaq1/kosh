/**
 * The data layer of the Purchase ↔ Stockroom ↔ Accounting bridge (RFC 0021 step 3, part 2): what is received on a
 * purchase order is valued at the order's price (converted to the product's unit and to the company's currency), a
 * vendor bill's goods are posted to Goods received not billed — where they meet the receipt — and what the bill
 * says differently from the receipt's value goes to Price differences, so the interim account is cleared.
 */
import { accountingShutro } from '@kosh/accounting';
import { purchaseShutro } from '@kosh/purchase';
import { purchaseAccountShutro } from '@kosh/purchase_account';
import { purchaseStockShutro } from '@kosh/purchase_stock';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import { stockShutro } from '@kosh/stock';
import { stockAccountShutro, stockAccountsOf } from '@kosh/stock_account';
import { defineModule, type Env, extendModel, type Records } from './.kosh/bindings.js';

const zero = orm.toDecimal(0);
const money = (d: Decimal) => d.toDecimalPlaces(2);

export const MoveOrderCost = extendModel('stock.move', {
  overrides: {
    // A line received on a purchase order costs the order's price, per product unit, in the company's currency.
    incomingUnitCost: async function (
      this: unknown,
      next: () => Promise<Map<number, string>>,
    ): Promise<Map<number, string>> {
      const out = await next();
      const moves = this as Records<'stock.move'>;
      const loaded = await moves.load({
        purchaseLine: { order: { currency: true, company: { currency: true } } },
      });
      for (const m of loaded) {
        const line = m.purchaseLine;
        if (line === null || m.productQty === null || m.productQty.lte(0)) continue;
        // The order's price is per the line's unit; the move counts the same units.
        let unit = line.priceUnit.times(m.quantity).div(m.productQty);
        const order = line.order;
        if (order.currency.id !== order.company.currency.id) {
          try {
            const rates = await moves.env.fx.prepare({
              date: moves.env.today(),
              currencies: [order.currency.id],
              company: order.company.id,
            });
            unit = unit.div(rates.rate(order.currency.id).rate);
          } catch {
            continue; // no rate for the day: the product's cost (left as it is)
          }
        }
        out.set(m.id, unit.toDecimalPlaces(4).toString());
      }
      return out;
    },
  },
});

const BILLS = new Set(['in_invoice', 'in_refund', 'in_debit']);

export const BillGoods = extendModel('account.move', {
  overrides: {
    // A vendor bill's goods meet their receipts in Goods received not billed.
    productLineAccounts: async function (
      this: unknown,
      next: () => Promise<Map<number, number>>,
    ): Promise<Map<number, number>> {
      const out = await next();
      const bills = this as Records<'account.move'>;
      for (const m of await bills.load({ lines: { product: true } })) {
        if (!BILLS.has(m.kind)) continue;
        const accounts = await stockAccountsOf(bills.env as never, m.company.id);
        if (accounts === null) continue;
        for (const l of m.lines)
          if (l.lineKind === 'product' && l.product?.kind === 'goods' && !out.has(l.id))
            out.set(l.id, accounts.interim);
      }
      return out;
    },
    // What a bill says differently from the value of the goods received on its order: to Price differences.
    posted: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      await postPriceDifferences(this as Records<'account.move'>);
    },
  },
});

/**
 * For each goods line of posted vendor bills from a purchase order: the value received for that product on the
 * order (its receipts' valuation layers), per unit received, times the quantity billed, against what the bill
 * posted. The difference is posted in the Stock journal between Price differences and Goods received not billed.
 */
async function postPriceDifferences(bills: Records<'account.move'>): Promise<void> {
  const env = bills.env as unknown as Env;
  for (const m of await bills.load({ lines: { product: true }, company: true })) {
    if (m.kind !== 'in_invoice' || m.purchaseOrder === null) continue;
    const accounts = await stockAccountsOf(env as never, m.company.id);
    if (accounts === null) continue;
    const lines: {
      account: Id<'account.account'>;
      debit: Decimal;
      credit: Decimal;
      name: string;
    }[] = [];
    for (const l of m.lines) {
      if (l.lineKind !== 'product' || l.product === null || l.product.kind !== 'goods') continue;
      // The receipts of the order for this product: what was received (in the order's units) and its value.
      const receipts = await env
        .model('stock.picking')
        .search({ where: { purchaseOrder: m.purchaseOrder.id, state: 'done' } });
      if (receipts.length === 0) continue;
      const moves = await (
        await env
          .model('stock.move')
          .search({ where: { picking: { in: [...receipts.ids] }, product: l.product.id } })
      ).load(['quantityDone', 'quantity']);
      const received = [...moves].reduce((s, mv) => s.plus(mv.quantityDone ?? mv.quantity), zero);
      if (received.lte(0)) continue;
      const layers = await (
        await env.model('stock.valuation.layer').search({
          where: { picking: { in: [...receipts.ids] }, product: l.product.id },
        })
      ).load(['value']);
      const value = [...layers].reduce((s, x) => s.plus(x.value), zero);
      const quantity = l.quantity ?? zero;
      const expected = money(value.times(quantity).div(received));
      const billed = money((l.debit?.amount ?? zero).minus(l.credit?.amount ?? zero));
      const difference = billed.minus(expected);
      if (difference.isZero()) continue;
      const name = `${m.name} ${l.product.name}: price difference`;
      const amount = difference.abs();
      const [over, under] = difference.gt(0)
        ? [accounts.priceDiff, accounts.interim]
        : [accounts.interim, accounts.priceDiff];
      lines.push({ account: over, debit: amount, credit: zero, name });
      lines.push({ account: under, debit: zero, credit: amount, name });
    }
    if (lines.length === 0) continue;
    const made = await env.model('account.move').create([
      {
        kind: 'entry',
        journal: accounts.journal,
        company: m.company.id,
        currency: m.company.currency.id,
        date: m.date,
        ref: `${m.name} price differences`,
        partner: m.partner?.id ?? null,
        lines: { create: lines },
      },
    ] as never);
    await env.withGrants(
      { grants: ['account.post'], reason: `price differences of ${m.name}` },
      (e) => e.model('account.move').browse(made.ids).post(),
    );
  }
}

export const purchaseStockAccountShutro = defineModule({
  name: 'purchase_stock_account',
  version: '0.1.0',
  depends: [
    purchaseShutro,
    stockShutro,
    accountingShutro,
    purchaseStockShutro,
    stockAccountShutro,
    purchaseAccountShutro,
  ],
  groups: [
    orm.defineGroup({
      code: 'purchase_stock_account.user',
      label: 'Purchases valued in stock',
      implies: ['purchase.user'],
    }),
  ],
  models: [],
  extensions: [MoveOrderCost, BillGoods],
});
