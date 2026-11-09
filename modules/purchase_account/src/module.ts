/**
 * The data layer of the Purchase ↔ Accounting bridge (RFC 0008 §5.1, RFC 0009 §5.8): a confirmed purchase order
 * gets its vendor bill with one transition (`bill`), a draft bill from the order's lines in the company's purchase
 * journal (bills above the policy's threshold then wait for approval, as any bill); the order shows its billing
 * state and its bills, the bill its order.
 *
 * Billing by what was received (RFC 0028 §3.3): each bill line keeps its order line; a line's billed quantity is its
 * bill lines' (refunds less); "Create bill" bills what is due — ordered, or received by Stockroom for products billed
 * on receipt — and each bill line shows the three-way check (ordered, received, billed), flagged when it bills more
 * than was received or ordered.
 */
import { accountingShutro } from '@kosh/accounting';
import { purchaseShutro } from '@kosh/purchase';
import { type Decimal, orm } from '@kosh/server/orm';
import { compute, defineModule, type Env, extendModel, f, records } from './.kosh/bindings.js';

const zero = orm.toDecimal('0');

/** Stockroom's received quantities of order lines, when it is installed (purchase_account does not depend on it). */
async function receivedOf(
  env: Env,
  lineIds: readonly number[],
): Promise<Map<number, Decimal> | null> {
  if (lineIds.length === 0) return new Map();
  try {
    const raw = env.model('purchase.order.line' as never) as unknown as {
      browse(ids: number[]): {
        load(keys: string[]): Promise<{ read(keys: string[]): Record<string, unknown>[] }>;
      };
    };
    const out = new Map<number, Decimal>();
    for (const row of (await raw.browse([...lineIds]).load(['qtyReceived'])).read(['qtyReceived']))
      out.set(row['id'] as number, orm.toDecimal(String(row['qtyReceived'] ?? '0')));
    return out;
  } catch {
    return null; // no Stockroom: what was ordered counts as received
  }
}

/** What each line of `orders` has to bill now: ordered, or received for products billed on receipt, less billed. */
export async function toBill(env: Env, orderIds: readonly number[]): Promise<Map<number, Decimal>> {
  const lines = await (
    await env
      .model('purchase.order.line')
      .search({ where: { order: { in: [...orderIds] } } as never })
  ).load({ product: true });
  const received = await receivedOf(
    env,
    lines.map((l) => l.id as number),
  );
  const out = new Map<number, Decimal>();
  const accepted = await (
    await env
      .model('purchase.order')
      .search({ where: { id: { in: [...orderIds] }, acceptanceCount: { gt: 0 } } as never })
  ).load({});
  const withAcceptance = new Set(accepted.map((o) => o.id as number));
  for (const l of lines) {
    const byReceipt =
      received !== null &&
      l.product?.invoicePolicy === 'delivered' &&
      l.product?.kind !== 'service';
    // A service on an order with work acceptances is billed up to what was accepted (RFC 0032 §3.4).
    const byAcceptance = l.product?.kind === 'service' && withAcceptance.has(l.order.id as number);
    const basis = byAcceptance
      ? (l.qtyAccepted ?? zero)
      : byReceipt
        ? (received.get(l.id as number) ?? zero)
        : l.quantity;
    out.set(l.id as number, basis.minus(l.qtyBilled ?? zero));
  }
  return out;
}

/**
 * What each line of `orders` has to get back from the vendor for what went back (RFC 0030 §3.2): the returned
 * quantity, as far as it is billed beyond what is still received — refunded once, whatever the billing policy.
 */
export async function toRefund(
  env: Env,
  orderIds: readonly number[],
): Promise<Map<number, Decimal>> {
  const out = new Map<number, Decimal>();
  const lines = await (
    await env
      .model('purchase.order.line')
      .search({ where: { order: { in: [...orderIds] } } as never })
  ).load({});
  const ids = lines.map((l) => l.id as number);
  const returned = await optionalLineField(env, 'purchase.order.line', ids, 'qtyReturned');
  const received = await optionalLineField(env, 'purchase.order.line', ids, 'qtyReceived');
  if (returned === null || received === null) return out;
  for (const l of lines) {
    const back = returned.get(l.id as number) ?? zero;
    if (back.lte(0)) continue;
    const over = (l.qtyBilled ?? zero).minus(received.get(l.id as number) ?? zero);
    const refund = back.lt(over) ? back : over;
    if (refund.gt(0)) out.set(l.id as number, refund);
  }
  return out;
}

/** A numeric field of order lines a bridge may add (Stockroom's), by line; null when it is not there. */
async function optionalLineField(
  env: Env,
  model: string,
  ids: readonly number[],
  field: string,
): Promise<Map<number, Decimal> | null> {
  if (ids.length === 0) return new Map();
  try {
    const raw = env.model(model as never) as unknown as {
      browse(ids: number[]): {
        load(keys: string[]): Promise<{ read(keys: string[]): Record<string, unknown>[] }>;
      };
    };
    return new Map(
      (await raw.browse([...ids]).load([field]))
        .read([field])
        .map((r) => [r['id'] as number, orm.toDecimal(String(r[field] ?? '0'))]),
    );
  } catch {
    return null;
  }
}

/** A bill line's order line, and the three-way check (RFC 0028 §3.3). */
export const MoveLinePurchase = extendModel('account.move.line', {
  fields: {
    purchaseLine: f.many2one('purchase.order.line', { ondelete: 'set null', label: 'Order line' }),
    /** Ordered, received and billed on its order line, and what does not match; empty without an order line. */
    matchNote: f.char({
      label: 'Ordered / received / billed',
      help: 'The order line’s ordered, received and billed quantities, flagged when the bills go beyond what was received or ordered.',
      ...compute(
        'account.move.line',
        'matchNote',
        ['purchaseLine.quantity', 'purchaseLine.qtyBilled', 'quantity'],
        async (lines) => {
          const all = [...lines];
          const orderLines = all
            .map((l) => l.purchaseLine?.id as number | undefined)
            .filter((id): id is number => id !== undefined);
          const received =
            orderLines.length === 0 ? null : await receivedOf(all[0]?.env as never, orderLines);
          for (const l of all) {
            const ol = l.purchaseLine;
            if (ol === null || ol === undefined) {
              l.matchNote = '';
              continue;
            }
            const ordered = ol.quantity as Decimal;
            const billed = (ol.qtyBilled as Decimal | null) ?? zero;
            const got = received?.get(ol.id as number) ?? null;
            const parts = [`ordered ${ordered.toString()}`];
            if (got !== null) parts.push(`received ${got.toString()}`);
            parts.push(`billed ${billed.toString()}`);
            const flag = billed.gt(ordered)
              ? ' — more than ordered'
              : got !== null && billed.gt(got)
                ? ' — more than received'
                : '';
            l.matchNote = `${parts.join(', ')}${flag}`;
          }
        },
      ),
    }),
  },
});

/** How much of each order line is billed: its bill lines' quantities (refunds take back). */
export const PurchaseLineBilling = extendModel('purchase.order.line', {
  fields: {
    billLines: f.one2many('account.move.line', 'purchaseLine'),
    qtyBilled: f.decimal({
      scale: 3,
      store: true,
      label: 'Billed',
      help: 'The quantity on this line’s bills, less refunds; cancelled bills do not count.',
      ...compute(
        'purchase.order.line',
        'qtyBilled',
        ['billLines.quantity', 'billLines.move.state', 'billLines.move.kind'],
        (lines) => {
          for (const l of lines)
            l.qtyBilled = [...l.billLines]
              .filter((bl) => bl.move.state !== 'cancel')
              .reduce(
                (sum, bl) =>
                  bl.move.kind === 'in_refund'
                    ? sum.minus(bl.quantity ?? zero)
                    : sum.plus(bl.quantity ?? zero),
                zero,
              );
        },
      ),
    }),
  },
});

export const MovePurchaseOrder = extendModel('account.move', {
  fields: {
    purchaseOrder: f.many2one('purchase.order', { label: 'Purchase order' }),
  },
});

/** The cost centre of each order line, carried onto the bill (RFC 0024 §2.5): budgets commit and spend by it. */
export const PurchaseLineAnalytic = extendModel('purchase.order.line', {
  fields: {
    analytic: f.many2one('account.analytic', {
      ondelete: 'restrict',
      label: 'Cost centre',
      help: 'The department, project or branch the purchase is for; the bill line keeps it.',
    }),
  },
});

export const PurchaseOrderBilling = extendModel('purchase.order', {
  fields: {
    bills: f.one2many('account.move', 'purchaseOrder'),
    billState: f.selection(
      { no: 'Nothing to bill', to_bill: 'To bill', billed: 'Billed' },
      {
        store: true,
        label: 'Billing',
        help: 'To bill while some ordered quantity is not billed yet; billed when all of it is.',
        ...compute(
          'purchase.order',
          'billState',
          ['state', 'lines.quantity', 'lines.qtyBilled'],
          (orders) => {
            for (const o of orders)
              o.billState =
                o.state === 'purchase' || o.state === 'done'
                  ? o.lines.length > 0 &&
                    [...o.lines].every((l) => (l.qtyBilled ?? zero).gte(l.quantity))
                    ? 'billed'
                    : 'to_bill'
                  : 'no';
          },
        ),
      },
    ),
  },
  fieldOverrides: {
    state: {
      transitionsAdd: {
        // A vendor refund for what went back to them (RFC 0030 §3.2), at the line's price.
        refund: {
          from: ['purchase'],
          to: 'purchase',
          guard: records('purchase.order', async (orders) => {
            const due = await toRefund(orders.env as unknown as Env, [...orders.ids] as number[]);
            const loaded = await orders.load({ lines: true });
            return loaded.filter((o) => ![...o.lines].some((l) => due.has(l.id as number)));
          }),
          message: 'Nothing to refund: no return of this order is billed and not refunded yet.',
          after: records('purchase.order', async (orders) => {
            const env = orders.env;
            const due = await toRefund(env as unknown as Env, [...orders.ids] as number[]);
            for (const o of await orders.load({
              lines: { product: true, taxes: true },
              partner: true,
              currency: true,
              company: true,
            })) {
              const wanted = [...o.lines].filter((l) => due.has(l.id as number));
              if (wanted.length === 0) continue;
              const journal = await env.model('account.journal').search({
                where: { company: o.company.id, type: 'purchase' },
                limit: 1,
              });
              const journalId = journal.ids[0];
              if (journalId === undefined)
                throw new orm.ValidationError(
                  'purchase.order',
                  ['state'],
                  'The company has no purchases journal.',
                  'Install a chart of accounts (Accounting › Configuration).',
                );
              await env.model('account.move').create([
                {
                  kind: 'in_refund',
                  journal: journalId,
                  partner: o.partner.id,
                  currency: o.currency.id,
                  company: o.company.id,
                  date: env.today(),
                  invoiceOrigin: o.name,
                  purchaseOrder: o.id,
                  lines: {
                    create: wanted.map((l) => ({
                      lineKind: 'product' as const,
                      product: l.product.id,
                      name: `${String(l.name)} (returned)`,
                      quantity: (due.get(l.id as number) ?? zero).toString(),
                      priceUnit: l.priceUnit,
                      taxes: { set: [...l.taxes].map((t) => t.id) },
                      analytic: l.analytic?.id ?? null,
                      purchaseLine: l.id,
                      debit: '0',
                      credit: '0',
                    })),
                  },
                },
              ]);
            }
          }),
        },
        bill: {
          from: ['purchase'],
          to: 'purchase',
          // Something to bill now: ordered, or received for products billed on receipt, not billed yet.
          guard: records('purchase.order', async (orders) => {
            const due = await toBill(orders.env as unknown as Env, [...orders.ids] as number[]);
            const loaded = await orders.load({ lines: true });
            return loaded.filter(
              (o) => ![...o.lines].some((l) => (due.get(l.id as number) ?? zero).gt(0)),
            );
          }),
          message:
            'Nothing to bill now: this order is billed already, as far as it is ordered or received.',
          after: records('purchase.order', async (orders) => {
            const env = orders.env;
            const due = await toBill(env as unknown as Env, [...orders.ids] as number[]);
            const loaded = await orders.load({
              lines: { product: true, taxes: true },
              partner: true,
              currency: true,
              company: true,
            });
            for (const o of loaded) {
              const journal = await env.model('account.journal').search({
                where: { company: o.company.id, type: 'purchase' },
                limit: 1,
              });
              const journalId = journal.ids[0];
              if (journalId === undefined)
                throw new orm.ValidationError(
                  'purchase.order',
                  ['state'],
                  'The company has no purchases journal.',
                  'Install a chart of accounts (Accounting › Configuration).',
                );
              await env.model('account.move').create([
                {
                  kind: 'in_invoice',
                  journal: journalId,
                  partner: o.partner.id,
                  currency: o.currency.id,
                  company: o.company.id,
                  date: env.today(),
                  invoiceOrigin: o.name,
                  ref: o.partnerReference,
                  purchaseOrder: o.id,
                  lines: {
                    create: [...o.lines]
                      .filter((l) => (due.get(l.id as number) ?? zero).gt(0))
                      .map((l) => ({
                        lineKind: 'product' as const,
                        product: l.product.id,
                        name: l.name,
                        quantity: (due.get(l.id as number) ?? zero).toString(),
                        priceUnit: l.priceUnit,
                        taxes: { set: [...l.taxes].map((t) => t.id) },
                        analytic: l.analytic?.id ?? null,
                        purchaseLine: l.id,
                        debit: '0',
                        credit: '0',
                      })),
                  },
                },
              ]);
            }
          }),
        },
      },
    },
  },
});

export const purchaseAccountShutro = defineModule({
  name: 'purchase_account',
  version: '0.3.0',
  migrations: [
    {
      version: '0.3.0',
      description:
        'Billing by line: existing bill lines linked to their order lines (same order, product and description), so billed orders are not billed again',
      up: async (ctx) => {
        await ctx.sql`UPDATE account_move_line ml SET purchase_line_id = pol.id
          FROM account_move m, purchase_order_line pol
          WHERE ml.move_id = m.id AND m.purchase_order_id = pol.order_id AND ml.product_id = pol.product_id
            AND ml.name = pol.name AND ml.line_kind = 'product' AND ml.purchase_line_id IS NULL`;
        await ctx.sql`UPDATE purchase_order_line pol SET qty_billed = coalesce((
          SELECT sum(CASE WHEN m.kind = 'in_refund' THEN -ml.quantity ELSE ml.quantity END)
          FROM account_move_line ml JOIN account_move m ON m.id = ml.move_id
          WHERE ml.purchase_line_id = pol.id AND m.state <> 'cancel'), 0)`;
      },
    },
  ],
  depends: [purchaseShutro, accountingShutro],
  groups: [
    orm.defineGroup({
      code: 'purchase_account.user',
      label: 'Billing from purchase orders',
      implies: ['purchase.user', 'account.invoicing'],
    }),
  ],
  models: [],
  extensions: [
    MovePurchaseOrder,
    MoveLinePurchase,
    PurchaseLineAnalytic,
    PurchaseLineBilling,
    PurchaseOrderBilling,
  ],
});
