/**
 * Payment provider adapters (RFC 0017 §5.5). An adapter starts a payment at the provider (a page to send the customer
 * to), reads the provider's callbacks (verified with the callback endpoint's secret), and asks the provider for a
 * payment's status (when the customer returns before the callback). Credentials come from the environment, never
 * from records. The fake adapter moves no money: its checkout page (served by this module) lets the customer pay or
 * decline, and it calls back like a real provider, signed.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { InboundCall } from '@kosh/modules-sdk';

export type PaymentStatus = 'pending' | 'done' | 'failed' | 'cancelled';

export interface PaymentRequest {
  /** The transaction's reference: what the provider gives back. */
  readonly reference: string;
  /** Decimal string in the currency's unit (`'1250.00'`). */
  readonly amount: string;
  /** ISO 4217 (`BDT`). */
  readonly currency: string;
  /** What is paid (`Invoice INV/2026/0042`). */
  readonly description: string;
  readonly customer: {
    readonly name: string;
    readonly email: string | null;
    readonly phone: string | null;
    readonly street: string | null;
    readonly city: string | null;
    readonly zip: string | null;
    /** ISO 3166 alpha-2. */
    readonly country: string | null;
  };
  /** Where the provider sends the customer back (GET or POST; the server forwards them to the portal). */
  readonly returnUrl: string;
  /** The inbound webhook the provider calls (absolute URL). */
  readonly callbackUrl: string;
  readonly mode: 'test' | 'live';
}

export interface PaymentResult {
  readonly reference: string;
  readonly status: PaymentStatus;
  readonly providerReference: string | null;
  /** What the provider says was paid; checked against the transaction. */
  readonly amount?: string;
  readonly currency?: string;
  readonly error?: string;
}

/**
 * How a payment reaches a customer who stands at a counter, without a page for them to open: the provider
 * sends the request to their **phone** (a text with a link, a prompt in the wallet's app), or to a card
 * **terminal** on the counter.
 */
export type InPersonWay = 'phone' | 'terminal';

export interface InPersonRequest extends PaymentRequest {
  readonly way: InPersonWay;
  /** The phone number (digits, with a leading `+` when international), or the terminal's id at the provider. */
  readonly to: string;
}

export interface PaymentAdapter {
  readonly code: string;
  /** Whether its credentials are set (the portal offers only providers whose adapter can work). */
  configured(mode: 'test' | 'live'): boolean;
  /** Starts a payment; returns the page to send the customer to (and the provider's id of it, when it has one). */
  createPayment(
    request: PaymentRequest,
  ): Promise<{ readonly redirectUrl: string; readonly providerReference?: string }>;
  /** A callback's event id, or `null` when it is not genuine (checked with the endpoint's secret). */
  verifyCallback(call: InboundCall, secret: string): string | null | Promise<string | null>;
  /** What a verified callback says. */
  readCallback(call: InboundCall): PaymentResult | null;
  /** The provider's word on a payment (null: unknown to it). */
  status(
    reference: string,
    mode: 'test' | 'live',
    providerReference: string | null,
  ): Promise<PaymentResult | null>;
  /**
   * Payments pushed to the customer in person. The payment is then followed like any other: the provider's
   * callback, or `status`. Absent: the provider only has a page to open.
   */
  readonly inPerson?: {
    readonly ways: readonly InPersonWay[];
    push(request: InPersonRequest): Promise<{ readonly providerReference?: string }>;
  };
  /**
   * The customer is back (`query`: what the provider put in the return URL — a hint, never proof). Providers that
   * complete a payment only when the merchant asks (bKash's execute) do it here; the result is settled at once.
   */
  returned?(input: {
    readonly reference: string;
    readonly providerReference: string | null;
    readonly mode: 'test' | 'live';
    readonly query: Readonly<Record<string, string>>;
  }): Promise<PaymentResult | null>;
}

/** The fake adapter's header: HMAC-SHA256 (hex) of the raw body with the endpoint's secret. */
export const FAKE_SIGNATURE = 'x-fake-signature';

/** What the fake checkout knows (per process: it is for tests and demonstrations). */
const fakeLedger = new Map<
  string,
  PaymentResult & {
    readonly request: PaymentRequest;
    readonly pushed?: { readonly way: InPersonWay; readonly to: string };
  }
>();

export const fakeAdapter: PaymentAdapter & {
  /** The payment the fake checkout shows. */
  pending(reference: string): PaymentRequest | null;
  /** Where a payment was pushed (a phone, a terminal), when it was. */
  pushed(reference: string): { way: InPersonWay; to: string } | null;
  /** The customer paid or declined on the fake checkout: the result and the signed callback body. */
  complete(
    reference: string,
    paid: boolean,
    secret: string,
  ): { body: string; signature: string } | null;
} = {
  code: 'fake',
  configured: (mode) => mode === 'test',
  async createPayment(request) {
    fakeLedger.set(request.reference, {
      reference: request.reference,
      status: 'pending',
      providerReference: null,
      request,
    });
    return {
      redirectUrl: `/api/v1/payment/fake/checkout/${encodeURIComponent(request.reference)}`,
    };
  },
  // The test phone and the test terminal: nothing is sent; the payment waits like one with a page, and is
  // paid or declined on the same test page (by a test, or by whoever plays the customer).
  inPerson: {
    ways: ['phone', 'terminal'],
    async push(request) {
      // A reader that is switched off, as a real provider would refuse it.
      if (request.way === 'terminal' && request.to === 'offline')
        throw new Error('The card reader does not answer.');
      const { way, to, ...payment } = request;
      fakeLedger.set(request.reference, {
        reference: request.reference,
        status: 'pending',
        providerReference: null,
        request: payment,
        pushed: { way, to },
      });
      return {};
    },
  },
  pushed(reference) {
    return fakeLedger.get(reference)?.pushed ?? null;
  },
  verifyCallback(call, secret) {
    const given = Buffer.from(call.headers[FAKE_SIGNATURE] ?? '');
    const expected = Buffer.from(createHmac('sha256', secret).update(call.body).digest('hex'));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const id = (call.json as { id?: unknown } | null)?.id;
    return typeof id === 'string' && id !== '' ? id : null;
  },
  readCallback(call) {
    const event = call.json as Partial<PaymentResult> | null;
    if (typeof event?.reference !== 'string') return null;
    return {
      reference: event.reference,
      status: event.status ?? 'pending',
      providerReference: event.providerReference ?? null,
      ...(event.amount === undefined ? {} : { amount: event.amount }),
      ...(event.currency === undefined ? {} : { currency: event.currency }),
    };
  },
  async status(reference) {
    const known = fakeLedger.get(reference);
    if (known === undefined) return null;
    const { request: _request, pushed: _pushed, ...result } = known;
    return result;
  },
  pending(reference) {
    const known = fakeLedger.get(reference);
    return known?.status === 'pending' ? known.request : null;
  },
  complete(reference, paid, secret) {
    const known = fakeLedger.get(reference);
    if (known === undefined || known.status !== 'pending') return null;
    const result: PaymentResult = {
      reference,
      status: paid ? 'done' : 'failed',
      providerReference: `FAKE-${randomUUID().slice(0, 8).toUpperCase()}`,
      amount: known.request.amount,
      currency: known.request.currency,
    };
    fakeLedger.set(reference, {
      ...result,
      request: known.request,
      ...(known.pushed === undefined ? {} : { pushed: known.pushed }),
    });
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, ...result });
    return { body, signature: createHmac('sha256', secret).update(body).digest('hex') };
  },
};

/** The adapters by code. */
export const ADAPTERS: ReadonlyMap<string, PaymentAdapter> = new Map([
  [fakeAdapter.code, fakeAdapter],
]);
