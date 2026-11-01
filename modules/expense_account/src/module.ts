/**
 * Spend in the books (RFC 0024 §2.1, `expense_account`): each category has its expense account; an approved report
 * is **booked** as one posted entry — each expense's amount less its tax to the category's account, the tax to the
 * tax's account; against it what the advance covered (Employee advances), what the employee paid (Employee
 * reimbursements payable) and what the company card paid (Company card clearing) — and **reimbursed** from the cash
 * or bank journal chosen on the report. An advance's payout and the cash returned at its settlement are booked from
 * its journal. Accounts and the Expenses journal are found by their codes, and made when the chart lacks them.
 */
import { accountingShutro } from '@kosh/accounting';
import { expenseShutro } from '@kosh/expense';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import { defineModule, type Env, extendModel, f, type Records, records } from './.kosh/bindings.js';

const ZERO: Decimal = orm.toDecimal(0);

/** The accounts Spend books to, by code, made when missing. */
export const EXPENSE_ACCOUNTS = {
  advances: { code: '1170', name: 'Employee advances', type: 'asset_current', reconcile: true },
  payable: {
    code: '2170',
    name: 'Employee reimbursements payable',
    type: 'liability_current',
    reconcile: true,
  },
  card: { code: '2180', name: 'Company card clearing', type: 'liability_current', reconcile: true },
  expense: { code: '6350', name: 'Staff expenses', type: 'expense', reconcile: false },
} as const;

type Accounts = Record<keyof typeof EXPENSE_ACCOUNTS, Id<'account.account'>> & {
  journal: Id<'account.journal'>;
};

/** The company's Spend accounts and the Expenses journal (`EXP`); `null` without a chart. */
export async function expenseAccountsOf(
  env: Env,
  company: Id<'res.company'>,
): Promise<Accounts | null> {
  const chart = await env.model('account.account').search({ where: { company }, limit: 1 });
  if (chart.length === 0) return null;
  const out: Partial<Accounts> = {};
  for (const [key, spec] of Object.entries(EXPENSE_ACCOUNTS)) {
    const found = (
      await env.model('account.account').search({ where: { company, code: spec.code }, limit: 1 })
    ).ids[0];
    out[key as keyof typeof EXPENSE_ACCOUNTS] =
      found ??
      ((await env.model('account.account').create([{ ...spec, company } as never]))
        .ids[0] as Id<'account.account'>);
  }
  const journal =
    (await env.model('account.journal').search({ where: { company, code: 'EXP' }, limit: 1 }))
      .ids[0] ??
    (
      await env
        .model('account.journal')
        .create([{ company, code: 'EXP', name: 'Expenses', type: 'general' } as never])
    ).ids[0];
  out.journal = journal as Id<'account.journal'>;
  return out as Accounts;
}

interface Line {
  account: Id<'account.account'>;
  debit: Decimal;
  credit: Decimal;
  name: string;
}

/** Posts one balanced entry in `journal` and returns it. */
async function post(
  env: Env,
  company: Id<'res.company'>,
  journal: Id<'account.journal'>,
  ref: string,
  lines: readonly Line[],
): Promise<Id<'account.move'>> {
  const kept = lines.filter((l) => !l.debit.isZero() || !l.credit.isZero());
  const [c] = await env.model('res.company').browse([company]).load({});
  const made = await env.model('account.move').create([
    {
      kind: 'entry',
      journal,
      company,
      currency: c?.currency.id,
      date: env.today(),
      ref,
      lines: {
        create: kept.map((l) => ({
          account: l.account,
          name: l.name,
          debit: l.debit.toDecimalPlaces(2).toString(),
          credit: l.credit.toDecimalPlaces(2).toString(),
        })),
      },
    } as never,
  ]);
  await env.withGrants({ grants: ['account.post'], reason: `Spend ${ref}` }, (e) =>
    e.model('account.move').browse(made.ids).post(),
  );
  return made.ids[0] as Id<'account.move'>;
}

const noChart = (model: string) =>
  new orm.ValidationError(
    model,
    ['state'],
    'The company has no chart of accounts yet.',
    'Install a chart in Accounting first.',
  );

/** The cash or bank journal's account. @throws {ValidationError} without one */
async function moneyAccount(
  env: Env,
  model: string,
  journal: { id: Id<'account.journal'> } | null,
): Promise<{ journal: Id<'account.journal'>; account: Id<'account.account'> }> {
  if (journal === null)
    throw new orm.ValidationError(
      model,
      ['paymentJournal'],
      'Choose the cash or bank journal it is paid from.',
      'Set “Paid from” on the record, then try again.',
    );
  const [j] = await env.model('account.journal').browse([journal.id]).load({});
  const account = j?.defaultAccount?.id;
  if (j === undefined || account === undefined || (j.type !== 'cash' && j.type !== 'bank'))
    throw new orm.ValidationError(
      model,
      ['paymentJournal'],
      'Pay from a cash or bank journal with its account.',
      'Choose a cash or bank journal (Accounting › Configuration › Journals).',
    );
  return { journal: journal.id, account };
}

/** Books approved reports: one posted entry each. */
async function bookSheets(env: Env, ids: readonly Id<'expense.sheet'>[]): Promise<void> {
  for (const s of await env
    .model('expense.sheet')
    .browse(ids)
    .load({
      expenses: { category: true, tax: true },
      company: true,
      employee: true,
    })) {
    const accounts = await expenseAccountsOf(env, s.company.id);
    if (accounts === null) throw noChart('expense.sheet');
    const lines: Line[] = [];
    let employeePaid = ZERO;
    let companyPaid = ZERO;
    for (const e of s.expenses) {
      const tax = e.taxAmount ?? ZERO;
      const account = e.category.account?.id ?? accounts.expense;
      lines.push({ account, debit: e.amount.minus(tax), credit: ZERO, name: e.name });
      if (!tax.isZero())
        lines.push({
          account: e.tax?.account?.id ?? account,
          debit: tax,
          credit: ZERO,
          name: `${e.name} (${e.tax?.name ?? 'tax'})`,
        });
      if (e.paidBy === 'company') companyPaid = companyPaid.plus(e.amount);
      else employeePaid = employeePaid.plus(e.amount);
    }
    const fromAdvance = s.advanceUsed.gt(employeePaid) ? employeePaid : s.advanceUsed;
    lines.push({
      account: accounts.advances,
      debit: ZERO,
      credit: fromAdvance,
      name: `${s.name} from the advance`,
    });
    lines.push({
      account: accounts.payable,
      debit: ZERO,
      credit: employeePaid.minus(fromAdvance),
      name: `${s.name} to reimburse ${s.employee.name}`,
    });
    lines.push({
      account: accounts.card,
      debit: ZERO,
      credit: companyPaid,
      name: `${s.name} company card`,
    });
    const entry = await post(env, s.company.id, accounts.journal, s.name, lines);
    await env
      .model('expense.sheet')
      .browse([s.id])
      .write({ entry } as never);
  }
}

/** Pays reports out: the payable cleared against the cash or bank journal. */
async function reimburseSheets(env: Env, ids: readonly Id<'expense.sheet'>[]): Promise<void> {
  for (const s of await env
    .model('expense.sheet')
    .browse(ids)
    .load({ company: true, employee: true })) {
    const accounts = await expenseAccountsOf(env, s.company.id);
    if (accounts === null) throw noChart('expense.sheet');
    const amount = s.toReimburse ?? ZERO;
    if (amount.isZero()) continue;
    const money = await moneyAccount(env, 'expense.sheet', s.paymentJournal);
    const entry = await post(env, s.company.id, money.journal, `${s.name} reimbursed`, [
      {
        account: accounts.payable,
        debit: amount,
        credit: ZERO,
        name: `${s.name} ${s.employee.name}`,
      },
      { account: money.account, debit: ZERO, credit: amount, name: `${s.name} ${s.employee.name}` },
    ]);
    await env
      .model('expense.sheet')
      .browse([s.id])
      .write({ paymentEntry: entry } as never);
  }
}

export const CategoryAccount = extendModel('expense.category', {
  fields: {
    account: f.many2one('account.account', {
      ondelete: 'restrict',
      label: 'Expense account',
      help: 'Where this category is booked; empty: Staff expenses (6350).',
    }),
  },
});

export const SheetBooks = extendModel('expense.sheet', {
  fields: {
    entry: f.many2one('account.move', { ondelete: 'restrict', label: 'Journal entry' }),
    paymentJournal: f.many2one('account.journal', {
      ondelete: 'restrict',
      label: 'Paid from',
      help: 'The cash or bank journal the reimbursement is paid from.',
    }),
    paymentEntry: f.many2one('account.move', {
      ondelete: 'restrict',
      label: 'Reimbursement entry',
    }),
  },
  fieldOverrides: {
    state: {
      statesAdd: { posted: 'Booked', paid: 'Reimbursed' },
      transitionsAdd: {
        post: {
          from: ['approved'],
          to: 'posted',
          requires: 'expense.settle',
          after: records('expense.sheet', async (sheets) => {
            const env = sheets.env as unknown as Env;
            await env.flush();
            await env.asSuperuser({ reason: 'book expense reports' }, (su) =>
              bookSheets(su, sheets.ids as readonly Id<'expense.sheet'>[]),
            );
          }),
        },
        reimburse: {
          from: ['posted'],
          to: 'paid',
          requires: 'expense.settle',
          after: records('expense.sheet', async (sheets) => {
            const env = sheets.env as unknown as Env;
            await env.flush();
            await env.asSuperuser({ reason: 'reimburse expense reports' }, (su) =>
              reimburseSheets(su, sheets.ids as readonly Id<'expense.sheet'>[]),
            );
          }),
        },
      },
    },
  },
});

export const AdvanceBooks = extendModel('expense.advance', {
  fields: {
    paymentJournal: f.many2one('account.journal', {
      ondelete: 'restrict',
      label: 'Paid from',
      help: 'The cash or bank journal the advance is paid from, and the rest returned to.',
    }),
    entry: f.many2one('account.move', { ondelete: 'restrict', label: 'Payout entry' }),
    returnEntry: f.many2one('account.move', { ondelete: 'restrict', label: 'Return entry' }),
  },
  overrides: {
    // The payout: Employee advances against the cash or bank journal.
    paidOut: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const advances = this as Records<'expense.advance'>;
      const env = advances.env as unknown as Env;
      await env.asSuperuser({ reason: 'book advance payouts' }, async (su) => {
        for (const a of await su
          .model('expense.advance')
          .browse(advances.ids)
          .load({ company: true, employee: true })) {
          const accounts = await expenseAccountsOf(su, a.company.id);
          if (accounts === null) throw noChart('expense.advance');
          const money = await moneyAccount(su, 'expense.advance', a.paymentJournal);
          const entry = await post(su, a.company.id, money.journal, `${a.name} paid out`, [
            {
              account: accounts.advances,
              debit: a.amount,
              credit: ZERO,
              name: `${a.name} ${a.employee.name}`,
            },
            {
              account: money.account,
              debit: ZERO,
              credit: a.amount,
              name: `${a.name} ${a.employee.name}`,
            },
          ]);
          await su
            .model('expense.advance')
            .browse([a.id])
            .write({ entry } as never);
        }
      });
    },
    // The settlement: what is left comes back to the cash or bank journal.
    settledOut: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const advances = this as Records<'expense.advance'>;
      const env = advances.env as unknown as Env;
      await env.asSuperuser({ reason: 'book advance returns' }, async (su) => {
        for (const a of await su
          .model('expense.advance')
          .browse(advances.ids)
          .load({ company: true, employee: true })) {
          const left = a.balance ?? ZERO;
          if (left.lte(0)) continue;
          const accounts = await expenseAccountsOf(su, a.company.id);
          if (accounts === null) throw noChart('expense.advance');
          const money = await moneyAccount(su, 'expense.advance', a.paymentJournal);
          const entry = await post(su, a.company.id, money.journal, `${a.name} returned`, [
            {
              account: money.account,
              debit: left,
              credit: ZERO,
              name: `${a.name} ${a.employee.name}`,
            },
            {
              account: accounts.advances,
              debit: ZERO,
              credit: left,
              name: `${a.name} ${a.employee.name}`,
            },
          ]);
          await su
            .model('expense.advance')
            .browse([a.id])
            .write({ returnEntry: entry } as never);
        }
      });
    },
  },
});

export const expenseAccountShutro = defineModule({
  name: 'expense_account',
  version: '0.1.0',
  depends: [expenseShutro, accountingShutro],
  groups: [
    orm.defineGroup({
      code: 'expense_account.user',
      label: 'Spend in the books',
      implies: ['expense.user'],
    }),
  ],
  models: [],
  extensions: [CategoryAccount, SheetBooks, AdvanceBooks],
});
