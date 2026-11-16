/**
 * SSLCommerz's contract (RFC 0034 §2.2), against its sandbox with `KOSH_CERTIFY=live`, replayed from
 * `recordings/sslcommerz.json` otherwise: a session gives the sandbox's payment page; an unpaid transaction is not
 * paid; an IPN claiming a payment with a validation id SSLCommerz never issued, or a failure of a transaction it never
 * saw, is refused; wrong credentials are refused.
 *
 * Credentials: `KOSH_SSLCOMMERZ_STORE_ID` / `KOSH_SSLCOMMERZ_STORE_PASSWORD`, by default SSLCommerz's public demo
 * store from its developer documentation (`testbox`), which moves no money.
 */
import { join } from 'node:path';
import type { InboundCall } from '@kosh/modules-sdk';
import { cassette } from '@kosh/server/testing';
import { afterAll, afterEach, expect, test } from 'vitest';
import type { PaymentRequest } from '../../src/providers.js';
import { sslcommerzAdapter } from '../../src/sslcommerz.js';

const storeId = process.env['KOSH_SSLCOMMERZ_STORE_ID'] || 'testbox';
const storePassword = process.env['KOSH_SSLCOMMERZ_STORE_PASSWORD'] || 'qwerty';
const tape = cassette(join(import.meta.dirname, 'recordings', 'sslcommerz.json'), {
  adapter: 'sslcommerz',
  secrets: [storeId, storePassword],
});
const adapter = sslcommerzAdapter({ storeId, storePassword, sandbox: true, fetch: tape.fetch });
const reference = tape.vars('reference', () => `KOSH-CERT-${Date.now()}`);

let failed = false;
afterEach((ctx) => {
  if (ctx.task.result?.state === 'fail') failed = true;
});
afterAll(() => tape.save({ failed }));
/** A step of the contract: in order, never retried (a retry would send the requests again). */
const contract = (name: string, fn: () => Promise<void>) =>
  test(name, { retry: 0, timeout: 60_000 }, fn);

const request: PaymentRequest = {
  reference,
  amount: '1250.00',
  currency: 'BDT',
  description: 'Invoice INV/2026/0042',
  customer: {
    name: 'Rahim Traders',
    email: 'accounts@example.com',
    phone: '01700000000',
    street: 'House 1, Road 2',
    city: 'Dhaka',
    zip: '1207',
    country: 'BD',
  },
  returnUrl: 'https://erp.example.com/api/v1/payment/return/1',
  callbackUrl: 'https://erp.example.com/api/v1/inbound/payment.sslcommerz',
  mode: 'test',
};
const ipn = (fields: Record<string, string>): InboundCall =>
  ({
    body: new URLSearchParams(fields).toString(),
    json: null,
    headers: {},
  }) as unknown as InboundCall;

contract('a session gives the sandbox payment page', async () => {
  const { redirectUrl } = await adapter.createPayment(request);
  expect(redirectUrl).toMatch(/^https:\/\/sandbox\.sslcommerz\.com\//);
});

contract('the transaction just opened is pending: the customer may yet pay', async () => {
  const status = await adapter.status(reference, 'test', null);
  expect(status).toMatchObject({ reference, status: 'pending' });
});

contract(
  'an IPN saying the open transaction failed is refused while the customer is paying',
  async () => {
    const eventId = await adapter.verifyCallback(
      ipn({ tran_id: reference, status: 'FAILED', error: 'Declined' }),
      '',
    );
    expect(eventId).toBeNull();
  },
);

contract(
  'an IPN claiming a payment with a validation id SSLCommerz never issued is refused',
  async () => {
    const eventId = await adapter.verifyCallback(
      ipn({
        tran_id: reference,
        status: 'VALID',
        val_id: '2611161234560abcdefXYZ',
        amount: '1250.00',
        currency: 'BDT',
      }),
      '',
    );
    expect(eventId).toBeNull();
  },
);

contract('an IPN saying a transaction SSLCommerz never saw failed is refused', async () => {
  const eventId = await adapter.verifyCallback(
    ipn({ tran_id: `${reference}-UNKNOWN`, status: 'FAILED', error: 'Declined' }),
    '',
  );
  expect(eventId).toBeNull();
});

contract('wrong credentials are refused', async () => {
  const wrong = sslcommerzAdapter({
    storeId,
    storePassword: `${storePassword}-wrong`,
    sandbox: true,
    fetch: tape.fetch,
  });
  await expect(wrong.createPayment({ ...request, reference: `${reference}-W` })).rejects.toThrow(
    /SSLCommerz refused the payment/,
  );
});
