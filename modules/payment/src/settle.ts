/**
 * Settling a transaction (RFC 0017 §5.5): the provider's word — by its callback or asked when the customer returns —
 * moves a pending transaction to paid, failed or cancelled. Paid registers an `account.payment` for the invoice in
 * the provider's journal (Accounting posts and reconciles it), **once**: a transaction-scoped advisory lock on the
 * reference serialises a callback and a return arriving together, and a settled transaction is never settled again.
 */
import { registerPayment } from '@kosh/accounting';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import type { PaymentResult } from './providers.js';

export interface Settled {
  readonly reference: string;
  readonly state: string;
  /** False when it was settled before (a repeated callback, a return after the callback). */
  readonly changed: boolean;
  readonly payment: number | null;
}

/** Applies the provider's result to transaction `result.reference`, as the system in the transaction's company. */
export async function settle(env: Env, result: PaymentResult): Promise<Settled | null> {
  await env.sql`SELECT pg_advisory_xact_lock(hashtext(${`payment:${result.reference}`}))`;
  const found = await env
    .model('payment.transaction')
    .search({ where: { reference: result.reference }, limit: 1 });
  if (found.length === 0) return null;
  const [tx] = await found.load({ provider: true, currency: true, move: true });
  if (tx === undefined) return null;
  const same = { reference: tx.reference, changed: false };
  if (tx.state !== 'pending' || result.status === 'pending')
    return { ...same, state: tx.state, payment: tx.payment?.id ?? null };
  if (result.status !== 'done') {
    await found.write({
      state: result.status,
      providerReference: result.providerReference,
      error:
        result.error ?? (result.status === 'failed' ? 'The provider refused the payment.' : null),
    });
    return { ...same, state: result.status, changed: true, payment: null };
  }
  // What the provider says was paid must be what was asked.
  const amount = tx.amount.amount;
  if (
    (result.amount !== undefined && !orm.toDecimal(result.amount).eq(amount)) ||
    (result.currency !== undefined && result.currency !== tx.currency.name)
  ) {
    const error = `The provider reports ${result.amount ?? '?'} ${result.currency ?? ''}, not ${amount.toFixed()} ${tx.currency.name}.`;
    await found.write({ state: 'failed', providerReference: result.providerReference, error });
    return { ...same, state: 'failed', changed: true, payment: null };
  }
  const payment = await registerPayment(env as never, {
    moves: [tx.move.id],
    journal: tx.provider.journal.id,
    amount: amount.toFixed(),
    memo: `${tx.provider.name} ${result.providerReference ?? tx.reference}`,
  });
  await found.write({
    state: 'done',
    providerReference: result.providerReference,
    payment: payment.id as never,
    error: null,
    doneAt: new Date(),
  });
  await env.flush(); // checks run in this system scope, not at commit (Shutro request #11)
  return { ...same, state: 'done', changed: true, payment: payment.id };
}
