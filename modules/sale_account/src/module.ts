/**
 * The data layer of the Sales ↔ Accounting bridge (RFC 0008 §5.1, RFC 0009 §5.8): a confirmed sales order is
 * invoiced with one transition (`invoice`), which creates a draft customer invoice from the order's lines
 * (product, description, quantity, price, discount, taxes) in the company's sales journal; the order shows its
 * invoicing state and its invoices, the invoice its order.
 *
 * Credit control (RFC 0028 §3.2): a customer's credit limit (else the company's default) against what they owe —
 * unpaid posted invoices, confirmed orders not invoiced yet and the order being confirmed —, by the company's mode:
 * off, warn (shown on the order), block (refused), or approval (the order asks for a credit approval, decided by
 * Accounting managers through the Approvals engine, and is confirmed when approved). Payment terms on the order (else
 * the customer's) and its invoice address go to the invoice.
 */
import { accountingShutro } from '@kosh/accounting';
import { approvalGuard, permissionsShutro, requestApprovals } from '@kosh/permissions';
import { salesShutro } from '@kosh/sales';
import { type Decimal, orm } from '@kosh/server/orm';
import { compute, defineModule, type Env, extendModel, f, records } from './.kosh/bindings.js';

/** The company's credit settings (RFC 0028 §3.2). */
export const CompanyCredit = extendModel('res.company', {
  fields: {
    creditControl: f.selection(
      {
        off: 'Off',
        warn: 'Warn on the order',
        block: 'Refuse the confirmation',
        approval: 'Ask for an approval',
      },
      {
        default: 'off',
        label: 'Credit control',
        help: 'What happens when confirming an order takes a customer over their credit limit.',
      },
    ),
    creditLimitDefault: f.decimal({
      scale: 2,
      label: 'Default credit limit',
      help: 'For customers without a limit of their own; empty: no limit.',
    }),
  },
});

/** A customer's credit limit and payment terms (RFC 0028 §3.2). */
export const PartnerCredit = extendModel('res.partner', {
  fields: {
    creditLimit: f.decimal({
      scale: 2,
      label: 'Credit limit',
      help: 'What this customer may owe at most (unpaid invoices and orders not invoiced); empty: the company’s default.',
    }),
    customerPaymentTerm: f.many2one('account.payment.term', {
      ondelete: 'set null',
      label: 'Customer payment terms',
      help: 'The payment terms of this customer’s orders and invoices, unless an order says otherwise.',
    }),
  },
});

const zero = orm.toDecimal('0');
const amountOf = (v: unknown): Decimal =>
  v === null || v === undefined
    ? zero
    : typeof v === 'object' && v !== null && 'amount' in v
      ? orm.toDecimal(String((v as { amount: unknown }).amount))
      : orm.toDecimal(String(v));

/**
 * What a customer owes in a company — unpaid posted invoices (less credit notes) and confirmed orders not invoiced
 * yet, `order` left out — and their limit (null: none), read as the system.
 */
export async function creditOf(
  env: Env,
  partner: number,
  company: number,
  order: number | null,
): Promise<{ owed: Decimal; limit: Decimal | null }> {
  return env.asSuperuser({ reason: 'credit control' }, async (su) => {
    let owed = zero;
    for (const m of await (
      await su.model('account.move').search({
        where: {
          partner: partner as never,
          company: company as never,
          state: 'posted',
          kind: { in: ['out_invoice', 'out_debit', 'out_refund'] },
        } as never,
      })
    ).load([]))
      owed =
        m.kind === 'out_refund'
          ? owed.minus(amountOf(m.amountResidual))
          : owed.plus(amountOf(m.amountResidual));
    for (const o of await (
      await su.model('sale.order').search({
        where: {
          partner: partner as never,
          company: company as never,
          state: { in: ['sale', 'done'] },
          invoiceState: 'to_invoice',
          ...(order === null ? {} : { id: { ne: order as never } }),
        } as never,
      })
    ).load([]))
      owed = owed.plus(amountOf(o.amountTotal));
    const [p] = await su
      .model('res.partner')
      .browse([partner as never])
      .load([]);
    const [c] = await su
      .model('res.company')
      .browse([company as never])
      .load([]);
    const limit =
      (p?.creditLimit as Decimal | null | undefined) ??
      (c?.creditLimitDefault as Decimal | null | undefined) ??
      null;
    return { owed, limit };
  });
}

export const MoveSaleOrder = extendModel('account.move', {
  fields: {
    saleOrder: f.many2one('sale.order', { label: 'Sales order' }),
  },
});

/** An invoice line's order line, and down payments (RFC 0028 §3.3). */
export const MoveLineSale = extendModel('account.move.line', {
  fields: {
    saleLine: f.many2one('sale.order.line', { ondelete: 'set null', label: 'Order line' }),
    /** A down payment of this order (positive), or its deduction (negative). */
    downPaymentOf: f.many2one('sale.order', { ondelete: 'set null', label: 'Down payment of' }),
  },
});

/** How much of each order line is invoiced: its invoice lines' quantities (credit notes take back). */
export const SaleLineInvoicing = extendModel('sale.order.line', {
  fields: {
    invoiceLines: f.one2many('account.move.line', 'saleLine'),
    qtyInvoiced: f.decimal({
      scale: 3,
      store: true,
      label: 'Invoiced',
      help: 'The quantity on this line’s invoices, less credit notes; cancelled invoices do not count.',
      ...compute(
        'sale.order.line',
        'qtyInvoiced',
        ['invoiceLines.quantity', 'invoiceLines.move.state', 'invoiceLines.move.kind'],
        (lines) => {
          for (const l of lines)
            l.qtyInvoiced = [...l.invoiceLines]
              .filter((il) => il.move.state !== 'cancel')
              .reduce(
                (sum, il) =>
                  il.move.kind === 'out_refund'
                    ? sum.minus(il.quantity ?? zero)
                    : sum.plus(il.quantity ?? zero),
                zero,
              );
        },
      ),
    }),
  },
});

/** The company's down payment product (made on first use): its income account books down payments. */
export const CompanyDownPayment = extendModel('res.company', {
  fields: {
    downPaymentProduct: f.many2one('product.product', {
      ondelete: 'restrict',
      label: 'Down payment product',
      help: 'The service down payments are invoiced as; made on the first down payment.',
    }),
  },
});

/**
 * What each line of `orders` has to invoice now (RFC 0028 §3.3): the ordered quantity, or the delivered one for
 * products invoiced on delivery (Stockroom's, when installed; services count as delivered), less what is invoiced.
 */
export async function toInvoice(
  env: Env,
  orderIds: readonly number[],
): Promise<Map<number, Decimal>> {
  const out = new Map<number, Decimal>();
  const lines = await (
    await env.model('sale.order.line').search({ where: { order: { in: [...orderIds] } } as never })
  ).load({ product: true });
  // Stockroom's delivered quantities, when it is installed.
  const delivered = new Map<number, Decimal>();
  try {
    const raw = env.model('sale.order.line' as never) as unknown as {
      browse(ids: number[]): {
        load(keys: string[]): Promise<{ read(keys: string[]): Record<string, unknown>[] }>;
      };
    };
    const ids = lines.map((l) => l.id as number);
    if (ids.length > 0)
      for (const row of (await raw.browse(ids).load(['qtyDelivered'])).read(['qtyDelivered']))
        delivered.set(row['id'] as number, orm.toDecimal(String(row['qtyDelivered'] ?? '0')));
  } catch {
    // no Stockroom: what was ordered counts as delivered
  }
  for (const l of lines) {
    const byDelivery =
      l.product?.invoicePolicy === 'delivered' &&
      l.product?.kind !== 'service' &&
      delivered.size > 0;
    const basis = byDelivery ? (delivered.get(l.id as number) ?? zero) : l.quantity;
    out.set(l.id as number, basis.minus(l.qtyInvoiced ?? zero));
  }
  return out;
}

/** The down payments of an order not deducted yet (invoiced, less the deductions), as the system. */
async function downPaymentsLeft(env: Env, order: number): Promise<Decimal> {
  return env.asSuperuser({ reason: 'down payments' }, async (su) => {
    let left = zero;
    for (const l of await (
      await su.model('account.move.line').search({ where: { downPaymentOf: order } as never })
    ).load({ move: true }))
      if (l.move.state !== 'cancel')
        left = left.plus((l.priceUnit ?? zero).times(l.quantity ?? zero));
    return left;
  });
}

/** The company's down payment product, made once. */
async function downPaymentProduct(env: Env, company: number): Promise<number> {
  return env.asSuperuser({ reason: 'down payment product' }, async (su) => {
    const [c] = await su
      .model('res.company')
      .browse([company as never])
      .load({ downPaymentProduct: true });
    const existing = c?.downPaymentProduct?.id as number | undefined;
    if (existing !== undefined) return existing;
    const made = await su
      .model('product.product')
      .create([
        { name: 'Down payment', kind: 'service', saleOk: false, purchaseOk: false } as never,
      ]);
    const id = made.ids[0] as number;
    await su
      .model('res.company')
      .browse([company as never])
      .write({ downPaymentProduct: id as never });
    return id;
  });
}

/**
 * A draft customer invoice for an order (RFC 0028 §3.3): the given lines, to its invoice address with its payment
 * terms, else the customer's. @throws when the company has no sales journal
 */
async function invoiceFor(
  env: Env,
  order: number,
  lines: readonly Record<string, unknown>[],
): Promise<number> {
  const [o] = await env
    .model('sale.order')
    .browse([order as never])
    .load({
      partner: true,
      partnerInvoice: true,
      paymentTerm: true,
      currency: true,
      company: true,
    });
  if (o === undefined) throw new orm.ValidationError('sale.order', [], 'No such order.', '');
  const journal = await env.model('account.journal').search({
    where: { company: o.company.id, type: 'sale' },
    limit: 1,
  });
  const journalId = journal.ids[0];
  if (journalId === undefined)
    throw new orm.ValidationError(
      'sale.order',
      ['state'],
      'The company has no sales journal.',
      'Install a chart of accounts (Accounting › Configuration).',
    );
  const made = await env.model('account.move').create([
    {
      kind: 'out_invoice',
      journal: journalId,
      // The invoice address and payment terms of the order, else the customer's (RFC 0028 §3.2).
      partner: o.partnerInvoice?.id ?? o.partner.id,
      paymentTerm: o.paymentTerm?.id ?? o.partner.customerPaymentTerm?.id ?? null,
      currency: o.currency.id,
      company: o.company.id,
      date: env.today(),
      invoiceOrigin: o.name,
      saleOrder: o.id,
      lines: { create: lines },
    } as never,
  ]);
  return made.ids[0] as number;
}

/**
 * A down payment on a confirmed order (RFC 0028 §3.3): a percent of its total or an amount, invoiced on the
 * company's down payment product; the next invoices deduct it. Returns the invoice.
 */
export async function downPayment(
  env: Env,
  order: number,
  input: { readonly percent?: Decimal; readonly amount?: Decimal },
): Promise<number> {
  const [o] = await env
    .model('sale.order')
    .browse([order as never])
    .load({ company: true });
  if (o === undefined) throw new orm.ValidationError('sale.order', [], 'No such order.', '');
  if (o.state !== 'sale')
    throw new orm.ValidationError(
      'sale.order',
      ['state'],
      'Down payments are for confirmed orders.',
      'Confirm the order first.',
    );
  const total = amountOf(o.amountTotal);
  const amount =
    input.amount ?? (input.percent === undefined ? zero : total.times(input.percent).div(100));
  const left = await downPaymentsLeft(env, order);
  if (amount.lte(0) || amount.plus(left).gt(total))
    throw new orm.ValidationError(
      'sale.order',
      [],
      `A down payment is more than nothing and, with those not deducted yet (${left.toFixed(2)}), at most the order’s total (${total.toFixed(2)}).`,
      'Give a smaller amount or percent.',
    );
  const product = await downPaymentProduct(env, o.company.id as number);
  return invoiceFor(env, order, [
    {
      lineKind: 'product',
      product,
      name: `Down payment on ${String(o.name)}`,
      quantity: '1',
      priceUnit: amount.toDecimalPlaces(2).toString(),
      downPaymentOf: order,
      debit: '0',
      credit: '0',
    },
  ]);
}

export const SaleOrderInvoicing = extendModel('sale.order', {
  fields: {
    /** The order's payment terms (RFC 0028 §3.2); empty: the customer's, on the invoice. */
    paymentTerm: f.many2one('account.payment.term', {
      ondelete: 'restrict',
      label: 'Payment terms',
      help: 'Passed to the invoice; empty: the customer’s payment terms.',
    }),
    /** What the last credit check found (RFC 0028 §3.2), shown on the order. */
    creditNote: f.char({ label: 'Credit' }),
    /** The next down payment (RFC 0028 §3.3): a percent of the total or an amount; cleared once invoiced. */
    downPaymentPercent: f.decimal({
      scale: 2,
      label: 'Down payment %',
      help: 'A percent of the order’s total, invoiced by “Invoice a down payment”.',
    }),
    downPaymentAmount: f.decimal({
      scale: 2,
      label: 'Down payment amount',
      help: 'An amount, invoiced by “Invoice a down payment” (used instead of the percent).',
    }),
    /** Waiting for a credit approval (the approval policy's condition). */
    creditHeld: f.boolean({ default: false, label: 'Held for credit' }),
    invoices: f.one2many('account.move', 'saleOrder'),
    invoiceState: f.selection(
      { no: 'Nothing to invoice', to_invoice: 'To invoice', invoiced: 'Invoiced' },
      {
        store: true,
        label: 'Invoicing',
        help: 'To invoice while some ordered quantity is not invoiced yet; invoiced when all of it is.',
        ...compute(
          'sale.order',
          'invoiceState',
          ['state', 'lines.quantity', 'lines.qtyInvoiced'],
          (orders) => {
            for (const o of orders)
              o.invoiceState =
                o.state === 'sale' || o.state === 'done'
                  ? o.lines.length > 0 &&
                    [...o.lines].every((l) => (l.qtyInvoiced ?? zero).gte(l.quantity))
                    ? 'invoiced'
                    : 'to_invoice'
                  : 'no';
          },
        ),
      },
    ),
  },
  overrides: {
    // The credit check before a confirmation (RFC 0028 §3.2).
    confirming: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const orders = this as { env: Env; ids: readonly number[] };
      const env = orders.env;
      for (const o of await env
        .model('sale.order')
        .browse([...orders.ids] as never)
        .load({ company: true, partner: true })) {
        const mode = String(o.company.creditControl ?? 'off');
        if (mode === 'off') continue;
        const { owed, limit } = await creditOf(
          env,
          o.partner.id as number,
          o.company.id as number,
          o.id as number,
        );
        if (limit === null) continue;
        const total = owed.plus(amountOf(o.amountTotal));
        const note = `Owes ${owed.toFixed(2)}; with this order ${total.toFixed(2)}, limit ${limit.toFixed(2)}.`;
        if (total.lte(limit)) {
          if (o.creditNote !== null)
            await env.model('sale.order').browse([o.id]).write({ creditNote: null });
          continue;
        }
        if (mode === 'warn') {
          await env
            .model('sale.order')
            .browse([o.id])
            .write({ creditNote: `Over the credit limit. ${note}` });
          continue;
        }
        throw new orm.ValidationError(
          'sale.order',
          ['state'],
          `${String(o.name)} takes ${String(o.partner.name)} over their credit limit. ${note}`,
          mode === 'approval'
            ? 'Ask for a credit approval instead (Accounting managers decide).'
            : 'Collect a payment first, or raise the customer’s limit.',
        );
      }
    },
  },
  fieldOverrides: {
    state: {
      statesAdd: { credit: 'Credit approval' },
      transitionsAdd: {
        // Over the limit, in approval mode: the order waits for Accounting managers.
        askCredit: {
          from: ['draft', 'sent'],
          to: 'credit',
          guard: records('sale.order', async (orders) => {
            const loaded = await orders.load({ lines: true, company: true });
            return loaded.filter(
              (o) => o.lines.length === 0 || o.company.creditControl !== 'approval',
            );
          }),
          message: 'Credit approvals are for orders with lines, when the company asks for them.',
          after: records('sale.order', async (orders) => {
            const env = orders.env as unknown as Env;
            for (const o of await orders.load({ company: true, partner: true })) {
              const { owed, limit } = await creditOf(
                env,
                o.partner.id as number,
                o.company.id as number,
                o.id as number,
              );
              const total = owed.plus(amountOf(o.amountTotal));
              await env
                .model('sale.order')
                .browse([o.id])
                .write({
                  creditHeld: true,
                  creditNote: `Waiting for a credit approval: with this order ${total.toFixed(2)}, limit ${limit === null ? 'none' : limit.toFixed(2)}.`,
                });
            }
            await requestApprovals(orders);
          }),
        },
        creditApprove: {
          from: ['credit'],
          to: 'sale',
          guard: records('sale.order', (orders) => approvalGuard(orders)),
          message: 'Waiting for the credit approval.',
          after: records('sale.order', async (orders) => {
            for (const o of await orders.load({})) {
              await orders.env.emit('sale.order.confirmed', { id: o.id });
              await (orders.env as unknown as Env)
                .model('sale.order')
                .browse([o.id])
                .write({ creditHeld: false, creditNote: null });
            }
          }),
        },
        creditReject: {
          from: ['credit'],
          to: 'draft',
          after: records('sale.order', async (orders) => {
            for (const o of await orders.load({}))
              await (orders.env as unknown as Env)
                .model('sale.order')
                .browse([o.id])
                .write({ creditHeld: false, creditNote: 'The credit approval was refused.' });
          }),
        },
        // A down payment: the amount typed in, else the percent; the next invoices deduct it.
        invoiceDownPayment: {
          from: ['sale'],
          to: 'sale',
          guard: records('sale.order', async (orders) =>
            (await orders.load({})).filter(
              (o) => o.downPaymentAmount === null && o.downPaymentPercent === null,
            ),
          ),
          message: 'Give a down payment percent or amount first.',
          after: records('sale.order', async (orders) => {
            const env = orders.env as unknown as Env;
            for (const o of await orders.load({})) {
              await downPayment(env, o.id as number, {
                ...(o.downPaymentAmount !== null
                  ? { amount: o.downPaymentAmount }
                  : { percent: o.downPaymentPercent ?? zero }),
              });
              await env
                .model('sale.order')
                .browse([o.id])
                .write({ downPaymentAmount: null, downPaymentPercent: null });
            }
          }),
        },
        invoice: {
          from: ['sale'],
          to: 'sale',
          // Something to invoice now: ordered, or delivered for products invoiced on delivery, not invoiced yet.
          guard: records('sale.order', async (orders) => {
            const due = await toInvoice(orders.env as unknown as Env, [...orders.ids] as number[]);
            const loaded = await orders.load({ lines: true });
            return loaded.filter(
              (o) => ![...o.lines].some((l) => (due.get(l.id as number) ?? zero).gt(0)),
            );
          }),
          message:
            'Nothing to invoice now: this order is invoiced already, as far as it is ordered or delivered.',
          after: records('sale.order', async (orders) => {
            const env = orders.env as unknown as Env;
            const due = await toInvoice(env, [...orders.ids] as number[]);
            for (const o of await orders.load({
              lines: { product: true, taxes: true },
              company: true,
            })) {
              const lines: Record<string, unknown>[] = [...o.lines]
                .filter((l) => (due.get(l.id as number) ?? zero).gt(0))
                .map((l) => ({
                  lineKind: 'product' as const,
                  product: l.product.id,
                  name: l.name,
                  quantity: (due.get(l.id as number) ?? zero).toString(),
                  priceUnit: l.priceUnit,
                  discount: l.discount,
                  taxes: { set: [...l.taxes].map((t) => t.id) },
                  saleLine: l.id,
                  debit: '0',
                  credit: '0',
                }));
              // Down payments not deducted yet come off this invoice.
              const left = await downPaymentsLeft(env, o.id as number);
              if (left.gt(0))
                lines.push({
                  lineKind: 'product',
                  product: await downPaymentProduct(env, o.company.id as number),
                  name: `Down payment deducted (${String(o.name)})`,
                  quantity: '1',
                  priceUnit: left.negated().toString(),
                  downPaymentOf: o.id,
                  debit: '0',
                  credit: '0',
                });
              await invoiceFor(env, o.id as number, lines);
            }
          }),
        },
      },
    },
  },
});

export const saleAccountShutro = defineModule({
  name: 'sale_account',
  version: '0.3.0',
  migrations: [
    {
      version: '0.3.0',
      description:
        'Invoicing by line: existing invoice lines linked to their order lines (same order, product and description), so invoiced orders are not invoiced again',
      up: async (ctx) => {
        await ctx.sql`UPDATE account_move_line ml SET sale_line_id = sol.id
          FROM account_move m, sale_order_line sol
          WHERE ml.move_id = m.id AND m.sale_order_id = sol.order_id AND ml.product_id = sol.product_id
            AND ml.name = sol.name AND ml.line_kind = 'product' AND ml.sale_line_id IS NULL`;
        await ctx.sql`UPDATE sale_order_line sol SET qty_invoiced = coalesce((
          SELECT sum(CASE WHEN m.kind = 'out_refund' THEN -ml.quantity ELSE ml.quantity END)
          FROM account_move_line ml JOIN account_move m ON m.id = ml.move_id
          WHERE ml.sale_line_id = sol.id AND m.state <> 'cancel'), 0)`;
      },
    },
  ],
  depends: [salesShutro, accountingShutro, permissionsShutro],
  groups: [
    orm.defineGroup({
      code: 'sale_account.user',
      label: 'Invoicing from sales orders',
      implies: ['sales.user', 'account.invoicing'],
    }),
  ],
  models: [],
  extensions: [
    MoveSaleOrder,
    MoveLineSale,
    SaleLineInvoicing,
    SaleOrderInvoicing,
    CompanyCredit,
    PartnerCredit,
    CompanyDownPayment,
  ],
});
