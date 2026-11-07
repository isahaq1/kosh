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
    /** Waiting for a credit approval (the approval policy's condition). */
    creditHeld: f.boolean({ default: false, label: 'Held for credit' }),
    invoices: f.one2many('account.move', 'saleOrder'),
    invoiceState: f.selection(
      { no: 'Nothing to invoice', to_invoice: 'To invoice', invoiced: 'Invoiced' },
      {
        store: true,
        label: 'Invoicing',
        ...compute('sale.order', 'invoiceState', ['state', 'invoices.state'], (orders) => {
          for (const o of orders)
            o.invoiceState =
              o.state === 'sale' || o.state === 'done'
                ? o.invoices.filter((i) => i.state !== 'cancel').length > 0
                  ? 'invoiced'
                  : 'to_invoice'
                : 'no';
        }),
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
        invoice: {
          from: ['sale'],
          to: 'sale',
          guard: records('sale.order', async (orders) => {
            const loaded = await orders.load({ invoices: true });
            return loaded.filter((o) => o.invoices.filter((i) => i.state !== 'cancel').length > 0);
          }),
          message: 'This order is invoiced already.',
          after: records('sale.order', async (orders) => {
            const env = orders.env;
            const loaded = await orders.load({
              lines: { product: true, taxes: true },
              partner: true,
              partnerInvoice: true,
              paymentTerm: true,
              currency: true,
              company: true,
            });
            for (const o of loaded) {
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
              await env.model('account.move').create([
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
                  lines: {
                    create: o.lines.map((l) => ({
                      lineKind: 'product' as const,
                      product: l.product.id,
                      name: l.name,
                      quantity: l.quantity,
                      priceUnit: l.priceUnit,
                      discount: l.discount,
                      taxes: { set: [...l.taxes].map((t) => t.id) },
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

export const saleAccountShutro = defineModule({
  name: 'sale_account',
  version: '0.2.0',
  depends: [salesShutro, accountingShutro, permissionsShutro],
  groups: [
    orm.defineGroup({
      code: 'sale_account.user',
      label: 'Invoicing from sales orders',
      implies: ['sales.user', 'account.invoicing'],
    }),
  ],
  models: [],
  extensions: [MoveSaleOrder, SaleOrderInvoicing, CompanyCredit, PartnerCredit],
});
