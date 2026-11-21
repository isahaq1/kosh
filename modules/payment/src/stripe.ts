/**
 * The Stripe adapter (RFC 0017 §5.5), on Checkout Sessions: a session per transaction (`client_reference_id` and
 * `metadata.reference` = its reference, one line of the invoice's amount in subunits) whose page the customer pays
 * on, back to the return route. Stripe's webhook is set up in its dashboard with the provider's endpoint URL; Stripe
 * gives the signing secret (`whsec_…`), which goes into **the endpoint's Secret**. `Stripe-Signature`
 * (`t=…,v1=…`: HMAC-SHA256 hex of `"<t>.<raw body>"`) is checked with it, and old timestamps are refused (5 minutes)
 * against replays; the event's `id` makes deliveries idempotent. Returns fetch the session from Stripe.
 *
 * Credentials come from the environment, never from records: `SHUTRO_ERP_STRIPE_SECRET_KEY`. Test keys
 * (`sk_test_…`, `rk_test_…`) serve providers in test mode, live keys live ones.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundCall } from '@kosh/modules-sdk';
import { fromSubunits, toSubunits } from './money.js';
import type { PaymentAdapter, PaymentResult } from './providers.js';

export interface StripeOptions {
  readonly secretKey?: string | undefined;
  /** The API's base (default `https://api.stripe.com/v1`). */
  readonly baseUrl?: string | undefined;
  /** How old a signed event may be, in seconds (default 300). */
  readonly tolerance?: number;
  /** The HTTP client (tests). */
  readonly fetch?: typeof fetch;
  /** The clock (tests). */
  readonly now?: () => number;
}

type Answer = Record<string, unknown>;
const text = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/** What a Checkout Session says of its payment. */
function sessionResult(reference: string, session: Answer, kind?: string): PaymentResult | null {
  const theirs =
    text(session['client_reference_id']) ||
    text((session['metadata'] as Answer | undefined)?.['reference']);
  if (theirs !== reference) return null;
  const currency = text(session['currency']).toUpperCase();
  const intent = session['payment_intent'];
  const providerReference =
    (typeof intent === 'string' ? intent : text((intent as Answer | null)?.['id'])) ||
    text(session['id']) ||
    null;
  // A delayed method (a bank debit) that did not go through.
  if (kind === 'checkout.session.async_payment_failed')
    return {
      reference,
      status: 'failed',
      providerReference,
      error: 'The payment failed at Stripe.',
    };
  if (text(session['payment_status']) === 'paid')
    return {
      reference,
      status: 'done',
      providerReference,
      amount: fromSubunits(Number(session['amount_total'] ?? 0), currency),
      currency,
    };
  if (text(session['status']) === 'expired' || kind === 'checkout.session.expired')
    return { reference, status: 'cancelled', providerReference };
  return { reference, status: 'pending', providerReference };
}

/**
 * What a PaymentIntent taken on a card terminal says of its payment (Stripe Terminal, server-driven): the
 * reference is in its metadata. `requires_payment_method` after an attempt is a card that was declined.
 */
function intentResult(reference: string, intent: Answer, kind?: string): PaymentResult | null {
  if (text((intent['metadata'] as Answer | undefined)?.['reference']) !== reference) return null;
  const providerReference = text(intent['id']) || null;
  const currency = text(intent['currency']).toUpperCase();
  const status = text(intent['status']);
  if (status === 'succeeded')
    return {
      reference,
      status: 'done',
      providerReference,
      amount: fromSubunits(Number(intent['amount_received'] ?? intent['amount'] ?? 0), currency),
      currency,
    };
  if (status === 'canceled') return { reference, status: 'cancelled', providerReference };
  const declined = (intent['last_payment_error'] ?? null) as Answer | null;
  if (
    kind === 'payment_intent.payment_failed' ||
    (status === 'requires_payment_method' && declined !== null)
  )
    return {
      reference,
      status: 'failed',
      providerReference,
      error: text(declined?.['message']) || 'The card was declined.',
    };
  return { reference, status: 'pending', providerReference };
}

/** Whether a PaymentIntent is one of a card terminal: the Checkout page's own intents are read by their session. */
const onTerminal = (intent: Answer): boolean =>
  Array.isArray(intent['payment_method_types']) &&
  (intent['payment_method_types'] as unknown[]).includes('card_present');

/** Stripe's form encoding of nested parameters (`line_items[0][price_data][currency]=bdt`). */
function form(params: Answer, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    const name = prefix === '' ? key : `${prefix}[${key}]`;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value))
      value.forEach((v, i) => {
        if (typeof v === 'object' && v !== null) form(v as Answer, `${name}[${i}]`, out);
        else out.append(`${name}[${i}]`, String(v));
      });
    else if (typeof value === 'object') form(value as Answer, name, out);
    else out.append(name, String(value));
  }
  return out;
}

export function stripeAdapter(options: StripeOptions = {}): PaymentAdapter {
  const key = options.secretKey ?? '';
  const base = (options.baseUrl || 'https://api.stripe.com/v1').replace(/\/$/, '');
  const http = options.fetch ?? fetch;
  const tolerance = options.tolerance ?? 300;
  const now = options.now ?? (() => Date.now());
  const ready = /^(sk|rk)_(test|live)_/.test(key);
  const call = async (method: 'GET' | 'POST', path: string, params?: Answer): Promise<Answer> => {
    if (!ready) throw new Error('Stripe is not configured: set SHUTRO_ERP_STRIPE_SECRET_KEY.');
    const res = await http(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      ...(params === undefined ? {} : { body: form(params) }),
      signal: AbortSignal.timeout(30_000),
    });
    const answer = (await res.json().catch(() => ({}))) as Answer;
    if (!res.ok) {
      const error = (answer['error'] ?? {}) as Answer;
      throw new Error(`Stripe answered ${res.status}: ${text(error['message']) || 'no detail'}.`);
    }
    return answer;
  };
  const session = (id: string) => call('GET', `/checkout/sessions/${encodeURIComponent(id)}`);

  return {
    code: 'stripe',
    configured: (mode) => ready && key.includes(mode === 'test' ? '_test_' : '_live_'),
    async createPayment(request) {
      const made = await call('POST', '/checkout/sessions', {
        mode: 'payment',
        client_reference_id: request.reference,
        success_url: request.returnUrl,
        cancel_url: request.returnUrl,
        ...(request.customer.email === null ? {} : { customer_email: request.customer.email }),
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: request.currency.toLowerCase(),
              unit_amount: toSubunits(request.amount, request.currency),
              product_data: { name: request.description },
            },
          },
        ],
        metadata: { reference: request.reference },
        payment_intent_data: { metadata: { reference: request.reference } },
      });
      const id = text(made['id']);
      const page = text(made['url']);
      if (id === '' || page === '') throw new Error('Stripe made no Checkout Session.');
      return { redirectUrl: page, providerReference: id };
    },
    // A card reader on the counter (Stripe Terminal, server-driven): a PaymentIntent for a present card,
    // handed to the reader, which asks for the card. Paid or declined, it is followed by `status` and by the
    // `payment_intent.*` events of the same webhook.
    inPerson: {
      ways: ['terminal'],
      async push(request) {
        if (!/^tmr_[A-Za-z0-9]+$/.test(request.to))
          throw new Error('A Stripe reader is named by its id (tmr_…).');
        const intent = await call('POST', '/payment_intents', {
          amount: toSubunits(request.amount, request.currency),
          currency: request.currency.toLowerCase(),
          payment_method_types: ['card_present'],
          capture_method: 'automatic',
          description: request.description,
          metadata: { reference: request.reference },
        });
        const id = text(intent['id']);
        if (id === '') throw new Error('Stripe made no payment for the reader.');
        await call(
          'POST',
          `/terminal/readers/${encodeURIComponent(request.to)}/process_payment_intent`,
          { payment_intent: id },
        );
        return { providerReference: id };
      },
    },
    verifyCallback(call: InboundCall, secret: string) {
      const header = call.headers['stripe-signature'] ?? '';
      const parts = header.split(',').map((p) => p.split('=') as [string, string]);
      const t = Number(parts.find(([k]) => k === 't')?.[1]);
      if (!Number.isFinite(t) || Math.abs(now() / 1000 - t) > tolerance) return null;
      const expected = Buffer.from(
        createHmac('sha256', secret).update(`${t}.${call.body}`).digest('hex'),
      );
      const genuine = parts
        .filter(([k]) => k === 'v1')
        .some(([, v]) => {
          const given = Buffer.from(v ?? '');
          return given.length === expected.length && timingSafeEqual(given, expected);
        });
      if (!genuine) return null;
      const id = text((call.json as Answer | null)?.['id']);
      return id !== '' ? id : null;
    },
    readCallback(call: InboundCall) {
      const event = call.json as Answer | null;
      const kind = text(event?.['type']);
      const object = ((event?.['data'] as Answer | undefined)?.['object'] ?? null) as Answer | null;
      if (object === null) return null;
      if (kind.startsWith('payment_intent.')) {
        if (!onTerminal(object)) return null;
        const of = text((object['metadata'] as Answer | undefined)?.['reference']);
        const said = of === '' ? null : intentResult(of, object, kind);
        return said === null || said.status === 'pending' ? null : said;
      }
      if (!kind.startsWith('checkout.session.')) return null;
      const reference =
        text(object['client_reference_id']) ||
        text((object['metadata'] as Answer | undefined)?.['reference']);
      const result = sessionResult(reference, object, kind);
      return result === null || result.status === 'pending' ? null : result;
    },
    async returned({ reference, providerReference }) {
      if (providerReference === null || providerReference === '') return null;
      const result = sessionResult(reference, await session(providerReference));
      return result?.status === 'pending' ? null : result;
    },
    async status(reference, _mode, providerReference) {
      if (!ready || providerReference === null || providerReference === '') return null;
      if (providerReference.startsWith('pi_'))
        return intentResult(
          reference,
          await call('GET', `/payment_intents/${encodeURIComponent(providerReference)}`),
        );
      return sessionResult(reference, await session(providerReference));
    },
  };
}

/** Stripe with its key from the environment, read on first use. */
export function stripeFromEnvironment(env: NodeJS.ProcessEnv = process.env): PaymentAdapter {
  let made: PaymentAdapter | undefined;
  const real = () =>
    (made ??= stripeAdapter({
      secretKey: env['KOSH_STRIPE_SECRET_KEY'],
      baseUrl: env['KOSH_STRIPE_BASE_URL'],
    }));
  return {
    code: 'stripe',
    configured: (mode) => real().configured(mode),
    createPayment: (request) => real().createPayment(request),
    inPerson: {
      ways: ['terminal'],
      push: (request) => real().inPerson?.push(request) ?? Promise.resolve({}),
    },
    verifyCallback: (call, secret) => real().verifyCallback(call, secret),
    readCallback: (call) => real().readCallback(call),
    returned: (input) => real().returned?.(input) ?? Promise.resolve(null),
    status: (reference, mode, providerReference) =>
      real().status(reference, mode, providerReference),
  };
}
