/**
 * Budgets against the books (RFC 0024 §2.5): each approved line's **actual** — the posted journal lines of the
 * budget's period on its account (every expense account when none) and cost centre (every one when none), debit
 * less credit — and **committed** — the untaxed lines of confirmed purchase orders of the period with its cost centre
 * that are not billed yet (lines without an account, or on the purchases journal's account). A purchase order
 * submitted is checked against the lines it touches: beyond a **block** line it is refused with the shortfall; beyond
 * a **warn** line it is marked `overBudget`, which brings an Accounting manager's approval.
 */
import { type Decimal, orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';

const ZERO: Decimal = orm.toDecimal(0);
const EXPENSES = ['expense', 'expense_direct_cost', 'expense_depreciation'];

/** A date-only value as `YYYY-MM-DD` (PostgreSQL dates read as local midnights). */
function isoDate(v: unknown): string {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

interface LineScope {
  readonly from: string;
  readonly to: string;
  readonly analytic: number | null;
  readonly account: number | null;
  readonly company: number;
}

/** Whether purchase orders commit against a line: no account, or the company's purchases account. */
async function commitsOn(env: Env, line: LineScope): Promise<boolean> {
  if (line.account === null) return true;
  const [journal] = await (
    await env
      .model('account.journal')
      .search({ where: { company: line.company as never, type: 'purchase' }, limit: 1 })
  ).load({});
  return journal?.defaultAccount?.id === line.account;
}

async function actualOf(env: Env, line: LineScope): Promise<Decimal> {
  const found = await env.model('account.move.line').search({
    where: {
      posted: true,
      'move.company': line.company,
      date: { gte: line.from, lte: line.to },
      ...(line.account === null
        ? { accountType: { in: EXPENSES } }
        : { account: line.account as never }),
      ...(line.analytic === null ? {} : { analytic: line.analytic as never }),
    } as never,
  });
  return [...(await found.load(['debit', 'credit']))].reduce(
    (s, l) => s.plus(l.debit.amount).minus(l.credit.amount),
    ZERO,
  );
}

/** Untaxed amounts of purchase order lines of the line's scope; `orders` limits it (confirmed, not billed, by default). */
async function purchasesOf(
  env: Env,
  line: LineScope,
  orders?: readonly number[],
): Promise<Decimal> {
  if (!(await commitsOn(env, line))) return ZERO;
  const where =
    orders === undefined
      ? {
          'order.state': { in: ['purchase', 'done'] },
          'order.billState': { ne: 'billed' },
          'order.company': line.company,
          'order.dateOrder': { gte: line.from, lte: line.to },
        }
      : { order: { in: orders } };
  const found = await env.model('purchase.order.line').search({
    where: { ...where, ...(line.analytic === null ? {} : { analytic: line.analytic }) } as never,
  });
  return [...(await found.load(['subtotal']))].reduce(
    (s, l) => s.plus(l.subtotal?.amount ?? ZERO),
    ZERO,
  );
}

/** Refreshes the actual and committed amounts of the approved budgets' lines (those of `budgets`, or all). */
export async function refreshBudgets(env: Env, budgets?: readonly number[]): Promise<number> {
  const found = await env.model('account.budget').search({
    where: {
      state: 'approved',
      ...(budgets === undefined ? {} : { id: { in: budgets as never } }),
    },
  });
  let count = 0;
  for (const b of await found.load({ lines: true, company: true })) {
    for (const l of b.lines) {
      const scope: LineScope = {
        from: isoDate(b.dateFrom),
        to: isoDate(b.dateTo),
        analytic: l.analytic?.id ?? null,
        account: l.account?.id ?? null,
        company: b.company.id,
      };
      await env
        .model('account.budget.line')
        .browse([l.id])
        .write({
          actual: (await actualOf(env, scope)).toString(),
          committed: (await purchasesOf(env, scope)).toString(),
        } as never);
      count += 1;
    }
  }
  await env.flush();
  return count;
}

/** The submitted orders against the approved budget lines of their dates: refused beyond a block, marked beyond a warn. */
export async function checkOrders(env: Env, ids: readonly number[]): Promise<void> {
  for (const o of await env
    .model('purchase.order')
    .browse(ids as never)
    .load({ company: true })) {
    const date = isoDate(o.dateOrder);
    const budgets = await (
      await env.model('account.budget').search({
        where: {
          state: 'approved',
          company: o.company.id,
          dateFrom: { lte: date },
          dateTo: { gte: date },
        },
      })
    ).load({ lines: true });
    const notes: string[] = [];
    let over = false;
    for (const b of budgets)
      for (const l of b.lines) {
        if (l.control === 'none') continue;
        const scope: LineScope = {
          from: isoDate(b.dateFrom),
          to: isoDate(b.dateTo),
          analytic: l.analytic?.id ?? null,
          account: l.account?.id ?? null,
          company: o.company.id,
        };
        const thisOrder = await purchasesOf(env, scope, [o.id]);
        if (thisOrder.isZero()) continue;
        const left = l.planned
          .minus(await actualOf(env, scope))
          .minus(await purchasesOf(env, scope));
        const short = thisOrder.minus(left);
        if (short.lte(0)) continue;
        const what = `${b.name} › ${l.name}: ${left.toFixed(2)} left, this order ${thisOrder.toFixed(2)} (${short.toFixed(2)} beyond)`;
        if (l.control === 'block')
          throw new orm.ValidationError(
            'purchase.order',
            ['lines'],
            `Beyond the budget — ${what}.`,
            'Lower the order, choose another cost centre, or ask an Accounting manager to raise the budget.',
          );
        over = true;
        notes.push(what);
      }
    await env
      .model('purchase.order')
      .browse([o.id])
      .write({
        overBudget: over,
        budgetNote: notes.length === 0 ? null : notes.join('\n'),
      } as never);
  }
  await env.flush();
}
