/**
 * Replenishment (RFC 0024 §2.6): each reorder rule's forecast in its warehouse — on hand in the warehouse's stock
 * location and those inside it, less what confirmed transfers take out, plus what they bring in and what other apps
 * have on order (`pending()`: requests for quotation, production orders) — and, below the minimum, what to order to
 * reach the maximum, rounded up to the rule's step. Every figure is written on the rule with the reckoning in words,
 * so the screen can say why it proposes what it does. Ordering goes through the rules' `procure()`, by method.
 */
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { warehouseStock } from './module.js';

const zero = orm.toDecimal(0);

/** A quantity as people read it: `12`, `2.5`. */
const n = (d: Decimal): string => d.toDecimalPlaces(4).toString();

/** "12 (TR/2026/00004, TR/2026/00009)": the documents, the first three. */
function withDocuments(quantity: Decimal, documents: readonly string[]): string {
  const unique = [...new Set(documents.filter((d) => d !== ''))];
  if (unique.length === 0) return n(quantity);
  const shown = unique.slice(0, 3).join(', ');
  return `${n(quantity)} (${shown}${unique.length > 3 ? ', …' : ''})`;
}

export interface Reckoning {
  readonly onHand: Decimal;
  readonly forecast: Decimal;
  readonly proposed: Decimal;
  readonly explanation: string;
}

/** The forecast and proposal of each rule of `ids` (or every active rule of the user's companies). */
export async function reckon(env: Env, ids?: readonly number[]): Promise<Map<number, Reckoning>> {
  const found = env
    .model('stock.reorder')
    .browse((ids ?? (await env.model('stock.reorder').search({})).ids) as never);
  const rules = await found.load({ product: true });
  const pending = await found.pending();
  const out = new Map<number, Reckoning>();
  const proposals = new Map<number, string>();
  for (const r of rules) {
    const { root, inside } = await warehouseStock(env, r.warehouse.id, r.company.id);
    if (root === null) continue;
    const quants = await (
      await env.model('stock.quant').search({
        where: { product: r.product.id, location: { in: [...inside] as never } },
      })
    ).load(['quantity']);
    const onHand = [...quants].reduce((s, q) => s.plus(q.quantity), zero);
    const moves = await (
      await env.model('stock.move').search({
        where: {
          product: r.product.id,
          'picking.state': 'confirmed',
          or: [
            { 'picking.source': { in: [...inside] } },
            { 'picking.destination': { in: [...inside] } },
          ],
        } as never,
      })
    ).load({ picking: true });
    let outgoing = zero;
    let incoming = zero;
    const outDocs: string[] = [];
    const inDocs: string[] = [];
    for (const m of moves) {
      const from = inside.has(m.picking.source.id);
      const to = inside.has(m.picking.destination.id);
      if (from === to) continue; // inside the warehouse: neither in nor out
      const qty = m.productQty ?? m.quantity;
      if (from) {
        outgoing = outgoing.plus(qty);
        outDocs.push(m.picking.name);
      } else {
        incoming = incoming.plus(qty);
        inDocs.push(m.picking.name);
      }
    }
    const onOrder = pending.get(r.id) ?? [];
    const ordered = onOrder.reduce((s, p) => s.plus(orm.toDecimal(p.quantity)), zero);
    const forecast = onHand.minus(outgoing).plus(incoming).plus(ordered);
    let sum = `On hand ${n(onHand)}`;
    if (outgoing.gt(0)) sum += ` − going out ${withDocuments(outgoing, outDocs)}`;
    if (incoming.gt(0)) sum += ` + coming in ${withDocuments(incoming, inDocs)}`;
    if (ordered.gt(0))
      sum += ` + on order ${withDocuments(
        ordered,
        onOrder.map((p) => p.document),
      )}`;
    let proposed = zero;
    let verdict: string;
    if (r.trigger === 'order')
      verdict =
        r.method === 'dropship'
          ? 'dropshipped: the vendor delivers each order to the customer'
          : 'ordered for each delivery (make to order)';
    else if (forecast.lt(r.minimum)) {
      const need = r.maximum.minus(forecast);
      proposed = need.div(r.multiple).ceil().times(r.multiple);
      verdict = `below the minimum ${n(r.minimum)}: ${n(need)} to reach the maximum ${n(r.maximum)}`;
      if (!proposed.eq(need)) verdict += `, ordered in steps of ${n(r.multiple)}: ${n(proposed)}`;
    } else verdict = `not below the minimum ${n(r.minimum)}: nothing to order`;
    out.set(r.id, {
      onHand,
      forecast,
      proposed,
      explanation: `${sum} = forecast ${n(forecast)}; ${verdict}.`,
    });
    if (proposed.gt(0)) proposals.set(r.id, proposed.toString());
  }
  // Where it would come from (a bridge says: the vendor and why).
  if (proposals.size > 0) {
    const sources = await env
      .model('stock.reorder')
      .browse([...proposals.keys()] as never)
      .sourcing(proposals);
    for (const [id, text] of sources) {
      const r = out.get(id);
      if (r !== undefined && text !== '')
        out.set(id, { ...r, explanation: `${r.explanation} ${text}` });
    }
  }
  return out;
}

/** Writes each rule's figures (those of `ids`, or every rule); returns how many were refreshed. */
export async function refreshRules(env: Env, ids?: readonly number[]): Promise<number> {
  const figures = await reckon(env, ids);
  const now = new Date();
  for (const [id, f] of figures)
    await env
      .model('stock.reorder')
      .browse([id as Id<'stock.reorder'>])
      .write({
        onHand: f.onHand,
        forecast: f.forecast,
        proposed: f.proposed,
        explanation: f.explanation,
        refreshedAt: now,
      } as never);
  await env.flush();
  return figures.size;
}

export interface Ordered {
  readonly ordered: { rule: number; document: string; quantity: string }[];
  readonly skipped: { rule: number; reason: string }[];
}

const NO_APP: Record<string, string> = {
  buy: 'Buying needs Purchase with receipts (purchase_stock) installed.',
  make: 'Making needs Production (mrp) installed.',
  transfer: 'The warehouses have no stock location.',
};

/**
 * Orders the rules of `ids`: `quantities` where given, else what each proposes now. Rules with nothing to order are
 * skipped with the reason; the others are ordered by their method, their last order written, their figures
 * refreshed (what is now on order counts).
 */
export async function orderRules(
  env: Env,
  ids: readonly number[],
  quantities: ReadonlyMap<number, Decimal> = new Map(),
): Promise<Ordered> {
  const figures = await reckon(env, ids);
  const wanted = new Map<number, Decimal>();
  const skipped: { rule: number; reason: string }[] = [];
  for (const id of ids) {
    const qty = quantities.get(id) ?? figures.get(id)?.proposed ?? zero;
    if (qty.gt(0)) wanted.set(id, qty);
    else
      skipped.push({
        rule: id,
        reason: 'Nothing to order: the forecast is not below the minimum.',
      });
  }
  if (wanted.size === 0) return { ordered: [], skipped };
  const rules = env.model('stock.reorder').browse([...wanted.keys()] as never);
  const made = await rules.procure(new Map([...wanted].map(([id, q]) => [id, q.toString()])));
  const ordered: { rule: number; document: string; quantity: string }[] = [];
  for (const r of await rules.load({})) {
    const document = made.get(r.id);
    if (document === undefined) {
      skipped.push({ rule: r.id, reason: NO_APP[r.method] ?? 'No app orders this method.' });
      continue;
    }
    ordered.push({ rule: r.id, document, quantity: n(wanted.get(r.id) ?? zero) });
    await env
      .model('stock.reorder')
      .browse([r.id])
      .write({ lastOrder: document } as never);
  }
  await env.flush();
  await refreshRules(
    env,
    ordered.map((o) => o.rule),
  );
  return { ordered, skipped };
}

/** The rules to order on their own: automatic, not snoozed, with something to order once refreshed. */
export async function orderAutomatic(env: Env): Promise<Ordered> {
  await refreshRules(env);
  const today = env.today();
  const due = await env.model('stock.reorder').search({
    where: {
      auto: true,
      proposed: { gt: 0 },
      or: [{ snoozedUntil: { isNull: true } }, { snoozedUntil: { lt: today } }],
    } as never,
  });
  return due.length === 0 ? { ordered: [], skipped: [] } : orderRules(env, due.ids);
}
