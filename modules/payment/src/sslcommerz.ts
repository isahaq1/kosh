/**
 * The SSLCommerz adapter (Bangladesh; RFC 0017 §5.5), on its v4 API: a session (`gwprocess/v4/api.php`) gives the
 * page to send the customer to; the IPN (a form POST to the provider's inbound webhook) is **not trusted as sent** —
 * a paid one is confirmed with the Order Validation API (`val_id`) and must agree with it on the transaction, amount
 * and currency; a failed or cancelled one is confirmed with the transaction query (`tran_id`), which must show no
 * successful attempt. The same query answers when the customer returns before the IPN.
 *
 * Credentials come from the environment, never from records: `SHUTRO_ERP_SSLCOMMERZ_STORE_ID`,
 * `SHUTRO_ERP_SSLCOMMERZ_STORE_PASSWORD`, and `SHUTRO_ERP_SSLCOMMERZ_SANDBOX` (`true` unless `false`): one store per
 * installation, sandbox for providers in test mode, live for live ones.
 */
import type { InboundCall } from '@kosh/modules-sdk';
import type { PaymentAdapter, PaymentResult, PaymentStatus } from './providers.js';

export interface SslcommerzOptions {
  readonly storeId?: string | undefined;
  readonly storePassword?: string | undefined;
  /** The sandbox (default) or the live system. */
  readonly sandbox?: boolean;
  /** The HTTP client (tests). */
  readonly fetch?: typeof fetch;
}

const HOSTS = {
  sandbox: 'https://sandbox.sslcommerz.com',
  live: 'https://securepay.sslcommerz.com',
};

type Fields = Record<string, string>;
/** The IPN's fields: a form post (or JSON, which some integrations send). */
function fieldsOf(call: InboundCall): Fields {
  if (call.json !== null && typeof call.json === 'object' && !Array.isArray(call.json))
    return Object.fromEntries(
      Object.entries(call.json as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]),
    );
  return Object.fromEntries(new URLSearchParams(call.body));
}
/** What was paid, in the transaction's currency (`currency_type` / `currency_amount` when it was not BDT). */
const paidAmount = (f: Fields) => f['currency_amount'] || f['amount'] || '';
const paidCurrency = (f: Fields) => f['currency_type'] || f['currency'] || '';
const same = (a: string, b: string) =>
  a !== '' && b !== '' && Number(a).toFixed(2) === Number(b).toFixed(2);
const IPN_STATUS: Readonly<Record<string, PaymentStatus>> = {
  VALID: 'done',
  VALIDATED: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'cancelled',
};
const countryName = (code: string | null) => {
  if (code === null || code === '') return 'Bangladesh';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
};

export function sslcommerzAdapter(options: SslcommerzOptions = {}): PaymentAdapter {
  const storeId = options.storeId ?? '';
  const storePassword = options.storePassword ?? '';
  const sandbox = options.sandbox ?? true;
  const host = sandbox ? HOSTS.sandbox : HOSTS.live;
  const http = options.fetch ?? fetch;
  const ready = storeId !== '' && storePassword !== '';
  const credentials = () => {
    if (!ready)
      throw new Error(
        'SSLCommerz is not configured: set SHUTRO_ERP_SSLCOMMERZ_STORE_ID and SHUTRO_ERP_SSLCOMMERZ_STORE_PASSWORD.',
      );
    return { store_id: storeId, store_passwd: storePassword };
  };
  const getJson = async (path: string, query: Fields): Promise<Record<string, unknown>> => {
    const url = `${host}${path}?${new URLSearchParams({ ...query, ...credentials(), format: 'json' })}`;
    const res = await http(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`SSLCommerz answered ${res.status}.`);
    return (await res.json()) as Record<string, unknown>;
  };
  /** The attempts SSLCommerz knows for a transaction id. */
  const attempts = async (reference: string): Promise<Fields[] | null> => {
    const answer = await getJson('/validator/api/merchantTransIDvalidationAPI.php', {
      tran_id: reference,
    });
    if (answer['APIConnect'] !== 'DONE') return null;
    const element = Array.isArray(answer['element'])
      ? (answer['element'] as Record<string, unknown>[])
      : [];
    return element.map((e) =>
      Object.fromEntries(Object.entries(e).map(([k, v]) => [k, String(v ?? '')])),
    );
  };

  return {
    code: 'sslcommerz',
    configured: (mode) => ready && (mode === 'test') === sandbox,
    async createPayment(request) {
      const body = new URLSearchParams({
        ...credentials(),
        total_amount: request.amount,
        currency: request.currency,
        tran_id: request.reference,
        success_url: request.returnUrl,
        fail_url: request.returnUrl,
        cancel_url: request.returnUrl,
        ipn_url: request.callbackUrl,
        cus_name: request.customer.name || 'Customer',
        cus_email: request.customer.email ?? '',
        cus_add1: request.customer.street ?? 'N/A',
        cus_city: request.customer.city ?? 'N/A',
        cus_postcode: request.customer.zip ?? '0000',
        cus_country: countryName(request.customer.country),
        cus_phone: request.customer.phone ?? 'N/A',
        shipping_method: 'NO',
        product_name: request.description,
        product_category: 'Invoice',
        product_profile: 'general',
        emi_option: '0',
        value_a: request.reference,
      });
      const res = await http(`${host}/gwprocess/v4/api.php`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const page = answer['GatewayPageURL'];
      if (answer['status'] !== 'SUCCESS' || typeof page !== 'string' || page === '')
        throw new Error(
          `SSLCommerz refused the payment: ${String(answer['failedreason'] ?? res.status)}.`,
        );
      return { redirectUrl: page };
    },
    async verifyCallback(call) {
      const f = fieldsOf(call);
      const reference = f['tran_id'] ?? '';
      const status = IPN_STATUS[f['status'] ?? ''];
      if (reference === '' || status === undefined || !ready) return null;
      if (status === 'done') {
        // Paid: SSLCommerz confirms this val_id, for this transaction, amount and currency.
        const valId = f['val_id'] ?? '';
        if (valId === '') return null;
        const v = await getJson('/validator/api/validationserverAPI.php', { val_id: valId });
        const fv = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x ?? '')]));
        const confirmed =
          (fv['status'] === 'VALID' || fv['status'] === 'VALIDATED') &&
          fv['tran_id'] === reference &&
          same(paidAmount(fv), paidAmount(f)) &&
          paidCurrency(fv) === paidCurrency(f);
        return confirmed ? valId : null;
      }
      // Failed or cancelled: SSLCommerz knows the transaction and no attempt of it succeeded.
      const known = await attempts(reference);
      if (known === null || known.length === 0) return null;
      if (known.some((a) => a['status'] === 'VALID' || a['status'] === 'VALIDATED')) return null;
      return `${reference}:${f['status']}:${f['val_id'] || f['tran_date'] || ''}`;
    },
    readCallback(call) {
      const f = fieldsOf(call);
      const status = IPN_STATUS[f['status'] ?? ''];
      if ((f['tran_id'] ?? '') === '' || status === undefined) return null;
      return {
        reference: f['tran_id'] as string,
        status,
        providerReference: f['bank_tran_id'] || f['val_id'] || null,
        ...(status === 'done' ? { amount: paidAmount(f), currency: paidCurrency(f) } : {}),
        ...(f['error'] ? { error: f['error'] } : {}),
      };
    },
    async status(reference) {
      if (!ready) return null;
      const known = await attempts(reference);
      if (known === null || known.length === 0) return null;
      const paid = known.find((a) => a['status'] === 'VALID' || a['status'] === 'VALIDATED');
      if (paid !== undefined)
        return {
          reference,
          status: 'done',
          providerReference: paid['bank_tran_id'] || paid['val_id'] || null,
          amount: paidAmount(paid),
          currency: paidCurrency(paid),
        } satisfies PaymentResult;
      if (known.some((a) => a['status'] === 'PENDING'))
        return { reference, status: 'pending', providerReference: null };
      const last = known.at(-1);
      return {
        reference,
        status: 'failed',
        providerReference: last?.['val_id'] || null,
        ...(last?.['error'] ? { error: last['error'] } : {}),
      };
    },
  };
}

/** SSLCommerz with its credentials from the environment, read on first use (after the server applied its names). */
export function sslcommerzFromEnvironment(env: NodeJS.ProcessEnv = process.env): PaymentAdapter {
  let made: PaymentAdapter | undefined;
  const real = () =>
    (made ??= sslcommerzAdapter({
      storeId: env['KOSH_SSLCOMMERZ_STORE_ID'],
      storePassword: env['KOSH_SSLCOMMERZ_STORE_PASSWORD'],
      sandbox: env['KOSH_SSLCOMMERZ_SANDBOX'] !== 'false',
    }));
  return {
    code: 'sslcommerz',
    configured: (mode) => real().configured(mode),
    createPayment: (request) => real().createPayment(request),
    verifyCallback: (call, secret) => real().verifyCallback(call, secret),
    readCallback: (call) => real().readCallback(call),
    status: (reference, mode, providerReference) =>
      real().status(reference, mode, providerReference),
  };
}
