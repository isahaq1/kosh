/**
 * The bKash adapter (Tokenized Checkout v2; RFC 0017 §5.5). Grant a token (cached for its hour), create a payment
 * (its `paymentId` kept as the transaction's provider reference) and send the customer to `bkashURL`. bKash has no
 * server-to-server callback here: it sends the customer back to the return URL with `paymentID` and
 * `status=success|failure|cancel`, and the payment completes only when the merchant **executes** it. The browser's
 * status is a hint, never proof: on any return the adapter executes the transaction's own `paymentId` (never the
 * one in the URL) and believes only bKash's answer — `Completed`, for this invoice number, amount and currency — or,
 * when execute refuses, bKash's query.
 *
 * Credentials come from the environment, never from records: `SHUTRO_ERP_BKASH_USERNAME`, `…_PASSWORD`,
 * `…_APP_KEY`, `…_APP_SECRET`, `…_SANDBOX` (`true` unless `false`) and, optionally, `…_BASE_URL`.
 */
import type { PaymentAdapter, PaymentResult } from './providers.js';

export interface BkashOptions {
  readonly username?: string | undefined;
  readonly password?: string | undefined;
  readonly appKey?: string | undefined;
  readonly appSecret?: string | undefined;
  /** The sandbox (default) or the live system. */
  readonly sandbox?: boolean;
  /** The API's base, up to `/tokenized-checkout` (default: bKash's sandbox or live address). */
  readonly baseUrl?: string | undefined;
  /** The HTTP client (tests). */
  readonly fetch?: typeof fetch;
}

const BASES = {
  sandbox: 'https://tokenized.sandbox.bka.sh/v2/tokenized-checkout',
  live: 'https://tokenized.pay.bka.sh/v2/tokenized-checkout',
};
/** bKash's code for executing a payment that is already completed. */
const ALREADY_COMPLETED = '2062';

type Answer = Record<string, unknown>;
const text = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const same = (a: string, b: string) =>
  a !== '' && b !== '' && Number(a).toFixed(2) === Number(b).toFixed(2);

export function bkashAdapter(options: BkashOptions = {}): PaymentAdapter {
  const sandbox = options.sandbox ?? true;
  const base = (options.baseUrl || (sandbox ? BASES.sandbox : BASES.live)).replace(/\/$/, '');
  const http = options.fetch ?? fetch;
  const ready = [options.username, options.password, options.appKey, options.appSecret].every(
    (v) => v !== undefined && v !== '',
  );
  let token: { value: string; until: number } | null = null;

  const grant = async (): Promise<string> => {
    if (!ready)
      throw new Error(
        'bKash is not configured: set SHUTRO_ERP_BKASH_USERNAME, _PASSWORD, _APP_KEY and _APP_SECRET.',
      );
    if (token !== null && token.until > Date.now()) return token.value;
    const res = await http(`${base}/auth/grant-token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        username: options.username as string,
        password: options.password as string,
      },
      body: JSON.stringify({ app_key: options.appKey, app_secret: options.appSecret }),
      signal: AbortSignal.timeout(30_000),
    });
    const answer = (await res.json().catch(() => ({}))) as Answer;
    const value = text(answer['id_token']);
    if (value === '')
      throw new Error(
        `bKash refused the credentials: ${text(answer['statusMessage']) || res.status}.`,
      );
    // Kept for its lifetime less five minutes (an hour by default).
    const seconds = Number(answer['expires_in'] ?? 3600);
    token = { value, until: Date.now() + Math.max(60, seconds - 300) * 1000 };
    return value;
  };
  const post = async (path: string, body: Answer): Promise<Answer> => {
    const res = await http(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${await grant()}`,
        'x-app-key': options.appKey as string,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    return (await res.json().catch(() => ({}))) as Answer;
  };
  /** bKash's word on a payment, checked against the transaction. */
  const outcome = (
    reference: string,
    answer: Answer,
    expected: { amount?: string } = {},
  ): PaymentResult | null => {
    const status = text(answer['transactionStatus']);
    const invoice = text(answer['merchantInvoiceNumber'] ?? answer['merchantInvoice']);
    if (status !== 'Completed') return null;
    if (
      invoice !== reference ||
      (expected.amount !== undefined && !same(text(answer['amount']), expected.amount))
    )
      return {
        reference,
        status: 'failed',
        providerReference: text(answer['trxId']) || null,
        error: `bKash completed payment ${text(answer['paymentId'])} for ${invoice}, not this transaction.`,
      };
    return {
      reference,
      status: 'done',
      providerReference: text(answer['trxId']) || null,
      amount: text(answer['amount']),
      currency: text(answer['currency']) || 'BDT',
    };
  };
  const query = (paymentId: string) => post('/query/payment', { paymentId });

  return {
    code: 'bkash',
    configured: (mode) => ready && (mode === 'test') === sandbox,
    async createPayment(request) {
      if (request.currency !== 'BDT')
        throw new Error(`bKash takes payments in BDT only, not ${request.currency}.`);
      const answer = await post('/payment/create', {
        payerReference: request.customer.phone ?? request.reference,
        callbackURL: request.returnUrl,
        amount: request.amount,
        currency: 'BDT',
        intent: 'sale',
        merchantInvoiceNumber: request.reference,
      });
      const paymentId = text(answer['paymentId'] ?? answer['paymentID']);
      const page = text(answer['bkashURL'] ?? answer['bKashURL']);
      if (paymentId === '' || page === '')
        throw new Error(
          `bKash refused the payment: ${text(answer['errorMessageEn'] ?? answer['statusMessage']) || 'no payment id'}.`,
        );
      return { redirectUrl: page, providerReference: paymentId };
    },
    // No server-to-server callbacks: every call to the endpoint is refused.
    verifyCallback: () => null,
    readCallback: () => null,
    async returned({ reference, providerReference, query: hint }) {
      if (providerReference === null || providerReference === '') return null;
      if (hint['status'] === 'success') {
        // Execute: the payment completes now, or bKash says why not.
        const executed = await post('/payment/execute', { paymentId: providerReference });
        const done = outcome(reference, executed);
        if (done !== null) return done;
        const code = text(executed['externalCode'] ?? executed['statusCode']);
        const known = await query(providerReference);
        const completed = outcome(reference, known);
        if (completed !== null) return completed;
        if (code === ALREADY_COMPLETED) return null;
        return {
          reference,
          status: 'failed',
          providerReference,
          error:
            text(executed['errorMessageEn'] ?? executed['statusMessage']) ||
            'bKash did not complete the payment.',
        };
      }
      // Failed or cancelled on bKash's page — unless bKash says it completed.
      const known = await query(providerReference);
      const completed = outcome(reference, known);
      if (completed !== null) return completed;
      return {
        reference,
        status: hint['status'] === 'cancel' ? 'cancelled' : 'failed',
        providerReference,
        ...(hint['status'] === 'cancel'
          ? {}
          : { error: 'The payment was not completed on bKash.' }),
      };
    },
    async status(reference, _mode, providerReference) {
      if (!ready || providerReference === null || providerReference === '') return null;
      const known = await query(providerReference);
      return (
        outcome(reference, known) ??
        (text(known['transactionStatus']) === 'Initiated'
          ? { reference, status: 'pending', providerReference }
          : null)
      );
    },
  };
}

/** bKash with its credentials from the environment, read on first use. */
export function bkashFromEnvironment(env: NodeJS.ProcessEnv = process.env): PaymentAdapter {
  let made: PaymentAdapter | undefined;
  const real = () =>
    (made ??= bkashAdapter({
      username: env['KOSH_BKASH_USERNAME'],
      password: env['KOSH_BKASH_PASSWORD'],
      appKey: env['KOSH_BKASH_APP_KEY'],
      appSecret: env['KOSH_BKASH_APP_SECRET'],
      sandbox: env['KOSH_BKASH_SANDBOX'] !== 'false',
      baseUrl: env['KOSH_BKASH_BASE_URL'],
    }));
  return {
    code: 'bkash',
    configured: (mode) => real().configured(mode),
    createPayment: (request) => real().createPayment(request),
    verifyCallback: (call, secret) => real().verifyCallback(call, secret),
    readCallback: (call) => real().readCallback(call),
    returned: (input) => real().returned?.(input) ?? Promise.resolve(null),
    status: (reference, mode, providerReference) =>
      real().status(reference, mode, providerReference),
  };
}
