/**
 * Payments and reconciliation (RFC 0009 §5.3). Reconciliation matches the open lines of one reconcilable account
 * (receivable, payable, suspense): debit residuals against credit residuals, oldest due first, as partial
 * matches (`account.partial.reconcile`). Lines in the same foreign currency match in that currency and the
 * company-currency difference between the two rates is posted as a realised exchange gain or loss, in the
 * miscellaneous journal, and matched too. Lines whose residuals reach zero are grouped in a full reconciliation.
 * A payment posts its entry through the journal's account and matches its receivable / payable line with the
 * documents it pays. Unreconciling removes the matches and reverses the exchange entries they posted.
 */
import { HttpProblem } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';

type Payments = Parameters<
  Parameters<typeof import('./.kosh/bindings.js').records<'account.payment'>>[1]
>[0];

const fail = (model: string, fields: string[], problem: string, hint: string) =>
  new orm.ValidationError(model, fields, problem, hint);

interface OpenLine {
  readonly id: number;
  readonly account: number;
  readonly partner: number | null;
  readonly currency: number;
  readonly companyCurrency: number;
  readonly dateMaturity: string;
  /** The line's rate: company-currency amount per unit of its currency (1 in the company currency). */
  readonly rate: Decimal;
  residual: Decimal;
  residualCurrency: Decimal;
}

/** The open (not fully reconciled) lines of a reconcilable account, oldest due first. */
export async function openLines(
  env: Env,
  ids: readonly number[],
): Promise<{ lines: OpenLine[]; company: { id: number; currency: number } }> {
  const loaded = await env
    .model('account.move.line')
    .browse(ids as never)
    .load({ account: true, move: { company: true }, currency: true, companyCurrency: true });
  const lines: OpenLine[] = [];
  let company: { id: number; currency: number } | null = null;
  for (const l of loaded) {
    if (l.account === null || !l.account.reconcile)
      throw fail(
        'account.move.line',
        ['account'],
        `Line ${l.id} is on ${l.account?.code ?? 'no'} account, which is not reconcilable.`,
        'Reconcile lines of receivable, payable or suspense accounts.',
      );
    if (l.move.state !== 'posted')
      throw fail(
        'account.move.line',
        ['move'],
        `Line ${l.id} belongs to an entry that is not posted.`,
        'Post it first.',
      );
    const gross = l.debit.amount.minus(l.credit.amount);
    const inCurrency = l.amountCurrency?.amount ?? gross;
    const rate = inCurrency.isZero() ? orm.toDecimal(1) : gross.div(inCurrency).abs();
    company ??= {
      id: l.move.company.id,
      currency: l.move.company.currency?.id ?? l.companyCurrency?.id ?? 0,
    };
    lines.push({
      id: l.id,
      account: l.account.id,
      partner: l.partner?.id ?? null,
      currency: l.currency?.id ?? company.currency,
      companyCurrency: l.companyCurrency?.id ?? company.currency,
      dateMaturity: l.dateMaturity ?? l.date ?? '',
      rate,
      residual: l.amountResidual?.amount ?? gross,
      residualCurrency: l.amountResidualCurrency?.amount ?? inCurrency,
    });
  }
  if (company === null)
    throw fail('account.move.line', [], 'No lines to reconcile.', 'Choose at least two lines.');
  lines.sort((a, b) =>
    a.dateMaturity < b.dateMaturity ? -1 : a.dateMaturity > b.dateMaturity ? 1 : a.id - b.id,
  );
  return { lines, company };
}

export interface ReconcileResult {
  readonly partials: number[];
  readonly fullReconcile: number | null;
  readonly exchangeMoves: number[];
}

const asLine = (id: number) => orm.asId(id, 'account.move.line');

/** Posts a two-line entry in the company's miscellaneous journal (exchange differences, write-offs); its id. */
async function postAdjustment(
  env: Env,
  company: number,
  partner: number | null,
  account: number,
  otherAccount: number,
  amount: Decimal,
  debitOnAccount: boolean,
  ref: string,
): Promise<number> {
  const journal = await env
    .model('account.journal')
    .search({ where: { company: orm.asId(company, 'res.company'), type: 'general' }, limit: 1 });
  const journalId = journal.ids[0];
  if (journalId === undefined)
    throw fail(
      'account.move',
      ['journal'],
      'The company has no miscellaneous journal.',
      'Install a chart of accounts.',
    );
  const [companyRow] = await env
    .model('res.company')
    .browse([orm.asId(company, 'res.company')])
    .load({ currency: true });
  const side = (onAccount: boolean) =>
    onAccount === debitOnAccount ? { debit: amount, credit: '0' } : { debit: '0', credit: amount };
  const created = await env.model('account.move').create([
    {
      journal: journalId,
      date: env.today(),
      kind: 'entry',
      currency: companyRow?.currency.id as never,
      company: orm.asId(company, 'res.company'),
      ref,
      lines: {
        create: [
          {
            account: orm.asId(account, 'account.account'),
            partner: partner === null ? null : orm.asId(partner, 'res.partner'),
            name: ref,
            amountCurrency: '0',
            ...side(true),
          },
          {
            account: orm.asId(otherAccount, 'account.account'),
            partner: partner === null ? null : orm.asId(partner, 'res.partner'),
            name: ref,
            ...side(false),
          },
        ],
      },
    },
  ]);
  await env.withGrants({ grants: ['account.post'], reason: ref }, (e) =>
    e.model('account.move').browse(created.ids).post(),
  );
  return created.ids[0] as number;
}

/**
 * Reconciles lines of one reconcilable account. Debit residuals are matched against credit residuals, oldest
 * due first; lines in the same foreign currency match in that currency with the exchange difference posted.
 * With `writeOff`, what is left on the last line goes to that account. Needs the `account.reconcile` permission.
 */
export async function reconcile(
  env: Env,
  ids: readonly number[],
  options: { readonly writeOff?: { readonly account: number; readonly label?: string } } = {},
): Promise<ReconcileResult> {
  if (!env.access.has('account.reconcile'))
    throw new HttpProblem(
      403,
      'access',
      'Forbidden',
      'Reconciling needs the account.reconcile permission.',
      'Ask for the Accountant access level.',
    );
  const { lines, company } = await openLines(env, [...new Set(ids)]);
  const accounts = new Set(lines.map((l) => l.account));
  if (accounts.size !== 1)
    throw fail(
      'account.move.line',
      ['account'],
      'The lines are on different accounts.',
      'Reconcile lines of one account at a time.',
    );
  const account = lines[0]?.account as number;
  const partials: number[] = [];
  const exchangeMoves: number[] = [];
  const exchangeLines: number[] = [];
  const partialsOf = env.model('account.partial.reconcile');
  const [companyRow] = await env
    .model('res.company')
    .browse([orm.asId(company.id, 'res.company')])
    .load({ currency: true, accountExchangeGain: true, accountExchangeLoss: true });
  const unit = companyRow?.currency.rounding ?? orm.toDecimal('0.01');
  const round = (d: Decimal) =>
    d.div(unit).toDecimalPlaces(0, orm.Decimal.ROUND_HALF_UP).times(unit);
  const debits = lines.filter((l) => l.residual.gt(0));
  const credits = lines.filter((l) => l.residual.lt(0));
  while (debits.length > 0 && credits.length > 0) {
    const d = debits[0] as OpenLine;
    const c = credits[0] as OpenLine;
    const foreign = d.currency === c.currency && d.currency !== company.currency;
    if (foreign) {
      const mc = orm.Decimal.min(d.residualCurrency, c.residualCurrency.neg());
      const dAmount = round(mc.times(d.rate));
      const cAmount = round(mc.times(c.rate));
      const amount = orm.Decimal.min(dAmount, cAmount);
      const created = await partialsOf.create([
        {
          debitLine: asLine(d.id),
          creditLine: asLine(c.id),
          amount,
          amountCurrency: mc,
          currency: orm.asId(d.currency, 'res.currency'),
        },
      ]);
      partials.push(created.ids[0] as number);
      d.residual = d.residual.minus(amount);
      d.residualCurrency = d.residualCurrency.minus(mc);
      c.residual = c.residual.plus(amount);
      c.residualCurrency = c.residualCurrency.plus(mc);
      // The rate difference: the line with the larger company amount keeps a residual with nothing left in
      // currency; an exchange entry settles it.
      const diff = dAmount.minus(cAmount);
      if (!diff.isZero()) {
        const loser = diff.gt(0) ? d : c; // the debit line is worth more (a loss for a receivable paid)
        // A credit line left with a residual is settled by a debit on the account against income: a gain.
        const gain = loser === c;
        const otherAccount = gain
          ? companyRow?.accountExchangeGain?.id
          : companyRow?.accountExchangeLoss?.id;
        if (otherAccount === undefined || otherAccount === null)
          throw fail(
            'account.move',
            ['currency'],
            'The company has no exchange gain / loss accounts.',
            'Set them on the company (a chart of accounts does).',
          );
        const amountDiff = diff.abs();
        const settledOnDebit = loser === d; // the loser's leftover is a debit residual: the exchange line credits the account
        const moveId = await postAdjustment(
          env,
          company.id,
          d.partner ?? c.partner,
          account,
          otherAccount,
          amountDiff,
          !settledOnDebit,
          `Exchange difference`,
        );
        exchangeMoves.push(moveId);
        const exchangeLine = await env.model('account.move.line').search({
          where: {
            move: orm.asId(moveId, 'account.move'),
            account: orm.asId(account, 'account.account'),
          },
          limit: 1,
        });
        const exLineId = exchangeLine.ids[0] as number;
        exchangeLines.push(exLineId);
        const link = await partialsOf.create([
          settledOnDebit
            ? {
                debitLine: asLine(d.id),
                creditLine: asLine(exLineId),
                amount: amountDiff,
                amountCurrency: '0',
                currency: orm.asId(d.currency, 'res.currency'),
                exchangeMove: orm.asId(moveId, 'account.move'),
              }
            : {
                debitLine: asLine(exLineId),
                creditLine: asLine(c.id),
                amount: amountDiff,
                amountCurrency: '0',
                currency: orm.asId(c.currency, 'res.currency'),
                exchangeMove: orm.asId(moveId, 'account.move'),
              },
        ]);
        partials.push(link.ids[0] as number);
        if (settledOnDebit) d.residual = d.residual.minus(amountDiff);
        else c.residual = c.residual.plus(amountDiff);
      }
    } else {
      const amount = orm.Decimal.min(d.residual, c.residual.neg());
      const created = await partialsOf.create([
        {
          debitLine: asLine(d.id),
          creditLine: asLine(c.id),
          amount,
          amountCurrency: amount,
          currency: orm.asId(company.currency, 'res.currency'),
        },
      ]);
      partials.push(created.ids[0] as number);
      d.residual = d.residual.minus(amount);
      d.residualCurrency = d.residualCurrency.minus(amount);
      c.residual = c.residual.plus(amount);
      c.residualCurrency = c.residualCurrency.plus(amount);
    }
    if (d.residual.isZero()) debits.shift();
    if (c.residual.isZero()) credits.shift();
  }
  // A write-off takes what is left (one side only).
  const left = [...debits, ...credits];
  if (options.writeOff !== undefined && left.length > 0) {
    for (const l of left) {
      const amount = l.residual.abs();
      const debitOnAccount = l.residual.lt(0); // a leftover credit is settled by a debit on the account
      const moveId = await postAdjustment(
        env,
        company.id,
        l.partner,
        account,
        options.writeOff.account,
        amount,
        debitOnAccount,
        options.writeOff.label ?? 'Write-off',
      );
      exchangeMoves.push(moveId);
      const woLine = await env.model('account.move.line').search({
        where: {
          move: orm.asId(moveId, 'account.move'),
          account: orm.asId(account, 'account.account'),
        },
        limit: 1,
      });
      const woId = woLine.ids[0] as number;
      exchangeLines.push(woId);
      const link = await partialsOf.create([
        debitOnAccount
          ? {
              debitLine: asLine(woId),
              creditLine: asLine(l.id),
              amount,
              amountCurrency: amount,
              currency: orm.asId(l.currency, 'res.currency'),
            }
          : {
              debitLine: asLine(l.id),
              creditLine: asLine(woId),
              amount,
              amountCurrency: amount,
              currency: orm.asId(l.currency, 'res.currency'),
            },
      ]);
      partials.push(link.ids[0] as number);
      l.residual = orm.toDecimal(0);
      l.residualCurrency = orm.toDecimal(0);
    }
  }
  // Everything settled: one full reconciliation for the lines of this round.
  const settled = lines
    .filter((l) => l.residual.isZero() && l.residualCurrency.isZero())
    .map((l) => l.id);
  let fullReconcile: number | null = null;
  if (partials.length > 0 && settled.length === lines.length) {
    const full = await env
      .model('account.full.reconcile')
      .create([{ name: `A${Date.now().toString(36)}` }]);
    const fullId = full.ids[0] as (typeof full.ids)[number];
    fullReconcile = fullId;
    const allLines = [...settled, ...exchangeLines];
    await env
      .model('account.move.line')
      .browse(allLines.map(asLine))
      .write({ fullReconcile: fullId });
    await partialsOf
      .browse(partials.map((id) => orm.asId(id, 'account.partial.reconcile')))
      .write({ fullReconcile: fullId });
  }
  return { partials, fullReconcile, exchangeMoves };
}

/** Removes the matches of these lines (and reverses the exchange entries they posted). */
export async function unreconcile(env: Env, ids: readonly number[]): Promise<{ removed: number }> {
  if (!env.access.has('account.reconcile'))
    throw new HttpProblem(
      403,
      'access',
      'Forbidden',
      'Unreconciling needs the account.reconcile permission.',
      'Ask for the Accountant access level.',
    );
  const lineIds = [...new Set(ids)].map(asLine);
  const partials = await env.model('account.partial.reconcile').search({
    where: { or: [{ debitLine: { in: lineIds } }, { creditLine: { in: lineIds } }] },
  });
  const loaded = await partials.load({ fullReconcile: true, exchangeMove: true });
  const fulls = new Set<number>();
  const exchange = new Set<number>();
  for (const p of loaded) {
    if (p.fullReconcile !== null) fulls.add(p.fullReconcile.id);
    if (p.exchangeMove !== null) exchange.add(p.exchangeMove.id);
  }
  // Every partial of the full reconciliations touched goes too (a settlement is whole or not at all).
  const whole =
    fulls.size === 0
      ? partials
      : await env.model('account.partial.reconcile').search({
          where: {
            or: [
              { id: { in: partials.ids } },
              {
                fullReconcile: {
                  in: [...fulls].map((id) => orm.asId(id, 'account.full.reconcile')),
                },
              },
            ],
          },
        });
  const removed = whole.length;
  await whole.unlink();
  if (fulls.size > 0)
    await env
      .model('account.full.reconcile')
      .browse([...fulls].map((id) => orm.asId(id, 'account.full.reconcile')))
      .unlink();
  for (const moveId of exchange) {
    const { reverseMove } = await import('./index.js');
    await reverseMove(env, moveId, { post: true });
  }
  return { removed };
}

/**
 * The payment's entry and matches, before it is posted: the journal's account against the partner's receivable
 * (money received) or payable (money sent), the entry posted, and the receivable / payable line matched with the
 * documents' counterpart lines, oldest due first.
 */
export async function postPayments(payments: Payments): Promise<void> {
  const env = payments.env as unknown as Env;
  const loaded = await payments.load({
    journal: { defaultAccount: true },
    partner: true,
    currency: true,
    company: { currency: true, accountReceivable: true, accountPayable: true },
    documents: { lines: { account: true } },
  });
  for (const p of loaded) {
    if (p.journal.type !== 'cash' && p.journal.type !== 'bank')
      throw fail(
        'account.payment',
        ['journal'],
        `${p.journal.name} is not a cash or bank journal.`,
        'Pay through a cash or bank journal.',
      );
    const bank = p.journal.defaultAccount;
    if (bank === null)
      throw fail(
        'account.payment',
        ['journal'],
        `Journal ${p.journal.code} has no account.`,
        "Set the journal's default account.",
      );
    const counterpart =
      p.kind === 'inbound' ? p.company.accountReceivable : p.company.accountPayable;
    if (counterpart === null)
      throw fail(
        'account.payment',
        ['partner'],
        'The company has no receivable / payable account.',
        'Install a chart of accounts.',
      );
    const amount = p.amount.amount;
    if (amount.lte(0))
      throw fail(
        'account.payment',
        ['amount'],
        'The amount is not positive.',
        'Enter the amount paid.',
      );
    const docLineIds: number[] = [];
    for (const d of p.documents) {
      if (d.state !== 'posted')
        throw fail(
          'account.payment',
          ['documents'],
          `${d.name} is not posted.`,
          'Post the document first.',
        );
      if (d.partner?.id !== p.partner.id)
        throw fail(
          'account.payment',
          ['documents'],
          `${d.name} is not from ${p.partner.name}.`,
          "Pay one partner's documents at a time.",
        );
      if (d.currency.id !== p.currency.id)
        throw fail(
          'account.payment',
          ['documents'],
          `${d.name} is in another currency.`,
          "Pay in the document's currency.",
        );
      const incoming = d.kind === 'out_invoice' || d.kind === 'in_refund';
      if (incoming !== (p.kind === 'inbound'))
        throw fail(
          'account.payment',
          ['documents'],
          `${d.name} is not ${p.kind === 'inbound' ? 'money to receive' : 'money to send'}.`,
          'Check the direction.',
        );
      for (const l of d.lines)
        if (l.lineKind === 'counterpart' && l.account?.id === counterpart.id) docLineIds.push(l.id);
    }
    const inbound = p.kind === 'inbound';
    const created = await env.model('account.move').create([
      {
        journal: p.journal.id,
        date: p.date,
        kind: 'entry',
        partner: p.partner.id,
        currency: p.currency.id,
        company: p.company.id,
        ref: p.memo ?? `Payment ${p.partner.name}`,
        lines: {
          create: [
            {
              account: bank.id,
              partner: p.partner.id,
              name: p.memo ?? 'Payment',
              amountCurrency: inbound ? amount : amount.neg(),
              debit: '0',
              credit: '0',
            },
            {
              account: counterpart.id,
              partner: p.partner.id,
              name: p.memo ?? 'Payment',
              amountCurrency: inbound ? amount.neg() : amount,
              debit: '0',
              credit: '0',
            },
          ],
        },
      },
    ]);
    await env.withGrants({ grants: ['account.post'], reason: 'post the payment entry' }, (e) =>
      e.model('account.move').browse(created.ids).post(),
    );
    const moveId = created.ids[0] as (typeof created.ids)[number];
    await env.model('account.payment').browse([p.id]).write({ move: moveId });
    if (docLineIds.length > 0) {
      const payLine = await env
        .model('account.move.line')
        .search({ where: { move: moveId, account: counterpart.id }, limit: 1 });
      await env.withGrants(
        {
          grants: [
            'account.reconcile',
            'account.partial.reconcile:create',
            'account.partial.reconcile:write',
            'account.full.reconcile:create',
            'account.full.reconcile:write',
          ],
          reason: 'match the payment with its documents',
        },
        (e) => reconcile(e as Env, [...(payLine.ids as readonly number[]), ...docLineIds]),
      );
      await env
        .model('account.move')
        .browse(p.documents.map((d) => d.id))
        .write({ payments: { link: [p.id] } });
    }
  }
}

export interface RegisterInput {
  readonly moves: readonly number[];
  readonly journal: number;
  readonly date?: string | undefined;
  readonly amount?: string | undefined;
  readonly memo?: string | undefined;
}

/** A payment for posted documents of one partner and currency, with their residual as the default amount. */
export async function registerPayment(
  env: Env,
  input: RegisterInput,
): Promise<{ id: number; name: string; amount: string }> {
  const docs = await env
    .model('account.move')
    .browse(input.moves.map((id) => orm.asId(id, 'account.move')))
    .load({ partner: true, currency: true });
  const first = docs.first();
  if (docs.length === 0)
    throw fail(
      'account.payment',
      ['documents'],
      'No documents to pay.',
      'Choose at least one posted document.',
    );
  let residual = orm.toDecimal(0);
  for (const d of docs) {
    if (d.kind === 'entry')
      throw fail(
        'account.payment',
        ['documents'],
        `${d.name} is a journal entry, not a document.`,
        'Pay invoices, bills or credit notes.',
      );
    residual = residual.plus(d.amountResidual?.amount ?? 0);
  }
  const kind = first.kind === 'out_invoice' || first.kind === 'in_refund' ? 'inbound' : 'outbound';
  const amount = input.amount ?? residual.toString();
  const created = await env.model('account.payment').create([
    {
      kind,
      partner: first.partner?.id as never,
      journal: orm.asId(input.journal, 'account.journal'),
      date: input.date ?? env.today(),
      currency: first.currency.id,
      amount,
      memo: input.memo ?? null,
      company: first.company.id,
      documents: { set: docs.ids },
    },
  ]);
  await created.post();
  const [payment] = await created.load({});
  return { id: created.ids[0] as number, name: payment?.name ?? '/', amount };
}
