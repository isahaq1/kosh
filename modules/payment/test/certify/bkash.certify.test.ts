/**
 * bKash's contract (Tokenized Checkout v2; RFC 0034 §2.2), against its sandbox with `KOSH_CERTIFY=live`, replayed
 * from `recordings/bkash.json` otherwise: a payment gives bKash's page and its payment id; a payment the customer never
 * approved is pending, not paid; a return claiming success for it is executed and refused, not believed; wrong
 * credentials are refused.
 *
 * Credentials: `KOSH_BKASH_USERNAME` / `_PASSWORD` / `_APP_KEY` / `_APP_SECRET`, by default bKash's public demo
 * merchant from its developer documentation, which moves no money.
 */
import { join } from 'node:path';
import { cassette } from '@kosh/server/testing';
import { afterAll, afterEach, expect, test } from 'vitest';
import { bkashAdapter } from '../../src/bkash.js';
import type { PaymentRequest } from '../../src/providers.js';

const credentials = {
  username: process.env['KOSH_BKASH_USERNAME'] || 'sandboxTokenizedUser02',
  password: process.env['KOSH_BKASH_PASSWORD'] || 'sandboxTokenizedUser02@12345',
  appKey: process.env['KOSH_BKASH_APP_KEY'] || '4f6o0cjiki2rfm34kfdadl1eqq',
  appSecret:
    process.env['KOSH_BKASH_APP_SECRET'] || '2is7hdktrekvrbljjh44ll3d9l1dtjo4pasmjvs5vl5qr3fug4b',
};
const tape = cassette(join(import.meta.dirname, 'recordings', 'bkash.json'), {
  adapter: 'bkash',
  secrets: Object.values(credentials),
});
const adapter = bkashAdapter({ ...credentials, sandbox: true, fetch: tape.fetch });
const reference = tape.vars('reference', () => `KOSH-CERT-${Date.now()}`);
let paymentId = '';

// The recording is kept only when every step of the contract ran and passed (not a filtered or failed run).
let total = 0;
let passed = 0;
afterEach((ctx) => {
  if (ctx.task.result?.state === 'pass') passed += 1;
});
afterAll(() => tape.save({ failed: passed !== total }));
/** A step of the contract: in order, never retried (a retry would send the requests again). */
const contract = (name: string, fn: () => Promise<void>) => {
  total += 1;
  return test(name, { retry: 0, timeout: 60_000 }, fn);
};

const request: PaymentRequest = {
  reference,
  amount: '1250.00',
  currency: 'BDT',
  description: 'Invoice INV/2026/0042',
  customer: {
    name: 'Rahim Traders',
    email: null,
    phone: '01770618575',
    street: null,
    city: 'Dhaka',
    zip: null,
    country: 'BD',
  },
  returnUrl: 'https://erp.example.com/api/v1/payment/return/1',
  callbackUrl: 'https://erp.example.com/api/v1/inbound/payment.bkash',
  mode: 'test',
};

contract('a payment gives the bKash page and its payment id', async () => {
  const created = await adapter.createPayment(request);
  expect(created.redirectUrl).toMatch(/^https:\/\/[^/]*(bka\.sh|bkash\.com)\//);
  expect(created.providerReference).toMatch(/\w{8,}/);
  paymentId = created.providerReference ?? '';
});

contract('a payment the customer never approved is pending, not paid', async () => {
  const status = await adapter.status(reference, 'test', paymentId);
  expect(status).toMatchObject({ status: 'pending', providerReference: paymentId });
});

contract('a return claiming success for it is executed and refused, not believed', async () => {
  const result = await adapter.returned?.({
    reference,
    providerReference: paymentId,
    mode: 'test',
    query: { status: 'success', paymentID: paymentId },
  });
  expect(result?.status).not.toBe('done');
});

contract('wrong credentials are refused', async () => {
  const wrong = bkashAdapter({
    ...credentials,
    password: `${credentials.password}-wrong`,
    sandbox: true,
    fetch: tape.fetch,
  });
  await expect(wrong.createPayment({ ...request, reference: `${reference}-W` })).rejects.toThrow(
    /bKash refused/,
  );
});
