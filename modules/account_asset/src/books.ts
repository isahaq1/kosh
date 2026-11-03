/**
 * Fixed assets in the books (RFC 0024 §2.5): the board planned on confirmation and after a revaluation, the lines due
 * posted once each (Depreciation expense against Accumulated depreciation, in the category's journal, with the
 * asset's cost centre), units of production from each month's usage, disposal or sale with its gain or loss,
 * revaluation and impairment, draft assets from posted bills, and the tax book beside the accounting book.
 */
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { board, taxBook, unitsLine } from './board.js';

const ZERO: Decimal = orm.toDecimal(0);

/** A date-only value as `YYYY-MM-DD` (PostgreSQL dates read as local midnights). */
export function isoDate(v: unknown): string {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}
const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

interface Line {
  account: Id<'account.account'>;
  debit: Decimal;
  credit: Decimal;
  name: string;
  analytic?: number | null;
}

async function post(
  env: Env,
  company: Id<'res.company'>,
  journal: Id<'account.journal'>,
  date: string,
  ref: string,
  lines: readonly Line[],
): Promise<Id<'account.move'>> {
  const [c] = await env.model('res.company').browse([company]).load({});
  const made = await env.model('account.move').create([
    {
      kind: 'entry',
      journal,
      company,
      currency: c?.currency.id,
      date,
      ref,
      lines: {
        create: lines
          .filter((l) => !l.debit.isZero() || !l.credit.isZero())
          .map((l) => ({
            account: l.account,
            name: l.name,
            analytic: l.analytic ?? null,
            debit: l.debit.toDecimalPlaces(2).toString(),
            credit: l.credit.toDecimalPlaces(2).toString(),
          })),
      },
    } as never,
  ]);
  await env.withGrants({ grants: ['account.post'], reason: `asset ${ref}` }, (e) =>
    e.model('account.move').browse(made.ids).post(),
  );
  return made.ids[0] as Id<'account.move'>;
}

/** An account of the company by code, made when missing. */
async function accountByCode(
  env: Env,
  company: Id<'res.company'>,
  spec: { code: string; name: string; type: string },
): Promise<Id<'account.account'>> {
  return ((
    await env.model('account.account').search({ where: { company, code: spec.code }, limit: 1 })
  ).ids[0] ??
    (await env.model('account.account').create([{ ...spec, company } as never]))
      .ids[0]) as Id<'account.account'>;
}

/** Plans (again) the boards of the assets: what is not posted yet is replaced, from what remains. */
export async function planBoard(env: Env, ids: readonly number[]): Promise<void> {
  for (const a of await env
    .model('account.asset')
    .browse(ids as never)
    .load({ lines: true })) {
    const planned = [...a.lines].filter((l) => !l.posted).map((l) => l.id);
    if (planned.length > 0) await env.model('account.asset.line').browse(planned).unlink();
    const posted = [...a.lines]
      .filter((l) => l.posted)
      .sort((x, y) => isoDate(x.date).localeCompare(isoDate(y.date)));
    const months = posted.filter((l) => l.kind === 'depreciation').length;
    const revalued = posted
      .filter((l) => l.kind === 'revaluation')
      .reduce((s, l) => s.plus(l.amount), ZERO);
    const lowered = posted
      .filter((l) => l.kind === 'depreciation' || l.kind === 'impairment')
      .reduce((s, l) => s.plus(l.amount), ZERO);
    const last = posted.filter((l) => l.kind === 'depreciation').at(-1);
    const lines = board({
      bookValue: a.value.plus(revalued).minus(lowered),
      salvage: a.salvage,
      method: a.method,
      months: a.lifeMonths - months,
      rate: a.rate ?? ZERO,
      from: last === undefined ? isoDate(a.dateInUse) : nextDay(isoDate(last.date)),
      prorata: last === undefined && a.prorata,
    });
    if (lines.length > 0)
      await env.model('account.asset.line').create(
        lines.map((l) => ({
          asset: a.id,
          date: l.date,
          kind: 'depreciation',
          amount: l.amount.toString(),
        })) as never,
      );
  }
  await env.flush();
}

/** Posts every running asset's lines due on or before `upTo` (units of production: from the usage); returns how many. */
export async function postDue(env: Env, upTo: string, only?: readonly number[]): Promise<number> {
  let count = 0;
  const assets = await (
    await env.model('account.asset').search({
      where: { state: 'running', ...(only === undefined ? {} : { id: { in: only as never } }) },
    })
  ).load({ category: true, lines: true, usage: true });
  for (const a of assets) {
    // Units of production: a line for each month's usage not depreciated yet.
    if (a.method === 'units') {
      let depreciated = [...a.lines]
        .filter((l) => l.kind === 'depreciation')
        .reduce((s, l) => s.plus(l.amount), ZERO);
      for (const u of [...a.usage].filter((u) => u.line === null && isoDate(u.date) <= upTo)) {
        const amount = unitsLine({
          cost: a.value,
          salvage: a.salvage,
          totalUnits: a.totalUnits ?? ZERO,
          units: u.units,
          depreciated,
        });
        if (amount.lte(0)) continue;
        const made = await env.model('account.asset.line').create([
          {
            asset: a.id,
            date: isoDate(u.date),
            kind: 'depreciation',
            amount: amount.toString(),
          } as never,
        ]);
        await env
          .model('account.asset.usage')
          .browse([u.id])
          .write({ line: made.ids[0] } as never);
        depreciated = depreciated.plus(amount);
      }
      await env.flush();
    }
    const due = [
      ...(await (
        await env.model('account.asset.line').search({
          where: { asset: a.id, kind: 'depreciation', posted: false, date: { lte: upTo } },
          order: ['date asc'],
        })
      ).load(['date', 'amount'])),
    ];
    for (const l of due) {
      const move = await post(
        env,
        a.company.id,
        a.category.journal.id,
        isoDate(l.date),
        `${a.name} depreciation`,
        [
          {
            account: a.category.expenseAccount.id,
            debit: l.amount,
            credit: ZERO,
            name: a.name,
            analytic: a.analytic?.id ?? null,
          },
          {
            account: a.category.accumulatedAccount.id,
            debit: ZERO,
            credit: l.amount,
            name: a.name,
          },
        ],
      );
      await env
        .model('account.asset.line')
        .browse([l.id])
        .write({ posted: true, move } as never);
      count += 1;
    }
    await env.flush();
    // Fully depreciated: nothing left above the salvage value and nothing planned.
    const [now] = await env.model('account.asset').browse([a.id]).load({ lines: true });
    if (
      now !== undefined &&
      a.method !== 'units' &&
      [...now.lines].every((l) => l.posted) &&
      (now.bookValue ?? ZERO).lte(now.salvage)
    )
      await env.model('account.asset').browse([a.id]).close();
  }
  await env.flush();
  return count;
}

/** Disposes of (or sells) an asset on `date`: depreciation up to then, the asset out, the gain or loss booked. */
export async function dispose(
  env: Env,
  id: number,
  input: { readonly date: string; readonly proceeds: Decimal; readonly account: number | null },
): Promise<Id<'account.move'>> {
  await postDue(env, input.date, [id]);
  const [a] = await env
    .model('account.asset')
    .browse([id as never])
    .load({ category: true, lines: true });
  if (a === undefined || a.state !== 'running')
    throw new orm.ValidationError(
      'account.asset',
      ['state'],
      'Only a running asset is disposed of.',
      'Confirm the asset first.',
    );
  if (input.proceeds.gt(0) && input.account === null)
    throw new orm.ValidationError(
      'account.asset',
      ['proceeds'],
      'Say where the sale’s proceeds go.',
      'Choose the receivable or bank account of the sale.',
    );
  const revalued = [...a.lines]
    .filter((l) => l.posted && l.kind === 'revaluation')
    .reduce((s, l) => s.plus(l.amount), ZERO);
  const cost = a.value.plus(revalued);
  const depreciated = a.depreciated ?? ZERO;
  const book = cost.minus(depreciated);
  const result = input.proceeds.minus(book);
  const gain =
    a.category.gainAccount?.id ??
    (await accountByCode(env, a.company.id, {
      code: '4900',
      name: 'Other income',
      type: 'income_other',
    }));
  const loss = a.category.lossAccount?.id ?? a.category.expenseAccount.id;
  const lines: Line[] = [
    {
      account: a.category.accumulatedAccount.id,
      debit: depreciated,
      credit: ZERO,
      name: `${a.name} disposed`,
    },
    { account: a.category.assetAccount.id, debit: ZERO, credit: cost, name: `${a.name} disposed` },
  ];
  if (input.proceeds.gt(0) && input.account !== null)
    lines.push({
      account: input.account as Id<'account.account'>,
      debit: input.proceeds,
      credit: ZERO,
      name: `${a.name} sold`,
    });
  if (result.gt(0))
    lines.push({ account: gain, debit: ZERO, credit: result, name: `${a.name} gain on disposal` });
  if (result.lt(0))
    lines.push({
      account: loss,
      debit: result.neg(),
      credit: ZERO,
      name: `${a.name} loss on disposal`,
    });
  const move = await post(
    env,
    a.company.id,
    a.category.journal.id,
    input.date,
    `${a.name} disposal`,
    lines,
  );
  const planned = [...a.lines].filter((l) => !l.posted).map((l) => l.id);
  if (planned.length > 0) await env.model('account.asset.line').browse(planned).unlink();
  await env.model('account.asset.line').create([
    {
      asset: a.id,
      date: input.date,
      kind: 'disposal',
      amount: book.toString(),
      posted: true,
      move,
    } as never,
  ]);
  await env
    .model('account.asset')
    .browse([a.id])
    .write({ disposedOn: input.date, proceeds: input.proceeds.toString() } as never);
  await env.flush();
  await env.model('account.asset').browse([a.id]).dispose();
  await env.flush();
  await env.emit('account.asset.disposed', { id: a.id, proceeds: input.proceeds.toString() });
  return move;
}

/** Revalues an asset to `value` on `date` (an impairment when lower); the rest of its board planned again. */
export async function revalue(
  env: Env,
  id: number,
  input: { readonly date: string; readonly value: Decimal },
): Promise<Id<'account.move'>> {
  await postDue(env, input.date, [id]);
  const [a] = await env
    .model('account.asset')
    .browse([id as never])
    .load({ category: true });
  if (a === undefined || a.state !== 'running')
    throw new orm.ValidationError(
      'account.asset',
      ['state'],
      'Only a running asset is revalued.',
      'Confirm the asset first.',
    );
  const diff = input.value.minus(a.bookValue ?? ZERO);
  if (diff.isZero())
    throw new orm.ValidationError(
      'account.asset',
      ['value'],
      'That is its book value already.',
      'Give the new value.',
    );
  let move: Id<'account.move'>;
  if (diff.lt(0)) {
    const loss = a.category.lossAccount?.id ?? a.category.expenseAccount.id;
    move = await post(
      env,
      a.company.id,
      a.category.journal.id,
      input.date,
      `${a.name} impairment`,
      [
        {
          account: loss,
          debit: diff.neg(),
          credit: ZERO,
          name: `${a.name} impairment`,
          analytic: a.analytic?.id ?? null,
        },
        {
          account: a.category.accumulatedAccount.id,
          debit: ZERO,
          credit: diff.neg(),
          name: `${a.name} impairment`,
        },
      ],
    );
  } else {
    const surplus = await accountByCode(env, a.company.id, {
      code: '3150',
      name: 'Revaluation surplus',
      type: 'equity',
    });
    move = await post(
      env,
      a.company.id,
      a.category.journal.id,
      input.date,
      `${a.name} revaluation`,
      [
        {
          account: a.category.assetAccount.id,
          debit: diff,
          credit: ZERO,
          name: `${a.name} revaluation`,
        },
        { account: surplus, debit: ZERO, credit: diff, name: `${a.name} revaluation` },
      ],
    );
  }
  await env.model('account.asset.line').create([
    {
      asset: a.id,
      date: input.date,
      kind: diff.lt(0) ? 'impairment' : 'revaluation',
      amount: diff.abs().toString(),
      posted: true,
      move,
    } as never,
  ]);
  await env.flush();
  await planBoard(env, [a.id]);
  return move;
}

/** A posted bill's lines on an asset category's asset account become draft assets, once each. */
export async function assetsFromBill(env: Env, moveId: number): Promise<number> {
  const [bill] = await env
    .model('account.move')
    .browse([moveId as never])
    .load({ lines: true, partner: true });
  if (bill === undefined || bill.kind !== 'in_invoice' || bill.state !== 'posted') return 0;
  const categories = [
    ...(await (
      await env.model('account.asset.category').search({ where: { company: bill.company.id } })
    ).load({
      assetAccount: true,
    })),
  ];
  let made = 0;
  for (const l of bill.lines) {
    const category = categories.find((c) => c.assetAccount.id === l.account?.id);
    if (category === undefined || l.debit.amount.lte(0)) continue;
    if (
      (await env.model('account.asset').search({ where: { billLine: l.id }, limit: 1 })).length > 0
    )
      continue;
    await env.model('account.asset').create([
      {
        name: l.name ?? `${bill.name} line`,
        category: category.id,
        partner: bill.partner?.id ?? null,
        bill: bill.id,
        billLine: l.id,
        analytic: l.analytic?.id ?? null,
        company: bill.company.id,
        value: l.debit.amount.toString(),
        dateAcquired: isoDate(bill.date),
        dateInUse: isoDate(bill.date),
        method: category.method,
        lifeMonths: category.lifeMonths,
        rate: category.rate?.toString() ?? null,
        prorata: category.prorata,
      } as never,
    ]);
    made += 1;
  }
  await env.flush();
  return made;
}

/** The first day of the company's fiscal year that contains `date`. */
function fiscalYearOf(date: string, startMonth: number): number {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return m >= startMonth ? y : y - 1;
}

export interface TaxBookRow {
  readonly asset: number;
  readonly name: string;
  readonly category: string;
  readonly rate: string;
  readonly opening: string;
  readonly taxDepreciation: string;
  readonly closing: string;
  readonly bookDepreciation: string;
  readonly bookValue: string;
  /** The book value less the tax value at the year's end: the temporary difference for deferred tax. */
  readonly difference: string;
}

/** The tax book of the fiscal year starting in `year` beside the accounting book, asset by asset. */
export async function taxBookOf(env: Env, year: number): Promise<TaxBookRow[]> {
  const [company] = await env
    .model('res.company')
    .browse([env.companyId as never])
    .load(['fiscalYearStart']);
  const start = Number(company?.fiscalYearStart ?? 1);
  const from = `${year}-${String(start).padStart(2, '0')}-01`;
  const to = new Date(Date.UTC(year + 1, start - 1, 0)).toISOString().slice(0, 10);
  const rows: TaxBookRow[] = [];
  for (const a of await (
    await env
      .model('account.asset')
      .search({ where: { state: { ne: 'draft' }, dateAcquired: { lte: to } } })
  ).load({ category: true, lines: true })) {
    if (a.disposedOn !== null && isoDate(a.disposedOn) < from) continue;
    const rate = a.category.taxRate ?? ZERO;
    const years = taxBook({
      cost: a.value,
      rate,
      acquiredYear: fiscalYearOf(isoDate(a.dateAcquired), start),
      throughYear: year,
    });
    const row = years.at(-1);
    if (row === undefined) continue;
    const inYear = [...a.lines].filter(
      (l) => l.kind === 'depreciation' && isoDate(l.date) >= from && isoDate(l.date) <= to,
    );
    const upTo = [...a.lines].filter((l) => isoDate(l.date) <= to);
    const lowered = upTo
      .filter((l) => l.kind === 'depreciation' || l.kind === 'impairment')
      .reduce((s, l) => s.plus(l.amount), ZERO);
    const raised = upTo
      .filter((l) => l.kind === 'revaluation')
      .reduce((s, l) => s.plus(l.amount), ZERO);
    const book = a.value.plus(raised).minus(lowered);
    rows.push({
      asset: a.id,
      name: a.name,
      category: a.category.name,
      rate: rate.toString(),
      opening: row.opening.toFixed(2),
      taxDepreciation: row.depreciation.toFixed(2),
      closing: row.closing.toFixed(2),
      bookDepreciation: inYear.reduce((s, l) => s.plus(l.amount), ZERO).toFixed(2),
      bookValue: book.toFixed(2),
      difference: book.minus(row.closing).toFixed(2),
    });
  }
  return rows;
}
