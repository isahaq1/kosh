/**
 * The data layer of the Purchase ↔ Stockroom bridge (RFC 0021): a confirmed purchase order gets its receipt — one
 * Stockroom transfer with a line per goods line, in the line's unit, from the vendors into the company's main
 * warehouse, expected on the order's arrival date — made once through the outbox (`purchase.order.confirmed`) and
 * confirmed. The order shows its receipts and what is received; each line, its received quantity. An order may name
 * the warehouse it is delivered to (the main one otherwise). Reorder rules that buy (RFC 0024 §2.6) order on
 * requests for quotation to their vendor — a draft one from replenishment gets the new lines — and count what is
 * on requests and orders not received yet as on order. Dropshipped products leave a delivery as it is confirmed:
 * a dropship transfer from the vendor to the customer, with its request for quotation (no receipt: the vendor
 * delivers).
 */
import { productShutro } from '@kosh/product';
import { purchaseShutro, type VendorChoice, vendorPriceFor } from '@kosh/purchase';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import { defaultLocations, inProductUnit, stockShutro } from '@kosh/stock';
import { compute, defineModule, type Env, extendModel, f, type Records } from './.kosh/bindings.js';
import { vendorScorecard } from './scorecard.js';

const zero = orm.toDecimal(0);

export const PickingPurchase = extendModel('stock.picking', {
  fields: {
    purchaseOrder: f.many2one('purchase.order', { ondelete: 'set null', label: 'Purchase order' }),
  },
  overrides: {
    // Lines of products dropshipped from the warehouse leave the delivery for a dropship and its request.
    routing: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const pickings = this as Records<'stock.picking'>;
      await dropship(pickings.env as unknown as Env, pickings.ids);
    },
    // A backorder stays with its order.
    backorderValues: async function (
      this: unknown,
      next: () => Promise<Map<number, Record<string, unknown>>>,
    ): Promise<Map<number, Record<string, unknown>>> {
      const out = await next();
      for (const p of await (this as Records<'stock.picking'>).load({}))
        out.set(p.id, { ...out.get(p.id), purchaseOrder: p.purchaseOrder?.id ?? null });
      return out;
    },
  },
});

export const MovePurchase = extendModel('stock.move', {
  fields: {
    purchaseLine: f.many2one('purchase.order.line', { ondelete: 'set null', label: 'Order line' }),
  },
  overrides: {
    // The rest of a line stays tied to its order line.
    backorderValues: async function (
      this: unknown,
      next: () => Promise<Map<number, Record<string, unknown>>>,
    ): Promise<Map<number, Record<string, unknown>>> {
      const out = await next();
      for (const m of await (this as Records<'stock.move'>).load({}))
        out.set(m.id, { ...out.get(m.id), purchaseLine: m.purchaseLine?.id ?? null });
      return out;
    },
  },
});

export const LineReceived = extendModel('purchase.order.line', {
  fields: {
    /** What went back to the vendor by validated returns (RFC 0030 §3.2), in the line's unit. */
    qtyReturned: f.decimal({
      scale: 3,
      store: true,
      label: 'Returned',
      help: 'What was sent back to the vendor by validated returns of its receipts.',
      ...compute(
        'purchase.order.line',
        'qtyReturned',
        ['moves.quantity', 'moves.quantityDone', 'moves.picking.state', 'moves.returnOf'],
        (lines) => {
          for (const l of lines)
            l.qtyReturned = [...l.moves]
              .filter((m) => m.picking.state === 'done' && m.returnOf !== null)
              .reduce((s, m) => s.plus(m.quantityDone ?? m.quantity), zero);
        },
      ),
    }),
    moves: f.one2many('stock.move', 'purchaseLine'),
    /** Received by validated receipts, in the line's unit. */
    qtyReceived: f.decimal({
      scale: 3,
      store: true,
      label: 'Received',
      ...compute(
        'purchase.order.line',
        'qtyReceived',
        ['moves.quantity', 'moves.quantityDone', 'moves.picking.state', 'moves.returnOf'],
        (lines) => {
          // What went back to the vendor (a return of a receipt, RFC 0030 §3.2) is not received any more.
          for (const l of lines)
            l.qtyReceived = [...l.moves]
              .filter((m) => m.picking.state === 'done')
              .reduce((s, m) => {
                const qty = m.quantityDone ?? m.quantity;
                return m.returnOf === null ? s.plus(qty) : s.minus(qty);
              }, zero);
        },
      ),
    }),
  },
});

export const OrderReceipts = extendModel('purchase.order', {
  fields: {
    receipts: f.one2many('stock.picking', 'purchaseOrder'),
    /** The vendor's on-time delivery rate (RFC 0030 §3.1), shown beside the expected arrival (RFC 0032 §3.4). */
    vendorOnTime: f.char({
      label: 'On-time delivery',
      help: 'The share of the vendor’s receipts that arrived by their expected date.',
      ...compute('purchase.order', 'vendorOnTime', ['partner'], async (orders) => {
        const env = (orders as unknown as { env: Env }).env;
        for (const o of orders) {
          const card = await vendorScorecard(env, o.partner.id as number);
          o.vendorOnTime =
            card.onTimeRate === null ? '' : `${card.onTimeRate}% on time (${card.onTime} receipts)`;
        }
      }),
    }),
    /** The vendor delivers to the customer: the order's transfer is a dropship, never received in stock. */
    dropship: f.boolean({ default: false, label: 'Dropship' }),
    /** Where the goods are received (the company's main warehouse when empty). */
    warehouse: f.many2one('stock.warehouse', {
      ondelete: 'set null',
      checkCompany: true,
      label: 'Deliver to',
    }),
    receiptState: f.selection(
      {
        nothing: 'Nothing to receive',
        to_receive: 'To receive',
        partial: 'Partly received',
        received: 'Received',
      },
      {
        store: true,
        label: 'Receipt',
        ...compute(
          'purchase.order',
          'receiptState',
          ['state', 'lines.quantity', 'lines.qtyReceived', 'lines.product.kind'],
          (orders) => {
            for (const o of orders) {
              const goods = [...o.lines].filter((l) => l.product.kind === 'goods');
              if (goods.length === 0 || (o.state !== 'purchase' && o.state !== 'done')) {
                o.receiptState = 'nothing';
                continue;
              }
              const done = goods.every((l) => (l.qtyReceived ?? zero).gte(l.quantity));
              const some = goods.some((l) => (l.qtyReceived ?? zero).gt(0));
              o.receiptState = done ? 'received' : some ? 'partial' : 'to_receive';
            }
          },
        ),
      },
    ),
  },
});

/**
 * Makes and confirms the receipt of a confirmed order's goods lines, once (an order with a receipt that is not
 * cancelled gets no other). Runs in an audited superuser scope: the buyer who confirmed needs no Stockroom rights
 * for the warehouse to expect the goods. Returns the receipt, or null when there is nothing to receive.
 */
export async function createReceiptFor(env: Env, orderId: number): Promise<number | null> {
  return env.asSuperuser({ reason: 'receipt for a confirmed purchase order' }, async (su) => {
    const [order] = await su
      .model('purchase.order')
      .browse([orm.asId(orderId, 'purchase.order')])
      .load({
        lines: { product: true, uom: true },
        partner: true,
        company: true,
        receipts: true,
        warehouse: true,
      });
    if (order === undefined || (order.state !== 'purchase' && order.state !== 'done')) return null;
    if ([...order.receipts].some((r) => r.state !== 'cancel')) return null;
    const goods = order.lines.filter((l) => l.product.kind === 'goods');
    if (goods.length === 0) return null;
    const places = await defaultLocations(
      su as never,
      'receipt',
      order.warehouse?.id ?? null,
      order.company.id,
    );
    if (places.source === null || places.destination === null)
      throw new orm.ValidationError(
        'purchase.order',
        ['state'],
        `The company of ${order.name} has no warehouse to receive into.`,
        'Add a warehouse in Stockroom › Configuration › Warehouses.',
      );
    const made = await su.model('stock.picking').create([
      {
        kind: 'receipt',
        partner: order.partner.id,
        company: order.company.id,
        warehouse: places.warehouse,
        source: places.source,
        destination: places.destination,
        origin: order.name,
        purchaseOrder: order.id,
        ...(order.datePlanned === null ? {} : { scheduledDate: order.datePlanned }),
        moves: {
          create: goods.map((l) => ({
            product: l.product.id,
            name: l.name,
            quantity: l.quantity,
            uom: l.uom?.id ?? null,
            purchaseLine: l.id,
          })),
        },
      },
    ]);
    await made.confirm();
    return made.ids[0] ?? null;
  });
}

const OPEN_RFQ = ['draft', 'sent', 'to_approve'];

const isoPlus = (today: string, days: number): string => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Draft deliveries' lines of products with a dropship rule in the warehouse they leave from go to a dropship
 * transfer per vendor — vendors to the delivery's customer, with every link of the delivery and its lines (a sales
 * order's) — and a request for quotation to that vendor, marked as a dropship, linked line by line. A delivery left
 * with no lines becomes the dropship itself.
 */
async function dropship(env: Env, ids: readonly number[]): Promise<void> {
  await env.asSuperuser({ reason: 'dropship' }, async (su) => {
    const [vendors] = (
      await su.model('stock.location').search({ where: { usage: 'vendor' }, limit: 1 })
    ).ids;
    if (vendors === undefined) return;
    const pickings = await su
      .model('stock.picking')
      .browse(ids as never)
      .load({
        source: { warehouse: true },
        company: true,
        moves: { product: { purchaseTaxes: true }, uom: true },
      });
    for (const p of pickings) {
      const wh = p.source.warehouse;
      if (p.kind !== 'delivery' || p.state !== 'draft' || wh === null) continue;
      const moves = [...p.moves];
      const byVendor = new Map<number, { leadDays: number; moves: typeof moves }>();
      for (const m of moves) {
        const [rule] = await (
          await su.model('stock.reorder').search({
            where: { product: m.product.id, warehouse: wh.id, method: 'dropship' },
            limit: 1,
          })
        ).load({ vendor: true });
        if (rule?.vendor === null || rule?.vendor === undefined) continue;
        const v = byVendor.get(rule.vendor.id) ?? { leadDays: rule.leadDays, moves: [] };
        v.moves.push(m);
        byVendor.set(rule.vendor.id, v);
      }
      if (byVendor.size === 0) continue;
      const total = byVendor.size === 1 && [...byVendor.values()][0]?.moves.length === moves.length;
      const pickingValues = (await su.model('stock.picking').browse([p.id]).backorderValues()).get(
        p.id,
      );
      const today = su.today();
      for (const [vendor, v] of byVendor) {
        const made = await su.model('purchase.order').create([
          {
            partner: vendor,
            company: p.company.id,
            currency: p.company.currency.id,
            warehouse: wh.id,
            dropship: true,
            dateOrder: today,
            datePlanned: isoPlus(today, v.leadDays),
            origin: p.origin ?? p.name,
            lines: {
              create: v.moves.map((m) => ({
                product: m.product.id,
                name: m.name ?? m.product.name,
                quantity: m.quantity,
                uom: m.uom?.id ?? m.product.uom?.id ?? null,
                priceUnit: m.product.standardPrice,
                taxes: { set: [...m.product.purchaseTaxes.ids] },
              })),
            },
          },
        ] as never);
        const order = made.ids[0] as number;
        const orderLines = (
          await su.model('purchase.order.line').search({
            where: { order: order as never },
            order: ['id asc'],
          })
        ).ids;
        if (total) {
          await su
            .model('stock.picking')
            .browse([p.id])
            .write({ kind: 'dropship', source: vendors, purchaseOrder: order } as never);
          for (const [i, m] of v.moves.entries())
            await su
              .model('stock.move')
              .browse([m.id])
              .write({ purchaseLine: orderLines[i] ?? null } as never);
          continue;
        }
        const lineValues = await su
          .model('stock.move')
          .browse(v.moves.map((m) => m.id) as never)
          .backorderValues();
        type Raw = { create(rows: readonly Record<string, unknown>[]): Promise<{ ids: number[] }> };
        const split = await (su.model('stock.picking' as never) as unknown as Raw).create([
          {
            ...pickingValues,
            kind: 'dropship',
            source: vendors,
            next: null,
            purchaseOrder: order,
            moves: {
              create: v.moves.map((m, i) => ({
                ...lineValues.get(m.id),
                quantity: m.quantity,
                purchaseLine: orderLines[i] ?? null,
              })),
            },
          },
        ]);
        await su
          .model('stock.move')
          .browse(v.moves.map((m) => m.id) as never)
          .unlink();
        await su
          .model('stock.picking')
          .browse(split.ids as never)
          .confirm();
      }
    }
    await su.flush();
  });
}

/** The warehouse an order is received into: its own, else the company's main one. */
async function receivedInto(
  env: Env,
  warehouse: Id<'stock.warehouse'> | null,
  company: Id<'res.company'>,
): Promise<number | null> {
  return warehouse ?? (await defaultLocations(env as never, 'receipt', null, company)).warehouse;
}

/** The vendor price a buying rule would use for `qty`: in the company's currency, arriving within the rule's days. */
async function chooseVendor(
  env: Env,
  r: { product: { id: unknown }; leadDays: number; company: { currency: { id: unknown } } },
  qty: string,
): Promise<VendorChoice | null> {
  const today = env.today();
  const needBy = new Date(`${today}T00:00:00Z`);
  needBy.setUTCDate(needBy.getUTCDate() + r.leadDays);
  return vendorPriceFor(env as never, {
    product: r.product.id as number,
    quantity: orm.toDecimal(qty),
    date: today,
    currency: r.company.currency.id as number,
    needBy: needBy.toISOString().slice(0, 10),
  });
}

export const ReorderBuy = extendModel('stock.reorder', {
  overrides: {
    // Requests for quotation and orders not received yet (their receipt is still to be made) are on order.
    pending: async function (
      this: unknown,
      next: () => Promise<Map<number, { quantity: string; document: string }[]>>,
    ): Promise<Map<number, { quantity: string; document: string }[]>> {
      const out = await next();
      const rules = this as Records<'stock.reorder'>;
      const env = rules.env as unknown as Env;
      for (const r of await rules.load({ product: true })) {
        const lines = await (
          await env.model('purchase.order.line').search({
            where: {
              product: r.product.id,
              'order.company': r.company.id,
              'order.state': { in: [...OPEN_RFQ, 'purchase', 'done'] },
            } as never,
          })
        ).load({ order: { receipts: true }, uom: true, product: { uom: true } });
        const found = out.get(r.id) ?? [];
        for (const l of lines) {
          if (l.order.dropship) continue;
          if (!OPEN_RFQ.includes(l.order.state) && l.order.receipts.length > 0) continue;
          if (
            (await receivedInto(env, l.order.warehouse?.id ?? null, r.company.id)) !==
            r.warehouse.id
          )
            continue;
          const qty: Decimal = inProductUnit(l.quantity, l.uom as never, l.product.uom as never);
          found.push({ quantity: qty.toString(), document: l.order.name });
        }
        out.set(r.id, found);
      }
      return out;
    },
    // The vendor a buying rule would order from, and why (RFC 0030 §3.1).
    sourcing: async function (
      this: unknown,
      next: (proposed: ReadonlyMap<number, string>) => Promise<Map<number, string>>,
      proposed: ReadonlyMap<number, string>,
    ): Promise<Map<number, string>> {
      const out = await next(proposed);
      const rules = this as Records<'stock.reorder'>;
      const env = rules.env as unknown as Env;
      for (const r of await rules.load({ company: true, vendor: true })) {
        const qty = proposed.get(r.id);
        if (r.method !== 'buy' || qty === undefined) continue;
        const choice = await chooseVendor(env, r, qty);
        out.set(
          r.id,
          choice === null
            ? r.vendor === null
              ? ''
              : `Bought from ${String(r.vendor.name)} (the rule’s vendor: no vendor price fits).`
            : `Bought from ${choice.vendorName}: ${choice.explanation}`,
        );
      }
      return out;
    },
    // Buying: one request for quotation per vendor and warehouse — a draft one from replenishment gets the lines.
    procure: async function (
      this: unknown,
      next: (quantities: ReadonlyMap<number, string>) => Promise<Map<number, string>>,
      quantities: ReadonlyMap<number, string>,
    ): Promise<Map<number, string>> {
      const out = await next(quantities);
      const rules = this as Records<'stock.reorder'>;
      const env = rules.env as unknown as Env;
      const today = env.today();
      for (const r of await rules.load({ product: { purchaseTaxes: true }, company: true })) {
        const qty = quantities.get(r.id);
        if (r.method !== 'buy' || qty === undefined) continue;
        // The vendor prices choose the vendor (the cheapest that arrives in time); else the rule's vendor.
        const choice = await chooseVendor(env, r, qty);
        const vendor = choice?.vendor ?? (r.vendor?.id as number | undefined) ?? null;
        if (vendor === null) continue;
        const arrival = new Date(`${today}T00:00:00Z`);
        arrival.setUTCDate(arrival.getUTCDate() + (choice?.leadDays ?? r.leadDays));
        // The price comes from the vendor's price on the line (or the product's cost).
        const line = {
          product: r.product.id,
          name: r.product.name,
          quantity: qty,
          uom: r.product.uom?.id ?? null,
          taxes: { set: [...r.product.purchaseTaxes.ids] },
        };
        const [open] = await (
          await env.model('purchase.order').search({
            where: {
              partner: vendor,
              company: r.company.id,
              warehouse: r.warehouse.id,
              state: 'draft',
              origin: 'Replenishment',
            } as never,
            order: ['id desc'],
            limit: 1,
          })
        ).load({});
        if (open !== undefined) {
          await env.model('purchase.order.line').create([{ ...line, order: open.id }] as never);
          out.set(r.id, open.name);
          continue;
        }
        const made = await env.model('purchase.order').create([
          {
            partner: vendor,
            company: r.company.id,
            currency: r.company.currency.id,
            warehouse: r.warehouse.id,
            dateOrder: today,
            datePlanned: arrival.toISOString().slice(0, 10),
            origin: 'Replenishment',
            lines: { create: [line] },
          },
        ] as never);
        const [order] = await made.load({});
        out.set(r.id, order?.name ?? '');
      }
      await env.flush();
      return out;
    },
  },
});

export const purchaseStockShutro = defineModule({
  name: 'purchase_stock',
  version: '0.3.0',
  depends: [purchaseShutro, stockShutro, productShutro],
  groups: [
    orm.defineGroup({
      code: 'purchase_stock.user',
      label: 'Purchase with receipts',
      implies: ['purchase.user', 'stock.user'],
    }),
  ],
  models: [],
  extensions: [PickingPurchase, MovePurchase, LineReceived, OrderReceipts, ReorderBuy],
});
