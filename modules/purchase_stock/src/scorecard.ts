/**
 * A vendor's scorecard (RFC 0030 §3.1), from what actually happened over the last year: the confirmed orders, the
 * receipts done and how many by the order's expected date, the average days from order to receipt, and for the
 * products bought most, the last price against the year's average. Read as the caller (Purchase users).
 */
import type { Env } from './.kosh/bindings.js';

type Row = Record<string, unknown>;
const ref = (env: Env, name: string) =>
  env.model(name as never) as unknown as {
    search(q: unknown): Promise<{ load(spec: unknown): Promise<{ read(keys: string[]): Row[] }> }>;
  };
const dayOf = (v: unknown) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10);
const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const idOf = (v: unknown): number | null =>
  typeof v === 'number' ? v : ((v as { id?: number } | null)?.id ?? null);
const decimal = (v: unknown) => Number(String(v ?? '0'));

export interface Scorecard {
  readonly orders: number;
  readonly receipts: number;
  readonly onTime: number;
  /** Percent of receipts done by the expected date, or null without receipts. */
  readonly onTimeRate: number | null;
  readonly averageLeadDays: number | null;
  readonly products: readonly {
    readonly name: string;
    readonly lastPrice: string;
    readonly averagePrice: string;
    /** Percent change of the last price against the average. */
    readonly change: number;
  }[];
}

export async function vendorScorecard(env: Env, vendor: number): Promise<Scorecard> {
  const today = env.today();
  const since = new Date(`${today}T00:00:00Z`);
  since.setUTCFullYear(since.getUTCFullYear() - 1);
  const from = since.toISOString().slice(0, 10);
  const orders = (
    await (
      await ref(env, 'purchase.order').search({
        where: { partner: vendor, state: { in: ['purchase', 'done'] }, dateOrder: { gte: from } },
      })
    ).load(['dateOrder', 'datePlanned'])
  ).read(['id', 'dateOrder', 'datePlanned']);
  const byOrder = new Map(orders.map((o) => [o['id'] as number, o]));
  const receipts =
    orders.length === 0
      ? []
      : (
          await (
            await ref(env, 'stock.picking').search({
              where: { purchaseOrder: { in: [...byOrder.keys()] }, state: 'done' },
            })
          ).load(['doneDate', 'purchaseOrder'])
        ).read(['doneDate', 'purchaseOrder']);
  let onTime = 0;
  let lead = 0;
  let counted = 0;
  for (const r of receipts) {
    const order = byOrder.get(idOf(r['purchaseOrder']) ?? -1);
    if (order === undefined || r['doneDate'] == null) continue;
    const done = dayOf(r['doneDate']);
    const expected = order['datePlanned'] == null ? null : dayOf(order['datePlanned']);
    if (expected === null || done <= expected) onTime++;
    lead += days(dayOf(order['dateOrder']), done);
    counted++;
  }
  const lines =
    orders.length === 0
      ? []
      : (
          await (
            await ref(env, 'purchase.order.line').search({
              where: { order: { in: [...byOrder.keys()] } },
              order: ['id asc'],
            })
          ).load({ product: true })
        ).read(['product', 'priceUnit', 'quantity']);
  const productIds = [...new Set(lines.map((l) => idOf(l['product'])).filter((p) => p !== null))];
  const names = new Map(
    productIds.length === 0
      ? []
      : (
          await (
            await ref(env, 'product.product').search({ where: { id: { in: productIds } } })
          ).load(['name'])
        )
          .read(['id', 'name'])
          .map((p) => [p['id'] as number, String(p['name'] ?? '')]),
  );
  const perProduct = new Map<number, { name: string; prices: number[]; quantity: number }>();
  for (const l of lines) {
    const id = idOf(l['product']);
    if (id === null) continue;
    const entry = perProduct.get(id) ?? { name: names.get(id) ?? '', prices: [], quantity: 0 };
    entry.prices.push(decimal(l['priceUnit']));
    entry.quantity += decimal(l['quantity']);
    perProduct.set(id, entry);
  }
  const products = [...perProduct.values()]
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 5)
    .map((e) => {
      const last = e.prices.at(-1) ?? 0;
      const average = e.prices.reduce((s, x) => s + x, 0) / e.prices.length;
      return {
        name: e.name,
        lastPrice: last.toFixed(2),
        averagePrice: average.toFixed(2),
        change: average === 0 ? 0 : Math.round(((last - average) / average) * 1000) / 10,
      };
    });
  return {
    orders: orders.length,
    receipts: counted,
    onTime,
    onTimeRate: counted === 0 ? null : Math.round((onTime / counted) * 1000) / 10,
    averageLeadDays: counted === 0 ? null : Math.round((lead / counted) * 10) / 10,
    products,
  };
}
