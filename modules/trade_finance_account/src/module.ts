/**
 * The data layer of the Trade Finance ↔ Accounting bridge (RFC 0021, Trade Finance step 2): an LC's margin posted when
 * it is issued and released when it is settled or cancelled; a presentation's payment posted against the vendor's
 * payable (import) or the customer's receivable (export); bank charges posted to LC charges, an expense. Entries are
 * in the LC's currency, in its bank journal; Accounting converts them at the day's rate.
 */
import { accountingShutro } from '@kosh/accounting';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import { tradeFinanceShutro } from '@kosh/trade_finance';
import {
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  type Records,
  records,
} from './.kosh/bindings.js';

const zero = orm.toDecimal(0);
const amountOf = (v: unknown): Decimal =>
  v === null || v === undefined
    ? zero
    : typeof v === 'object' && 'amount' in (v as object)
      ? ((v as { amount: Decimal }).amount ?? zero)
      : orm.toDecimal(String(v));

/** The accounts this bridge adds to a company's chart when missing, by code. */
export const TRADE_ACCOUNTS = {
  margin: { code: '1160', name: 'LC margin deposits', type: 'asset_current' },
  charges: { code: '6510', name: 'LC charges', type: 'expense' },
} as const;

async function accountOf(env: Env, company: Id<'res.company'>, which: keyof typeof TRADE_ACCOUNTS) {
  const spec = TRADE_ACCOUNTS[which];
  const found = await env
    .model('account.account')
    .search({ where: { company, code: spec.code }, limit: 1 });
  return (found.ids[0] ??
    (await env.model('account.account').create([{ ...spec, company }]))
      .ids[0]) as Id<'account.account'>;
}

/**
 * The LC's bank journal: its own, else the company's first bank journal (written on the LC). Refused when the company
 * has none.
 */
async function journalOf(
  env: Env,
  lc: {
    id: Id<'trade.lc'>;
    company: { id: Id<'res.company'> };
    journal: { id: Id<'account.journal'> } | null;
  },
): Promise<Id<'account.journal'>> {
  if (lc.journal !== null) return lc.journal.id;
  const found = (
    await env
      .model('account.journal')
      .search({ where: { company: lc.company.id, type: 'bank' }, limit: 1 })
  ).ids[0];
  if (found === undefined)
    throw new orm.ValidationError(
      'trade.lc',
      ['journal'],
      'The company has no bank journal to post the LC in.',
      'Add a bank journal in Accounting › Configuration, and choose it on the LC.',
    );
  await env.model('trade.lc').browse([lc.id]).write({ journal: found });
  return found;
}

/** Posts an entry in `journal`'s bank account against `account`, `amount` in `currency` (positive: into the bank). */
async function post(
  env: Env,
  input: {
    company: Id<'res.company'>;
    journal: Id<'account.journal'>;
    currency: Id<'res.currency'>;
    account: Id<'account.account'>;
    partner: Id<'res.partner'> | null;
    amount: Decimal;
    ref: string;
  },
): Promise<Id<'account.move'>> {
  const [journal] = await env.model('account.journal').browse([input.journal]).load({});
  const bank = journal?.defaultAccount?.id ?? null;
  if (bank === null)
    throw new orm.ValidationError(
      'trade.lc',
      ['journal'],
      'The LC’s bank journal has no account.',
      'Set the bank account of the journal in Accounting › Configuration.',
    );
  const lines = [
    {
      account: bank,
      partner: input.partner,
      name: input.ref,
      amountCurrency: input.amount.toString(),
    },
    {
      account: input.account,
      partner: input.partner,
      name: input.ref,
      amountCurrency: input.amount.negated().toString(),
    },
  ].map((l) => ({ ...l, debit: '0', credit: '0' }));
  const made = await env.model('account.move').create([
    {
      kind: 'entry',
      journal: input.journal,
      company: input.company,
      currency: input.currency,
      date: env.today(),
      ref: input.ref,
      partner: input.partner,
      lines: { create: lines },
    },
  ] as never);
  await env.withGrants({ grants: ['account.post'], reason: input.ref }, (e) =>
    e.model('account.move').browse(made.ids).post(),
  );
  return made.ids[0] as Id<'account.move'>;
}

export const LcAccounting = extendModel('trade.lc', {
  fields: {
    /** The bank journal of the issuing bank: where margins and payments are posted. */
    journal: f.many2one('account.journal', { ondelete: 'restrict', label: 'Bank journal' }),
    marginMove: f.many2one('account.move', { ondelete: 'set null', label: 'Margin entry' }),
    marginReleaseMove: f.many2one('account.move', {
      ondelete: 'set null',
      label: 'Margin released',
    }),
    charges: f.one2many('trade.lc.charge', 'lc', { label: 'Bank charges' }),
  },
  overrides: {
    // The margin, when the LC is issued.
    issued: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const lcs = this as Records<'trade.lc'>;
      const env = lcs.env as unknown as Env;
      await env.asSuperuser({ reason: 'LC margin' }, async (su) => {
        for (const lc of await su.model('trade.lc').browse(lcs.ids).load({})) {
          const margin = amountOf(lc.amount)
            .times(lc.marginPercent ?? zero)
            .div(100)
            .toDecimalPlaces(2);
          if (margin.lte(0) || lc.marginMove !== null) continue;
          const move = await post(su, {
            company: lc.company.id,
            journal: await journalOf(su, lc),
            currency: lc.currency.id,
            account: await accountOf(su, lc.company.id, 'margin'),
            partner: lc.bank.id,
            amount: margin.negated(), // out of the bank, into the margin deposit
            ref: `${lc.name} margin`,
          });
          await su.model('trade.lc').browse([lc.id]).write({ marginMove: move });
        }
      });
    },
    // The margin back, when the LC is settled or cancelled.
    closed: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const lcs = this as Records<'trade.lc'>;
      const env = lcs.env as unknown as Env;
      await env.asSuperuser({ reason: 'LC margin released' }, async (su) => {
        for (const lc of await su.model('trade.lc').browse(lcs.ids).load({})) {
          if (lc.marginMove === null || lc.marginReleaseMove !== null || lc.journal === null)
            continue;
          const margin = amountOf(lc.amount)
            .times(lc.marginPercent ?? zero)
            .div(100)
            .toDecimalPlaces(2);
          const move = await post(su, {
            company: lc.company.id,
            journal: lc.journal.id,
            currency: lc.currency.id,
            account: await accountOf(su, lc.company.id, 'margin'),
            partner: lc.bank.id,
            amount: margin,
            ref: `${lc.name} margin released`,
          });
          await su.model('trade.lc').browse([lc.id]).write({ marginReleaseMove: move });
        }
      });
    },
  },
});

export const PresentationPayment = extendModel('trade.lc.presentation', {
  fields: {
    paymentMove: f.many2one('account.move', { ondelete: 'set null', label: 'Payment entry' }),
  },
  overrides: {
    // Import: the vendor paid by the bank; export: the customer's bank paid us.
    paid: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const presentations = this as Records<'trade.lc.presentation'>;
      const env = presentations.env as unknown as Env;
      await env.asSuperuser({ reason: 'LC payment' }, async (su) => {
        for (const p of await su
          .model('trade.lc.presentation')
          .browse(presentations.ids)
          .load({ lc: { company: true } })) {
          if (p.paymentMove !== null) continue;
          const lc = p.lc;
          const counterpart =
            lc.direction === 'import' ? lc.company.accountPayable : lc.company.accountReceivable;
          if (counterpart === null)
            throw new orm.ValidationError(
              'trade.lc.presentation',
              ['state'],
              'The company has no payable or receivable account.',
              'Install a chart of accounts.',
            );
          const amount = amountOf(p.amount);
          const move = await post(su, {
            company: lc.company.id,
            journal: await journalOf(su, lc),
            currency: lc.currency.id,
            account: counterpart.id,
            partner: lc.partner.id,
            amount: lc.direction === 'import' ? amount.negated() : amount,
            ref: `${lc.name} payment`,
          });
          await su.model('trade.lc.presentation').browse([p.id]).write({ paymentMove: move });
        }
      });
    },
  },
});

/** A bank charge on an LC (commission, amendment, acceptance, SWIFT): posted to LC charges, an expense. */
export const TradeCharge = defineModel('trade.lc.charge', {
  label: 'LC charge',
  tracking: ['state', 'amount'],
  order: ['date asc', 'id asc'],
  access: {
    'trade_finance.user': ['read', 'write', 'create'],
    'trade_finance.manager': ['read', 'write', 'create', 'unlink', 'export'],
  },
  fields: {
    lc: f.many2one('trade.lc', { required: true, ondelete: 'cascade', label: 'LC' }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    name: f.char({ required: true, label: 'Charge' }),
    currency: f.many2one('res.currency', { required: true, ondelete: 'restrict' }),
    amount: f.monetary({ currency: 'currency', required: true }),
    move: f.many2one('account.move', { ondelete: 'set null', label: 'Entry' }),
    state: f.state({
      states: { draft: 'Draft', posted: 'Posted' },
      initial: 'draft',
      transitions: {
        post: {
          from: ['draft'],
          to: 'posted',
          after: records('trade.lc.charge', async (charges): Promise<void> => {
            const env = charges.env as unknown as Env;
            await env.asSuperuser({ reason: 'LC charges' }, async (su) => {
              for (const c of await su
                .model('trade.lc.charge')
                .browse(charges.ids)
                .load({ lc: true })) {
                const move = await post(su, {
                  company: c.lc.company.id,
                  journal: await journalOf(su, c.lc),
                  currency: c.currency.id,
                  account: await accountOf(su, c.lc.company.id, 'charges'),
                  partner: c.lc.bank.id,
                  amount: amountOf(c.amount).negated(),
                  ref: `${c.lc.name} ${c.name}`,
                });
                await su.model('trade.lc.charge').browse([c.id]).write({ move });
              }
            });
          }),
        },
      },
    }),
  },
});

export const tradeFinanceAccountShutro = defineModule({
  name: 'trade_finance_account',
  version: '0.1.0',
  depends: [tradeFinanceShutro, accountingShutro],
  groups: [
    orm.defineGroup({
      code: 'trade_finance_account.user',
      label: 'Trade Finance in the books',
      implies: ['trade_finance.user'],
    }),
  ],
  models: [TradeCharge],
  extensions: [LcAccounting, PresentationPayment],
});
