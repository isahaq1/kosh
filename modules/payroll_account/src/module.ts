/**
 * Payroll in the books (RFC 0024 §2.3, `payroll_account`): each rule may name its account; an approved run is
 * **booked** as one posted entry in the Payroll journal (`PAY`) — basic, allowances and company contributions to
 * their expense accounts (Salaries, 6000, by default), deductions to their payables (Payroll deductions payable,
 * 2191), contributions against Payroll contributions payable (2192), the net to Salaries payable (2190) — and its
 * **payment** clears Salaries payable against the bank or cash journal chosen on the run. A correction books only
 * its differences, line by line, against the payslips it corrects. Accounts and the journal are made when missing.
 */
import { accountingShutro } from '@kosh/accounting';
import { payrollShutro } from '@kosh/payroll';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import { defineModule, type Env, extendModel, f, type Records } from './.kosh/bindings.js';

const ZERO: Decimal = orm.toDecimal(0);

export const PAYROLL_ACCOUNTS = {
  salaries: { code: '6000', name: 'Salaries', type: 'expense', reconcile: false },
  payable: { code: '2190', name: 'Salaries payable', type: 'liability_current', reconcile: true },
  deductions: {
    code: '2191',
    name: 'Payroll deductions payable',
    type: 'liability_current',
    reconcile: true,
  },
  contributions: {
    code: '2192',
    name: 'Payroll contributions payable',
    type: 'liability_current',
    reconcile: true,
  },
} as const;

type Accounts = Record<keyof typeof PAYROLL_ACCOUNTS, Id<'account.account'>> & {
  journal: Id<'account.journal'>;
};

/** The company's payroll accounts and the Payroll journal (`PAY`); `null` without a chart. */
export async function payrollAccountsOf(
  env: Env,
  company: Id<'res.company'>,
): Promise<Accounts | null> {
  const chart = await env.model('account.account').search({ where: { company }, limit: 1 });
  if (chart.length === 0) return null;
  const out: Partial<Accounts> = {};
  for (const [key, spec] of Object.entries(PAYROLL_ACCOUNTS))
    out[key as keyof typeof PAYROLL_ACCOUNTS] =
      (await env.model('account.account').search({ where: { company, code: spec.code }, limit: 1 }))
        .ids[0] ??
      ((await env.model('account.account').create([{ ...spec, company } as never]))
        .ids[0] as Id<'account.account'>);
  out.journal = ((
    await env.model('account.journal').search({ where: { company, code: 'PAY' }, limit: 1 })
  ).ids[0] ??
    (
      await env
        .model('account.journal')
        .create([{ company, code: 'PAY', name: 'Payroll', type: 'general' } as never])
    ).ids[0]) as Id<'account.journal'>;
  return out as Accounts;
}

interface Line {
  account: Id<'account.account'>;
  debit: Decimal;
  credit: Decimal;
  name: string;
}

async function post(
  env: Env,
  company: Id<'res.company'>,
  journal: Id<'account.journal'>,
  ref: string,
  lines: readonly Line[],
): Promise<Id<'account.move'> | null> {
  const kept = lines
    .map((l) => {
      // A negative amount on one side is a positive one on the other.
      const net = l.debit.minus(l.credit);
      return { ...l, debit: net.gt(0) ? net : ZERO, credit: net.lt(0) ? net.neg() : ZERO };
    })
    .filter((l) => !l.debit.isZero() || !l.credit.isZero());
  if (kept.length === 0) return null;
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
  await env.withGrants({ grants: ['account.post'], reason: `payroll ${ref}` }, (e) =>
    e.model('account.move').browse(made.ids).post(),
  );
  return made.ids[0] as Id<'account.move'>;
}

const noChart = () =>
  new orm.ValidationError(
    'payroll.run',
    ['state'],
    'The company has no chart of accounts yet.',
    'Install a chart in Accounting first.',
  );

/** Each payslip's line amounts by rule (a correction: less the corrected payslip's), with the rule's account. */
async function amountsOf(env: Env, runId: Id<'payroll.run'>) {
  const [run] = await env
    .model('payroll.run')
    .browse([runId])
    .load({ company: true, correctionOf: true });
  if (run === undefined) return null;
  const linesOf = async (where: Record<string, unknown>) => [
    ...(await (
      await env.model('payroll.slip.line').search({ where: where as never })
    ).load({ rule: true, slip: true })),
  ];
  const current = await linesOf({ 'slip.run': run.id });
  const before =
    run.correctionOf === null ? [] : await linesOf({ 'slip.run': run.correctionOf.id });
  const key = (l: (typeof current)[number]) => `${l.slip.employee.id}:${l.code}`;
  const out = new Map<
    string,
    { category: string; name: string; account: number | null; amount: Decimal }
  >();
  for (const l of current)
    out.set(key(l), {
      category: l.category,
      name: l.name,
      account: l.rule?.account?.id ?? null,
      amount: (out.get(key(l))?.amount ?? ZERO).plus(l.amount),
    });
  for (const l of before) {
    const slot = out.get(key(l)) ?? {
      category: l.category,
      name: l.name,
      account: l.rule?.account?.id ?? null,
      amount: ZERO,
    };
    slot.amount = slot.amount.minus(l.amount);
    out.set(key(l), slot);
  }
  return { run, amounts: [...out.values()] };
}

export const RuleAccount = extendModel('payroll.rule', {
  fields: {
    account: f.many2one('account.account', {
      ondelete: 'restrict',
      label: 'Account',
      help: 'Basic, allowances and contributions: the expense; deductions: the payable. Empty: Salaries (6000) or Payroll deductions payable (2191).',
    }),
  },
});

export const RunBooks = extendModel('payroll.run', {
  fields: {
    entry: f.many2one('account.move', { ondelete: 'restrict', label: 'Journal entry' }),
    paymentJournal: f.many2one('account.journal', {
      ondelete: 'restrict',
      label: 'Paid from',
      help: 'The bank or cash journal the net pay leaves from.',
    }),
    paymentEntry: f.many2one('account.move', { ondelete: 'restrict', label: 'Payment entry' }),
  },
  overrides: {
    approvedOut: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const runs = this as Records<'payroll.run'>;
      const env = runs.env as unknown as Env;
      await env.asSuperuser({ reason: 'book payroll' }, async (su) => {
        for (const id of runs.ids) {
          const found = await amountsOf(su, id as Id<'payroll.run'>);
          if (found === null) continue;
          const accounts = await payrollAccountsOf(su, found.run.company.id);
          if (accounts === null) throw noChart();
          const lines: Line[] = [];
          let net = ZERO;
          let contributions = ZERO;
          for (const a of found.amounts) {
            if (a.category === 'info' || a.amount.isZero()) continue;
            if (a.category === 'deduction') {
              lines.push({
                account: (a.account as Id<'account.account'> | null) ?? accounts.deductions,
                debit: ZERO,
                credit: a.amount,
                name: a.name,
              });
              net = net.minus(a.amount);
            } else {
              lines.push({
                account: (a.account as Id<'account.account'> | null) ?? accounts.salaries,
                debit: a.amount,
                credit: ZERO,
                name: a.name,
              });
              if (a.category === 'contribution') contributions = contributions.plus(a.amount);
              else net = net.plus(a.amount);
            }
          }
          lines.push({
            account: accounts.contributions,
            debit: ZERO,
            credit: contributions,
            name: `${found.run.name} contributions`,
          });
          lines.push({
            account: accounts.payable,
            debit: ZERO,
            credit: net,
            name: `${found.run.name} net pay`,
          });
          // Same accounts and names summed: one line each.
          const merged = new Map<string, Line>();
          for (const l of lines) {
            const k = `${l.account}:${l.name}`;
            const m = merged.get(k);
            if (m === undefined) merged.set(k, { ...l });
            else {
              m.debit = m.debit.plus(l.debit);
              m.credit = m.credit.plus(l.credit);
            }
          }
          const entry = await post(su, found.run.company.id, accounts.journal, found.run.name, [
            ...merged.values(),
          ]);
          if (entry !== null)
            await su
              .model('payroll.run')
              .browse([found.run.id])
              .write({ entry } as never);
        }
      });
    },
    paidOut: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const runs = this as Records<'payroll.run'>;
      const env = runs.env as unknown as Env;
      await env.asSuperuser({ reason: 'pay payroll' }, async (su) => {
        for (const run of await su
          .model('payroll.run')
          .browse(runs.ids)
          .load({ company: true, slips: true })) {
          const accounts = await payrollAccountsOf(su, run.company.id);
          if (accounts === null) throw noChart();
          if (run.paymentJournal === null)
            throw new orm.ValidationError(
              'payroll.run',
              ['paymentJournal'],
              'Choose the bank or cash journal the pay leaves from.',
              'Set “Paid from” on the run, then mark it as paid.',
            );
          const [j] = await su.model('account.journal').browse([run.paymentJournal.id]).load({});
          const money = j?.defaultAccount?.id;
          if (j === undefined || money === undefined || (j.type !== 'bank' && j.type !== 'cash'))
            throw new orm.ValidationError(
              'payroll.run',
              ['paymentJournal'],
              'Pay from a bank or cash journal with its account.',
              'Choose a bank or cash journal.',
            );
          const total = [...run.slips].reduce(
            (s, x) => s.plus(run.kind === 'correction' ? (x.difference ?? ZERO) : x.net),
            ZERO,
          );
          const entry = await post(su, run.company.id, run.paymentJournal.id, `${run.name} paid`, [
            { account: accounts.payable, debit: total, credit: ZERO, name: `${run.name} net pay` },
            { account: money, debit: ZERO, credit: total, name: `${run.name} net pay` },
          ]);
          if (entry !== null)
            await su
              .model('payroll.run')
              .browse([run.id])
              .write({ paymentEntry: entry } as never);
        }
      });
    },
  },
});

export const payrollAccountShutro = defineModule({
  name: 'payroll_account',
  version: '0.1.0',
  depends: [payrollShutro, accountingShutro],
  groups: [
    orm.defineGroup({
      code: 'payroll_account.user',
      label: 'Payroll in the books',
      implies: ['payroll.user'],
    }),
  ],
  models: [],
  extensions: [RuleAccount, RunBooks],
});
