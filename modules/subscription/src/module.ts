/**
 * The data layer of Subscriptions (RFC 0034 §2.5): **plans** (how often a subscription bills, its trial, whether
 * its invoices post by themselves), **subscriptions** of a customer with their lines — a product, a quantity, a
 * price from a price list or typed in —, **usage** recorded against a line and billed in the next invoice, and
 * the invoices themselves: ordinary customer invoices of Accounting, one per period, made once.
 *
 * A subscription is drafted, started (with a trial when its plan has one), paused and resumed, and closed with a
 * reason. A change of its lines in the middle of a paid period is invoiced, or credited, for the days that are
 * left (*Apply changes*). What it is worth a month (MRR) is kept on it for the reports.
 */
import { accountingShutro } from '@kosh/accounting';
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { priceFor, productShutro } from '@kosh/product';
import { emitting } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  records,
} from './.kosh/bindings.js';
import { addDays, mrrOf, type Period, type PeriodUnit, periodOf, prorate } from './billing.js';

/**
 * Fields the server maintains: written by its own code (as the system) and by Administrators only. An empty list
 * would mean *everyone* — Shutro reads no groups as no restriction.
 */
const SYSTEM = ['base.admin'] as const;

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const ZERO: Decimal = orm.toDecimal(0);
const HUNDRED: Decimal = orm.toDecimal(100);
const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

export const SubscriptionPlan = defineModel('subscription.plan', {
  label: 'Subscription plan',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  access: { 'subscription.user': READ, 'subscription.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    unit: f.selection(
      { day: 'Day', week: 'Week', month: 'Month', year: 'Year' },
      {
        required: true,
        default: 'month',
        label: 'Bills every',
        help: 'The unit of a billing period.',
      },
    ),
    interval: f.integer({
      required: true,
      default: 1,
      label: 'Every',
      help: '1: every month; 3: every quarter; with Year, 1: every year.',
    }),
    trialDays: f.integer({
      required: true,
      default: 0,
      label: 'Trial (days)',
      help: 'Days a new subscription runs before its first invoice.',
    }),
    autoPost: f.boolean({
      default: false,
      label: 'Post the invoices',
      help: 'Post each invoice when it is made (it is then sent and followed up like any invoice); off: invoices are drafted for a person to check.',
    }),
  },
  sqlConstraints: {
    rhythm: {
      check: orm.sql`"interval" >= 1 AND trial_days >= 0`,
      message: 'A plan bills every 1 or more, and a trial is not negative.',
    },
  },
});

const CLOSE_REASONS = {
  price: 'Too expensive',
  need: 'No longer needed',
  competitor: 'Went to a competitor',
  quality: 'Not satisfied',
  unpaid: 'Did not pay',
  other: 'Other',
} as const;

export const Subscription = defineModel('subscription.subscription', {
  label: 'Subscription',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'plan', 'nextInvoiceDate', 'recurring'],
  access: { 'subscription.user': ALL, 'subscription.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, sequence: 'subscription.subscription', label: 'Reference' }),
    partner: f.many2one('res.partner', { required: true, ondelete: 'restrict', label: 'Customer' }),
    plan: f.many2one('subscription.plan', { required: true, ondelete: 'restrict' }),
    pricelist: f.many2one('product.pricelist', {
      ondelete: 'restrict',
      label: 'Price list',
      help: 'Prices of the lines without a price typed in; empty: the products’ list prices.',
    }),
    paymentTerm: f.many2one('account.payment.term', {
      ondelete: 'restrict',
      label: 'Payment terms',
      help: 'On each invoice.',
    }),
    dateStart: f.date({
      required: true,
      default: (env: Env) => env.today(),
      label: 'Starts',
      help: 'The first day of the subscription (and of its trial, when the plan has one).',
    }),
    lines: f.one2many('subscription.line', 'subscription'),
    /** The untaxed amount of a whole period, from the lines. */
    recurring: f.decimal({
      scale: 2,
      store: true,
      label: 'Per period',
      help: 'What a period costs before taxes: the lines’ amounts (usage is billed on top, as it is recorded).',
      ...compute('subscription.subscription', 'recurring', ['lines.subtotal'], (subs) => {
        for (const s of subs)
          s.recurring = [...s.lines].reduce((sum, l) => sum.plus(l.subtotal ?? ZERO), ZERO);
      }),
    }),
    /** What it is worth a month while it runs: the base of MRR and churn. */
    mrr: f.decimal({
      scale: 2,
      store: true,
      label: 'MRR',
      help: 'Monthly recurring revenue: the amount per period brought to a month; nothing while it is not running.',
      ...compute(
        'subscription.subscription',
        'mrr',
        ['recurring', 'state', 'plan.unit', 'plan.interval'],
        (subs) => {
          for (const s of subs)
            s.mrr =
              s.state === 'active' && s.plan !== null
                ? orm.toDecimal(
                    mrrOf((s.recurring ?? ZERO).toFixed(2), {
                      unit: s.plan.unit as PeriodUnit,
                      interval: s.plan.interval,
                    }),
                  )
                : ZERO;
        },
      ),
    }),
    /** Billing: the first billing day, how many periods were invoiced, and the period paid for. */
    anchorDate: f.date({ label: 'First billing day', groups: { write: [...SYSTEM] } }),
    periodsBilled: f.integer({
      default: 0,
      label: 'Periods invoiced',
      groups: { write: [...SYSTEM] },
    }),
    nextInvoiceDate: f.date({
      label: 'Next invoice',
      help: 'The day the next period is invoiced; after the trial for a new subscription.',
      groups: { write: [...SYSTEM] },
    }),
    periodStart: f.date({ label: 'Paid from', groups: { write: [...SYSTEM] } }),
    periodEnd: f.date({ label: 'Paid to', groups: { write: [...SYSTEM] } }),
    dateEnd: f.date({ label: 'Closed on', groups: { write: [...SYSTEM] } }),
    closeReason: f.selection(CLOSE_REASONS, {
      label: 'Reason for closing',
      help: 'Why the customer left: needed to close, and what the churn report groups by.',
    }),
    invoices: f.one2many('account.move', 'subscription'),
    state: f.state({
      states: { draft: 'Draft', active: 'Running', paused: 'Paused', closed: 'Closed' },
      initial: 'draft',
      help: 'Drafted until it is started; running while it bills; paused while it does not; closed for good.',
      transitions: {
        begin: emitting('subscription.subscription.started', {
          from: ['draft'],
          to: 'active',
          guard: records('subscription.subscription', async (subs) =>
            (await subs.load({ lines: true })).filter((s) => s.lines.length === 0),
          ),
          message: 'A subscription needs at least one line to start.',
          after: records('subscription.subscription', async (subs) => {
            for (const id of subs.ids) await startBilling(subs.env, id as number);
          }),
        }),
        pause: { from: ['active'], to: 'paused' },
        // Billing starts again from today: the time it was paused is not invoiced.
        resume: {
          from: ['paused'],
          to: 'active',
          after: records('subscription.subscription', async (subs) => {
            for (const id of subs.ids) await resumeBilling(subs.env, id as number);
          }),
        },
        // A change of the lines in the middle of a paid period: invoiced or credited for the days left.
        amend: {
          from: ['active'],
          to: 'active',
          after: records('subscription.subscription', async (subs) => {
            for (const id of subs.ids) await applyChanges(subs.env, id as number);
          }),
        },
        close: emitting('subscription.subscription.closed', {
          from: ['active', 'paused'],
          to: 'closed',
          guard: records('subscription.subscription', async (subs) =>
            (await subs.load(['closeReason'])).filter((s) => s.closeReason === null),
          ),
          message: 'Choose the reason for closing first.',
          after: records('subscription.subscription', async (subs) => {
            await subs.env.asSuperuser({ reason: 'a subscription closed' }, async (su) => {
              await su
                .model('subscription.subscription')
                .browse([...subs.ids] as never)
                .write({ dateEnd: su.today(), nextInvoiceDate: null } as never);
            });
          }),
        }),
      },
    }),
  },
});

export const SubscriptionLine = defineModel('subscription.line', {
  label: 'Subscription line',
  order: ['sequence asc', 'id asc'],
  access: { 'subscription.user': ALL, 'subscription.manager': ALL },
  fields: {
    subscription: f.many2one('subscription.subscription', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    name: f.char({
      label: 'Description',
      help: 'On the invoice; empty: the product’s name.',
    }),
    kind: f.selection(
      { fixed: 'Every period', usage: 'By usage' },
      {
        required: true,
        default: 'fixed',
        label: 'Billed',
        help: 'Every period: the quantity below, each period. By usage: what was recorded for the line since the last invoice.',
      },
    ),
    quantity: f.decimal({ scale: 3, required: true, default: '1' }),
    manualPrice: f.decimal({
      scale: 2,
      label: 'Your price',
      help: 'A price typed in: it is kept, whatever the price list says.',
    }),
    priceUnit: f.decimal({
      scale: 2,
      store: true,
      label: 'Unit price',
      help: 'The price typed in, else the subscription’s price list’s, else the product’s list price.',
      ...compute(
        'subscription.line',
        'priceUnit',
        ['product', 'quantity', 'manualPrice', 'subscription.pricelist'],
        async (lines) => {
          for (const l of lines) {
            if (l.manualPrice !== null) {
              l.priceUnit = l.manualPrice;
              continue;
            }
            if (l.product === null) {
              l.priceUnit = ZERO;
              continue;
            }
            const found = await priceFor(
              lines.env as never,
              (l.subscription?.pricelist?.id as number | undefined) ?? null,
              l.product.id as number,
              l.quantity ?? orm.toDecimal(1),
              lines.env.today(),
            );
            l.priceUnit = orm.toDecimal(String(found.price));
          }
        },
      ),
    }),
    discount: f.decimal({ scale: 2, required: true, default: '0', label: 'Discount %' }),
    taxes: f.many2many('account.tax', {
      relation: 'subscription_line_tax_rel',
      help: 'Empty: the product’s sales taxes.',
    }),
    /** The untaxed amount of the line for a whole period; nothing for a line billed by usage. */
    subtotal: f.decimal({
      scale: 2,
      store: true,
      label: 'Amount',
      help: 'Quantity × price, less the discount; a line billed by usage counts when its usage is invoiced.',
      ...compute(
        'subscription.line',
        'subtotal',
        ['kind', 'quantity', 'priceUnit', 'discount'],
        (lines) => {
          for (const l of lines)
            l.subtotal =
              l.kind === 'usage'
                ? ZERO
                : (l.quantity ?? ZERO)
                    .times(l.priceUnit ?? ZERO)
                    .times(HUNDRED.minus(l.discount ?? ZERO))
                    .div(HUNDRED)
                    .toDecimalPlaces(2);
        },
      ),
    }),
    /** What the current period was invoiced for this line: the base of a change in the middle of it. */
    billedSubtotal: f.decimal({
      scale: 2,
      default: '0',
      label: 'Invoiced for the period',
      groups: { write: [...SYSTEM] },
    }),
    usage: f.one2many('subscription.usage', 'line'),
    sequence: f.integer({ required: true, default: 10 }),
  },
  sqlConstraints: {
    amounts: {
      check: orm.sql`quantity >= 0 AND discount >= 0 AND discount <= 100`,
      message: 'A quantity is not negative, and a discount is between 0 and 100 %.',
    },
  },
});

/**
 * Usage of a line (RFC 0034 §2.5): so many units on a day — meter readings, hours, messages sent — recorded by a
 * person, an import or another app through the API. What is not invoiced yet goes on the subscription's next
 * invoice, once.
 */
export const SubscriptionUsage = defineModel('subscription.usage', {
  label: 'Usage',
  recName: 'note',
  order: ['date desc', 'id desc'],
  access: { 'subscription.user': ALL, 'subscription.manager': [...ALL, 'export', 'import'] },
  fields: {
    line: f.many2one('subscription.line', { required: true, ondelete: 'cascade' }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    quantity: f.decimal({ scale: 3, required: true }),
    note: f.char(),
    invoice: f.many2one('account.move', {
      ondelete: 'set null',
      label: 'Invoiced on',
      groups: { write: [...SYSTEM] },
    }),
  },
  sqlConstraints: {
    positive: { check: orm.sql`quantity > 0`, message: 'Usage is more than zero.' },
  },
  constraints: {
    usageLine: {
      ...check('subscription.usage', ['line'], async (usage) =>
        (await usage.load({ line: true })).filter((u) => u.line.kind !== 'usage').map((u) => u.id),
      ),
      message: 'Usage is recorded on a line billed by usage.',
    },
    // What is invoiced is not changed afterwards.
    invoicedStands: {
      ...check('subscription.usage', ['quantity', 'date', 'line', 'invoice'], async (usage) =>
        usage.env.su ? [] : [...usage].filter((u) => u.invoice !== null).map((u) => u.id),
      ),
      message: 'This usage is invoiced already.',
    },
  },
});

/** An invoice of a subscription, and the period it is for (one invoice per subscription and period). */
export const MoveSubscription = extendModel('account.move', {
  fields: {
    subscription: f.many2one('subscription.subscription', {
      ondelete: 'set null',
      label: 'Subscription',
    }),
    subscriptionPeriod: f.date({ label: 'Subscription period from' }),
  },
});

// ---- billing

const periodOfPlan = (plan: { unit: string; interval: number }): Period => ({
  unit: plan.unit as PeriodUnit,
  interval: plan.interval,
});

/** A started subscription's first billing day: its start, after the plan's trial. */
async function startBilling(env: Env, id: number): Promise<void> {
  await env.asSuperuser({ reason: 'a subscription started' }, async (su) => {
    const [s] = await su
      .model('subscription.subscription')
      .browse([id as never])
      .load({ plan: true });
    if (s === undefined) return;
    const anchor = addDays(iso(s.dateStart), s.plan.trialDays);
    await su
      .model('subscription.subscription')
      .browse([id as never])
      .write({ anchorDate: anchor, periodsBilled: 0, nextInvoiceDate: anchor } as never);
    await su.flush();
  });
}

/** Resumed: a next invoice that fell due while it was paused is due today, and periods count from there. */
async function resumeBilling(env: Env, id: number): Promise<void> {
  await env.asSuperuser({ reason: 'a subscription resumed' }, async (su) => {
    const [s] = await su
      .model('subscription.subscription')
      .browse([id as never])
      .load(['nextInvoiceDate']);
    if (s === undefined) return;
    const today = su.today();
    if (s.nextInvoiceDate !== null && iso(s.nextInvoiceDate) >= today) return;
    await su
      .model('subscription.subscription')
      .browse([id as never])
      .write({ anchorDate: today, periodsBilled: 0, nextInvoiceDate: today } as never);
    await su.flush();
  });
}

/** The sales journal of a company. @throws when it has none */
async function salesJournal(su: Env, company: number): Promise<number> {
  const journal = await su
    .model('account.journal')
    .search({ where: { company: company as never, type: 'sale' }, limit: 1 });
  const id = journal.ids[0];
  if (id === undefined)
    throw new orm.ValidationError(
      'subscription.subscription',
      ['state'],
      'The company has no sales journal.',
      'Install a chart of accounts (Accounting › Configuration).',
    );
  return id as number;
}

/**
 * Invoices every period of a running subscription that is due on `today` (at most `limit` at once: one that was
 * left behind catches up): the lines billed every period, and the usage recorded and not invoiced yet up to the day
 * before the period. One invoice per subscription and period — asked twice, the second finds the first. Posted
 * when the plan says so. Returns the invoices made.
 */
export async function invoiceSubscription(
  env: Env,
  id: number,
  today: string = env.today(),
  limit = 12,
): Promise<number[]> {
  return env.asSuperuser({ reason: 'subscription invoices' }, async (su) => {
    const made: number[] = [];
    for (let round = 0; round < limit; round += 1) {
      const [s] = await su
        .model('subscription.subscription')
        .browse([id as never])
        .load({
          plan: true,
          partner: true,
          company: { currency: true },
          paymentTerm: true,
          lines: { product: { taxes: true }, taxes: true },
        });
      if (s === undefined || s.state !== 'active' || s.anchorDate === null) break;
      if (s.nextInvoiceDate === null || iso(s.nextInvoiceDate) > today) break;
      const period = periodOf(iso(s.anchorDate), periodOfPlan(s.plan), s.periodsBilled ?? 0);
      const advance = {
        periodsBilled: (s.periodsBilled ?? 0) + 1,
        nextInvoiceDate: period.next,
        periodStart: period.start,
        periodEnd: period.end,
      };
      // Once: an invoice of this period that is not cancelled means the period is done.
      const existing = await su.model('account.move').search({
        where: {
          subscription: s.id,
          subscriptionPeriod: period.start,
          state: { ne: 'cancel' },
        } as never,
        limit: 1,
      });
      if (existing.length === 0) {
        const lines: Record<string, unknown>[] = [];
        const taxesOf = (l: {
          taxes: Iterable<{ id: unknown }> & { length: number };
          product: { taxes: Iterable<{ id: unknown }> };
        }) => (l.taxes.length > 0 ? [...l.taxes] : [...l.product.taxes]).map((t) => t.id);
        for (const l of s.lines) {
          if (l.kind !== 'fixed' || (l.quantity ?? ZERO).lte(0)) continue;
          lines.push({
            lineKind: 'product',
            product: l.product.id,
            name: `${l.name ?? l.product.name} (${period.start} – ${period.end})`,
            quantity: l.quantity,
            priceUnit: l.priceUnit ?? ZERO,
            discount: l.discount ?? ZERO,
            taxes: { set: taxesOf(l) },
          });
        }
        // Usage up to the day before this period, not invoiced yet.
        const usageIds: number[] = [];
        for (const l of s.lines) {
          if (l.kind !== 'usage') continue;
          const used = await su.model('subscription.usage').search({
            where: { line: l.id, invoice: { isNull: true }, date: { lt: period.start } } as never,
          });
          const quantity = [...used].reduce((sum, u) => sum.plus(u.quantity), ZERO);
          if (quantity.lte(0)) continue;
          usageIds.push(...used.ids.map(Number));
          lines.push({
            lineKind: 'product',
            product: l.product.id,
            name: `${l.name ?? l.product.name} — usage to ${addDays(period.start, -1)}`,
            quantity,
            priceUnit: l.priceUnit ?? ZERO,
            discount: l.discount ?? ZERO,
            taxes: { set: taxesOf(l) },
          });
        }
        if (lines.length > 0) {
          const invoice = await su.model('account.move').create([
            {
              kind: 'out_invoice',
              journal: await salesJournal(su, s.company.id as number),
              partner: s.partner.id,
              paymentTerm: s.paymentTerm?.id ?? null,
              currency: s.company.currency.id,
              company: s.company.id,
              date: today,
              invoiceOrigin: s.name,
              ref: `${s.name}: ${period.start} – ${period.end}`,
              subscription: s.id,
              subscriptionPeriod: period.start,
              lines: { create: lines },
            } as never,
          ]);
          const invoiceId = invoice.ids[0] as number;
          if (usageIds.length > 0)
            await su
              .model('subscription.usage')
              .browse(usageIds as never)
              .write({ invoice: invoiceId } as never);
          await su.flush();
          if (s.plan.autoPost)
            await su
              .model('account.move')
              .browse([invoiceId as never])
              .post();
          made.push(invoiceId);
          await su.emit('subscription.subscription.invoiced', { id: s.id, invoice: invoiceId });
        }
      }
      await su
        .model('subscription.subscription')
        .browse([s.id])
        .write(advance as never);
      // What the period was invoiced for, line by line: the base of a change in the middle of it.
      for (const l of s.lines)
        await su
          .model('subscription.line')
          .browse([l.id])
          .write({ billedSubtotal: l.subtotal ?? ZERO } as never);
      await su.flush();
    }
    return made;
  });
}

/**
 * A change of a running subscription's lines in the middle of a paid period (RFC 0034 §2.5): each line whose
 * amount differs from what the period was invoiced for is invoiced — or credited — for the days left from today
 * to the period's end. Nothing before the first invoice (a trial), or after the period. Returns the document made.
 */
export async function applyChanges(env: Env, id: number, on?: string): Promise<number | null> {
  return env.asSuperuser({ reason: 'a subscription changed' }, async (su) => {
    const [s] = await su
      .model('subscription.subscription')
      .browse([id as never])
      .load({
        plan: true,
        partner: true,
        company: { currency: true },
        paymentTerm: true,
        lines: { product: { taxes: true }, taxes: true },
      });
    if (s === undefined || s.state !== 'active') return null;
    if (s.periodStart === null || s.periodEnd === null) return null;
    const today = on ?? su.today();
    const period = { start: iso(s.periodStart), end: iso(s.periodEnd) };
    const up: Record<string, unknown>[] = [];
    const down: Record<string, unknown>[] = [];
    for (const l of s.lines) {
      if (l.kind !== 'fixed') continue;
      const delta = (l.subtotal ?? ZERO).minus(l.billedSubtotal ?? ZERO);
      if (delta.isZero()) continue;
      const share = prorate(delta.abs().toFixed(2), today, period);
      await su
        .model('subscription.line')
        .browse([l.id])
        .write({ billedSubtotal: l.subtotal ?? ZERO } as never);
      if (orm.toDecimal(share.amount).lte(0)) continue;
      (delta.gt(0) ? up : down).push({
        lineKind: 'product',
        product: l.product.id,
        name: `${l.name ?? l.product.name}: change from ${today}, ${share.days} of ${share.of} days`,
        quantity: '1',
        priceUnit: share.amount,
        discount: '0',
        taxes: { set: (l.taxes.length > 0 ? [...l.taxes] : [...l.product.taxes]).map((t) => t.id) },
      });
    }
    let made: number | null = null;
    for (const [kind, lines] of [
      ['out_invoice', up],
      ['out_refund', down],
    ] as const) {
      if (lines.length === 0) continue;
      const document = await su.model('account.move').create([
        {
          kind,
          journal: await salesJournal(su, s.company.id as number),
          partner: s.partner.id,
          paymentTerm: s.paymentTerm?.id ?? null,
          currency: s.company.currency.id,
          company: s.company.id,
          date: today,
          invoiceOrigin: s.name,
          ref: `${s.name}: change from ${today} to ${period.end}`,
          subscription: s.id,
          lines: { create: lines },
        } as never,
      ]);
      made = document.ids[0] as number;
      await su.flush();
      if (s.plan.autoPost)
        await su
          .model('account.move')
          .browse([made as never])
          .post();
    }
    await su.flush();
    return made;
  });
}

/** Invoices every running subscription of the company that is due; returns how many invoices were made. */
export async function invoiceDue(env: Env, today: string = env.today()): Promise<number> {
  const due = await env.asSuperuser({ reason: 'subscriptions due' }, async (su) =>
    (
      await su.model('subscription.subscription').search({
        where: { state: 'active', nextInvoiceDate: { lte: today } } as never,
        order: ['id asc'],
        limit: 5000,
      })
    ).ids.map(Number),
  );
  let made = 0;
  for (const id of due) made += (await invoiceSubscription(env, id, today)).length;
  return made;
}

export const subscriptionShutro = defineModule({
  name: 'subscription',
  version: '0.1.0',
  depends: [accountingShutro, productShutro, contactsShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: 'subscription.user',
      label: 'Subscriptions user',
      implies: ['account.invoicing'],
    }),
    orm.defineGroup({
      code: 'subscription.manager',
      label: 'Subscriptions manager',
      implies: ['subscription.user'],
    }),
  ],
  sequences: [
    orm.defineSequence({
      code: 'subscription.subscription',
      prefix: 'SUB/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
  ],
  models: [SubscriptionPlan, Subscription, SubscriptionLine, SubscriptionUsage],
  extensions: [MoveSubscription],
});
