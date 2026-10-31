/**
 * A closed session in the books (RFC 0021, Counter step 2): one entry in the shop's sales journal — the sales'
 * untaxed amounts to the journal's income account, each tax to its account, the payments per method to their
 * journals' accounts (cash less the change given), and the cash difference at closing to the shop's difference
 * account — posted as the cashier with the posting grant. A shop without a sales journal books nothing.
 */
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';

const ZERO: Decimal = orm.toDecimal(0);

interface Line {
  account: number;
  debit: Decimal;
  credit: Decimal;
  name: string;
}

/** Books the closed sessions that have a sales journal; returns the entries made, by session. */
export async function bookSessions(
  env: Env,
  ids: readonly Id<'pos.session'>[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const sessions = await env
    .model('pos.session')
    .browse(ids)
    .load({
      shop: { salesJournal: true, differenceAccount: true },
      company: { currency: true },
      orders: { lines: { taxes: true }, payments: { method: { journal: true } } },
    });
  for (const s of sessions) {
    if (s.state !== 'closed' || s.entry !== null) continue;
    const journal = s.shop.salesJournal;
    if (journal === null) continue;
    const income = journal.defaultAccount?.id ?? null;
    if (income === null)
      throw new orm.ValidationError(
        'pos.session',
        ['state'],
        `The sales journal ${journal.code} of ${s.shop.name} has no default account.`,
        'Set the income account as the journal’s default account (Accounting › Configuration).',
      );
    const lines: Line[] = [];
    const add = (account: number, debit: Decimal, credit: Decimal, name: string): void => {
      const existing = lines.find((l) => l.account === account && l.name === name);
      if (existing === undefined) lines.push({ account, debit, credit, name });
      else {
        existing.debit = existing.debit.plus(debit);
        existing.credit = existing.credit.plus(credit);
      }
    };
    let untaxed = ZERO;
    const taxes = new Map<number, { account: number | null; name: string; amount: Decimal }>();
    const byMethod = new Map<number, { account: number | null; name: string; amount: Decimal }>();
    for (const o of s.orders) {
      if (o.state !== 'paid') continue;
      for (const l of o.lines) {
        untaxed = untaxed.plus(l.subtotal ?? ZERO);
        // The line's tax, shared between its taxes in proportion to their rates (fixed taxes by their amount).
        const lineTax = l.taxAmount ?? ZERO;
        const parts = [...l.taxes].map((t) => ({
          tax: t,
          weight: t.amountType === 'percent' ? t.rate : t.fixedAmount.times(l.quantity),
        }));
        const total = parts.reduce((sum, p) => sum.plus(p.weight), ZERO);
        for (const p of parts) {
          const share = total.isZero()
            ? ZERO
            : lineTax.times(p.weight).div(total).toDecimalPlaces(2);
          const slot = taxes.get(p.tax.id) ?? {
            account: p.tax.account?.id ?? null,
            name: p.tax.name,
            amount: ZERO,
          };
          slot.amount = slot.amount.plus(share);
          taxes.set(p.tax.id, slot);
        }
      }
      for (const p of o.payments) {
        const slot = byMethod.get(p.method.id) ?? {
          account: p.method.journal?.defaultAccount?.id ?? null,
          name: p.method.name,
          amount: ZERO,
        };
        slot.amount = slot.amount.plus(p.amount);
        byMethod.set(p.method.id, slot);
      }
      // The change comes out of the cash taken.
      const change = o.change ?? ZERO;
      if (change.gt(0)) {
        const cash = [...o.payments].find((p) => p.method.kind === 'cash');
        if (cash !== undefined) {
          const slot = byMethod.get(cash.method.id);
          if (slot !== undefined) slot.amount = slot.amount.minus(change);
        }
      }
    }
    add(income, ZERO, untaxed, `${s.name} sales`);
    for (const t of taxes.values()) add(t.account ?? income, ZERO, t.amount, `${s.name} ${t.name}`);
    for (const m of byMethod.values()) {
      if (m.account === null)
        throw new orm.ValidationError(
          'pos.session',
          ['state'],
          `The payment method ${m.name} has no journal with a default account.`,
          'Give the method a journal (Counter › Shops).',
        );
      add(m.account, m.amount, ZERO, `${s.name} ${m.name}`);
    }
    const difference = s.closingDifference ?? ZERO;
    if (!difference.isZero()) {
      // More cash than expected: the drawer holds it (debit), a gain (credit); less: a loss.
      const cash = [...byMethod.values()].find((m) => m.account !== null);
      const differenceAccount = s.shop.differenceAccount?.id ?? income;
      if (cash?.account !== null && cash !== undefined) {
        if (difference.gt(0)) {
          add(cash.account as number, difference, ZERO, `${s.name} cash counted over`);
          add(differenceAccount, ZERO, difference, `${s.name} cash difference`);
        } else {
          add(differenceAccount, difference.neg(), ZERO, `${s.name} cash difference`);
          add(cash.account as number, ZERO, difference.neg(), `${s.name} cash counted short`);
        }
      }
    }
    const debit = lines.reduce((sum, l) => sum.plus(l.debit), ZERO);
    const credit = lines.reduce((sum, l) => sum.plus(l.credit), ZERO);
    if (debit.isZero() && credit.isZero()) continue;
    if (!debit.minus(credit).abs().lt(orm.toDecimal('0.05')))
      throw new orm.ValidationError(
        'pos.session',
        ['state'],
        `${s.name} does not balance (${debit.toString()} against ${credit.toString()}).`,
        'Check the sales’ taxes and payments.',
      );
    // Rounding of tax shares: the last cent goes with the income.
    const gap = debit.minus(credit);
    if (!gap.isZero()) add(income, ZERO, gap, `${s.name} rounding`);
    const made = await env.model('account.move').create([
      {
        kind: 'entry',
        journal: journal.id,
        company: s.company.id,
        currency: s.company.currency.id,
        date: env.today(),
        ref: `${s.name} (${s.shop.name})`,
        lines: {
          create: lines.map((l) => ({
            ...l,
            debit: l.debit.toString(),
            credit: l.credit.toString(),
          })),
        },
      },
    ] as never);
    await env.withGrants({ grants: ['account.post'], reason: `counter session ${s.name}` }, (e) =>
      e.model('account.move').browse(made.ids).post(),
    );
    const entry = made.ids[0] as number | undefined;
    if (entry !== undefined) {
      await env
        .model('pos.session')
        .browse([s.id])
        .write({ entry } as never);
      out.set(s.id, entry);
    }
  }
  return out;
}
