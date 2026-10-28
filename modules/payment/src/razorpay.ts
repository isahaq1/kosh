/**
 * The Razorpay adapter (India; RFC 0017 §5.5), on Payment Links: a link per transaction (`reference_id` = its
 * reference; amounts in subunits) whose page the customer pays on, back to the return URL. Razorpay's webhook
 * (`payment_link.paid`) is set up in its dashboard with the provider's endpoint URL and **the endpoint's secret**:
 * `X-Razorpay-Signature` (HMAC-SHA256, hex, of the raw body) is checked with it, `x-razorpay-event-id` makes deliveries
 * idempotent. On the customer's return (and when asked) the adapter fetches the link from Razorpay by the id it
 * kept — what the browser brings is not used.
 *
 * Credentials come from the environment, never from records: `SHUTRO_ERP_RAZORPAY_KEY_ID` and
 * `SHUTRO_ERP_RAZORPAY_KEY_SECRET`. Test keys (`rzp_test_…`) serve providers in test mode, live keys live ones.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundCall } from '@kosh/modules-sdk';
import { fromSubunits, toSubunits } from './money.js';
import type { PaymentAdapter, PaymentResult } from './providers.js';

export interface RazorpayOptions {
  readonly keyId?: string | undefined;
  readonly keySecret?: string | undefined;
  /** The API's base (default `https://api.razorpay.com/v1`). */
  readonly baseUrl?: string | undefined;
  /** The HTTP client (tests). */
  readonly fetch?: typeof fetch;
}

type Answer = Record<string, unknown>;
const text = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/** What a payment link says of its payment. */
function linkResult(reference: string, link: Answer): PaymentResult | null {
  if (text(link['reference_id']) !== reference) return null;
  const status = text(link['status']);
  const currency = text(link['currency']) || 'INR';
  if (status === 'paid') {
    const payments = Array.isArray(link['payments']) ? (link['payments'] as Answer[]) : [];
    return {
      reference,
      status: 'done',
      providerReference: text(payments.at(-1)?.['payment_id']) || text(link['id']) || null,
      amount: fromSubunits(Number(link['amount_paid'] ?? 0), currency),
      currency,
    };
  }
  if (status === 'expired' || status === 'cancelled')
    return { reference, status: 'cancelled', providerReference: text(link['id']) || null };
  return { reference, status: 'pending', providerReference: text(link['id']) || null };
}

export function razorpayAdapter(options: RazorpayOptions = {}): PaymentAdapter {
  const keyId = options.keyId ?? '';
  const keySecret = options.keySecret ?? '';
  const base = (options.baseUrl || 'https://api.razorpay.com/v1').replace(/\/$/, '');
  const http = options.fetch ?? fetch;
  const ready = keyId !== '' && keySecret !== '';
  const call = async (method: 'GET' | 'POST', path: string, body?: Answer): Promise<Answer> => {
    if (!ready)
      throw new Error(
        'Razorpay is not configured: set SHUTRO_ERP_RAZORPAY_KEY_ID and SHUTRO_ERP_RAZORPAY_KEY_SECRET.',
      );
    const res = await http(`${base}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const answer = (await res.json().catch(() => ({}))) as Answer;
    if (!res.ok) {
      const error = (answer['error'] ?? {}) as Answer;
      throw new Error(
        `Razorpay answered ${res.status}: ${text(error['description']) || 'no detail'}.`,
      );
    }
    return answer;
  };
  const fetchLink = (id: string) => call('GET', `/payment_links/${encodeURIComponent(id)}`);

  return {
    code: 'razorpay',
    configured: (mode) => ready && keyId.startsWith(mode === 'test' ? 'rzp_test_' : 'rzp_live_'),
    async createPayment(request) {
      const phone = (request.customer.phone ?? '').replace(/[^\d+]/g, '');
      const link = await call('POST', '/payment_links', {
        amount: toSubunits(request.amount, request.currency),
        currency: request.currency,
        reference_id: request.reference,
        description: request.description.slice(0, 2048),
        customer: {
          name: request.customer.name,
          ...(request.customer.email === null ? {} : { email: request.customer.email }),
          ...(phone.length >= 8 && phone.length <= 14 ? { contact: phone } : {}),
        },
        notify: { sms: false, email: false },
        reminder_enable: false,
        callback_url: request.returnUrl,
        callback_method: 'get',
      });
      const id = text(link['id']);
      const page = text(link['short_url']);
      if (id === '' || page === '') throw new Error('Razorpay made no payment link.');
      return { redirectUrl: page, providerReference: id };
    },
    verifyCallback(call: InboundCall, secret: string) {
      const given = Buffer.from(call.headers['x-razorpay-signature'] ?? '');
      const expected = Buffer.from(createHmac('sha256', secret).update(call.body).digest('hex'));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      const id = call.headers['x-razorpay-event-id'] ?? '';
      return id !== '' ? id : null;
    },
    readCallback(call: InboundCall) {
      const event = call.json as Answer | null;
      const payload = (event?.['payload'] ?? {}) as Answer;
      const link = ((payload['payment_link'] as Answer | undefined)?.['entity'] ??
        null) as Answer | null;
      if (link === null) return null;
      const reference = text(link['reference_id']);
      const kind = text(event?.['event']);
      if (kind === 'payment_link.paid') {
        const payment = ((payload['payment'] as Answer | undefined)?.['entity'] ?? {}) as Answer;
        const currency = text(link['currency']) || 'INR';
        return {
          reference,
          status: 'done',
          providerReference: text(payment['id']) || text(link['id']) || null,
          amount: fromSubunits(Number(link['amount_paid'] ?? payment['amount'] ?? 0), currency),
          currency,
        };
      }
      if (kind === 'payment_link.expired' || kind === 'payment_link.cancelled')
        return { reference, status: 'cancelled', providerReference: text(link['id']) || null };
      return null;
    },
    async returned({ reference, providerReference }) {
      if (providerReference === null || providerReference === '') return null;
      const result = linkResult(reference, await fetchLink(providerReference));
      return result?.status === 'pending' ? null : result;
    },
    async status(reference, _mode, providerReference) {
      if (!ready || providerReference === null || providerReference === '') return null;
      return linkResult(reference, await fetchLink(providerReference));
    },
  };
}

/** Razorpay with its keys from the environment, read on first use. */
export function razorpayFromEnvironment(env: NodeJS.ProcessEnv = process.env): PaymentAdapter {
  let made: PaymentAdapter | undefined;
  const real = () =>
    (made ??= razorpayAdapter({
      keyId: env['KOSH_RAZORPAY_KEY_ID'],
      keySecret: env['KOSH_RAZORPAY_KEY_SECRET'],
      baseUrl: env['KOSH_RAZORPAY_BASE_URL'],
    }));
  return {
    code: 'razorpay',
    configured: (mode) => real().configured(mode),
    createPayment: (request) => real().createPayment(request),
    verifyCallback: (call, secret) => real().verifyCallback(call, secret),
    readCallback: (call) => real().readCallback(call),
    returned: (input) => real().returned?.(input) ?? Promise.resolve(null),
    status: (reference, mode, providerReference) =>
      real().status(reference, mode, providerReference),
  };
}
