/**
 * Year closing, the accounting settings and the aging report (RFC 0009 §5.5, §6). Closing a fiscal year checks
 * that nothing is left in draft, posts the transfer of the year's income and expenses to retained earnings
 * (one entry in the miscellaneous journal, dated the year's end), marks the year closed and moves the company's
 * lock date to its end. Reopening (managers, with a reason) reverses that entry. The aging report buckets the
 * open receivable or payable lines by days overdue at a date, per partner, in SQL.
 */
import { HttpProblem } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { reverseMove } from './index.js';
import { type AccountType, addDays } from './module.js';

const PL_TYPES: readonly AccountType[] = [
  'income',
  'income_other',
  'expense',
  'expense_direct_cost',
  'expense_depreciation',
];

function needs(env: Env, permission: string, what: string): void {
  if (!env.access.has(permission))
    throw new HttpProblem(
      403,
      'access',
      'Forbidden',
      `${what} needs the ${permission} permission.`,
      'Ask for the Accounting manager access level.',
    );
}

export interface Closed {
  readonly id: number;
  readonly state: 'closed';
  readonly lockDate: string;
  /** The transfer entry (none when the year had no income or expense). */
  readonly closingMove: number | null;
  readonly result: string;
}

/** Closes a fiscal year: no drafts left, the P&L transferred to retained earnings, the lock date at its end. */
export async function closeFiscalYear(env: Env, id: number): Promise<Closed> {
  needs(env, 'account.close', 'Closing a year');
  const years = env.model('account.fiscal.year');
  const [year] = await years
    .browse([orm.asId(id, 'account.fiscal.year')])
    .load({ company: { currency: true, accountRetainedEarnings: true } });
  if (year === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', `There is no fiscal year ${id}.`);
  if (year.state === 'closed')
    throw new HttpProblem(409, 'already-closed', 'Already closed', `${year.name} is closed.`);
  const company = year.company;
  const drafts = await env.model('account.move').search({
    where: {
      company: company.id,
      date: { gte: year.dateFrom, lte: year.dateTo },
      state: { in: ['draft', 'to_approve'] },
    },
  });
  if (drafts.length > 0)
    throw new HttpProblem(
      409,
      'drafts-left',
      'Entries still in draft',
      `${drafts.length} entry(ies) of ${year.name} are not posted or cancelled.`,
      'Post or cancel them first.',
    );
  const retained = company.accountRetainedEarnings;
  if (retained === null)
    throw new HttpProblem(
      409,
      'no-retained-earnings',
      'No retained earnings account',
      'The company has no retained earnings account.',
      'Install a chart of accounts, or set it on the company.',
    );
  // The year's income and expense balances per account (posted lines, this company).
  const all = await env.sql<{ account_id: number; account_type: string; balance: Decimal }>`
    SELECT l.account_id, l.account_type, SUM(l.balance) AS balance
    FROM account_move_line l JOIN account_move m ON m.id = l.move_id
    WHERE l.posted AND m.company_id = ${company.id} AND l.date >= ${year.dateFrom} AND l.date <= ${year.dateTo}
    GROUP BY l.account_id, l.account_type HAVING SUM(l.balance) <> 0 ORDER BY l.account_id`;
  const rows = all.filter((r) => (PL_TYPES as readonly string[]).includes(r.account_type));
  let closingMove: number | null = null;
  let net = orm.toDecimal(0);
  if (rows.length > 0) {
    const journal = await env
      .model('account.journal')
      .search({ where: { company: company.id, type: 'general' }, limit: 1 });
    const journalId = journal.ids[0];
    if (journalId === undefined)
      throw new HttpProblem(
        409,
        'no-journal',
        'No miscellaneous journal',
        'The company has no miscellaneous journal.',
      );
    const lines: { account: number; name: string; debit: string; credit: string }[] = [];
    for (const r of rows) {
      const b = orm.toDecimal(r.balance);
      net = net.plus(b);
      // A debit balance (expense) is closed by a credit, a credit balance (income) by a debit.
      lines.push(
        b.gt(0)
          ? {
              account: r.account_id,
              name: `Closing ${year.name}`,
              debit: '0',
              credit: b.toString(),
            }
          : {
              account: r.account_id,
              name: `Closing ${year.name}`,
              debit: b.abs().toString(),
              credit: '0',
            },
      );
    }
    // Retained earnings take the net: a net credit (profit) is a credit there.
    lines.push(
      net.gt(0)
        ? { account: retained.id, name: `Result ${year.name}`, debit: net.toString(), credit: '0' }
        : {
            account: retained.id,
            name: `Result ${year.name}`,
            debit: '0',
            credit: net.abs().toString(),
          },
    );
    const created = await env.model('account.move').create([
      {
        journal: journalId,
        date: year.dateTo,
        kind: 'entry',
        currency: company.currency.id,
        company: company.id,
        ref: `Closing ${year.name}`,
        lines: {
          create: lines.map((l) => ({ ...l, account: orm.asId(l.account, 'account.account') })),
        },
      },
    ]);
    await env.withGrants({ grants: ['account.post'], reason: `close ${year.name}` }, (e) =>
      e.model('account.move').browse(created.ids).post(),
    );
    closingMove = created.ids[0] as number;
  }
  await years.browse([year.id]).write({
    state: 'closed',
    lockDate: year.dateTo,
    closingMove: closingMove === null ? null : orm.asId(closingMove, 'account.move'),
  });
  // The company's lock date never goes back.
  await env.asSuperuser({ reason: `close fiscal year ${year.name}` }, async (su) => {
    const [c] = await su.model('res.company').browse([company.id]).load({});
    if (c !== undefined && (c.lockDate === null || c.lockDate < year.dateTo))
      await su.model('res.company').browse([company.id]).write({ lockDate: year.dateTo });
  });
  return { id, state: 'closed', lockDate: year.dateTo, closingMove, result: net.neg().toString() };
}

/** Reopens a closed year (managers, with a reason): the transfer entry reversed, the lock date before the year. */
export async function reopenFiscalYear(
  env: Env,
  id: number,
  reason: string,
): Promise<{ id: number; state: 'open' }> {
  needs(env, 'account.close', 'Reopening a year');
  if (reason.trim() === '')
    throw new HttpProblem(
      400,
      'invalid-body',
      'Invalid request',
      'A reason is required to reopen a year.',
    );
  const years = env.model('account.fiscal.year');
  const [year] = await years
    .browse([orm.asId(id, 'account.fiscal.year')])
    .load({ closingMove: true, company: true });
  if (year === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', `There is no fiscal year ${id}.`);
  if (year.state !== 'closed')
    throw new HttpProblem(409, 'not-closed', 'Not closed', `${year.name} is open.`);
  // The lock date steps back first, so the reversal (dated today, after the year) and later entries can post.
  await env.asSuperuser({ reason: `reopen fiscal year ${year.name}: ${reason}` }, async (su) => {
    const [c] = await su.model('res.company').browse([year.company.id]).load({});
    if (c !== undefined && c.lockDate !== null && c.lockDate >= year.dateFrom)
      await su
        .model('res.company')
        .browse([year.company.id])
        .write({ lockDate: addDays(year.dateFrom, -1) });
  });
  await years.browse([year.id]).write({ state: 'open', lockDate: null, reopenReason: reason });
  if (year.closingMove !== null && year.closingMove.reversedBy === null)
    await reverseMove(env, year.closingMove.id, { post: true });
  return { id, state: 'open' };
}

export interface Settings {
  readonly chartTemplate: string | null;
  readonly lockDate: string | null;
  readonly taxLockDate: string | null;
  /** Where the company is registered (ISO 3166 / 3166-2): taxes split by place of supply compare against it. */
  readonly country: string | null;
  readonly state: string | null;
  readonly accounts: Readonly<Record<string, number | null>>;
}

export async function readSettings(env: Env): Promise<Settings> {
  const [c] = await env.model('res.company').browse([env.companyRef]).load({});
  return {
    chartTemplate: c?.chartTemplate ?? null,
    lockDate: c?.lockDate ?? null,
    taxLockDate: c?.taxLockDate ?? null,
    country: c?.country ?? null,
    state: c?.state ?? null,
    accounts: {
      receivable: c?.accountReceivable?.id ?? null,
      payable: c?.accountPayable?.id ?? null,
      exchangeGain: c?.accountExchangeGain?.id ?? null,
      exchangeLoss: c?.accountExchangeLoss?.id ?? null,
      retainedEarnings: c?.accountRetainedEarnings?.id ?? null,
    },
  };
}

/** The lock dates, the company's country and state (managers). */
export async function updateSettings(
  env: Env,
  input: {
    readonly lockDate?: string | null;
    readonly taxLockDate?: string | null;
    readonly country?: string | null;
    readonly state?: string | null;
  },
): Promise<Settings> {
  needs(env, 'account.settings', 'Changing the accounting settings');
  await env.asSuperuser({ reason: 'accounting settings' }, (su) =>
    su
      .model('res.company')
      .browse([env.companyRef])
      .write({
        ...(input.lockDate === undefined ? {} : { lockDate: input.lockDate }),
        ...(input.taxLockDate === undefined ? {} : { taxLockDate: input.taxLockDate }),
        ...(input.country === undefined ? {} : { country: input.country }),
        ...(input.state === undefined ? {} : { state: input.state }),
      }),
  );
  return readSettings(env);
}

export interface AgingRow {
  readonly partner: number | null;
  readonly name: string;
  readonly notDue: string;
  readonly d30: string;
  readonly d60: string;
  readonly d90: string;
  readonly older: string;
  readonly total: string;
}

/** Open receivable or payable amounts per partner, in buckets of days overdue at `date` (company currency). */
export async function agingReport(
  env: Env,
  input: { readonly type: 'receivable' | 'payable'; readonly date?: string | undefined },
): Promise<{ date: string; rows: AgingRow[]; total: AgingRow }> {
  const date = input.date ?? env.today();
  const accountType = input.type === 'receivable' ? 'asset_receivable' : 'liability_payable';
  const sign = input.type === 'receivable' ? 1 : -1;
  const rows = await env.sql<Record<string, unknown>>`
    SELECT l.partner_id, p.name,
      SUM(CASE WHEN COALESCE(l.date_maturity, l.date) > ${date}::date THEN l.amount_residual ELSE 0 END) AS not_due,
      SUM(CASE WHEN ${date}::date - COALESCE(l.date_maturity, l.date) BETWEEN 0 AND 30 THEN l.amount_residual ELSE 0 END) AS d30,
      SUM(CASE WHEN ${date}::date - COALESCE(l.date_maturity, l.date) BETWEEN 31 AND 60 THEN l.amount_residual ELSE 0 END) AS d60,
      SUM(CASE WHEN ${date}::date - COALESCE(l.date_maturity, l.date) BETWEEN 61 AND 90 THEN l.amount_residual ELSE 0 END) AS d90,
      SUM(CASE WHEN ${date}::date - COALESCE(l.date_maturity, l.date) > 90 THEN l.amount_residual ELSE 0 END) AS older,
      SUM(l.amount_residual) AS total
    FROM account_move_line l
      JOIN account_move m ON m.id = l.move_id
      LEFT JOIN res_partner p ON p.id = l.partner_id
    WHERE l.posted AND NOT l.reconciled AND l.account_type = ${accountType} AND m.company_id = ${env.companyId}
      AND l.date <= ${date}::date
    GROUP BY l.partner_id, p.name
    ORDER BY p.name NULLS LAST`;
  const num = (v: unknown) =>
    orm
      .toDecimal((v as Decimal | string | number | null) ?? 0)
      .times(sign)
      .toFixed(2);
  const out: AgingRow[] = rows.map((r) => ({
    partner: (r['partner_id'] as number | null) ?? null,
    name: String(r['name'] ?? '—'),
    notDue: num(r['not_due']),
    d30: num(r['d30']),
    d60: num(r['d60']),
    d90: num(r['d90']),
    older: num(r['older']),
    total: num(r['total']),
  }));
  const sum = (key: keyof AgingRow) =>
    out.reduce((n, r) => n.plus(r[key] as string), orm.toDecimal(0)).toFixed(2);
  return {
    date,
    rows: out,
    total: {
      partner: null,
      name: 'Total',
      notDue: sum('notDue'),
      d30: sum('d30'),
      d60: sum('d60'),
      d90: sum('d90'),
      older: sum('older'),
      total: sum('total'),
    },
  };
}
