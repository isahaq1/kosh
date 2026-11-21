/**
 * Payments pushed to a customer who stands at a counter (RFC 0021, Counter step 5): the test provider's phone and
 * terminal, Razorpay's link texted to a phone, Stripe's card reader — each against stubbed HTTP, in the shapes the
 * providers publish. What they push is followed like any other payment: `status` and the callbacks.
 */
import { createHmac } from 'node:crypto';
import { expect, test } from 'vitest';
import { fakeAdapter, type InPersonRequest, razorpayAdapter, stripeAdapter } from '../src/index.js';

const request = (way: 'phone' | 'terminal', to: string, reference: string): InPersonRequest => ({
  reference,
  amount: '1250.00',
  currency: 'INR',
  description: 'POS/0007 · Card',
  customer: {
    name: '',
    email: null,
    phone: null,
    street: null,
    city: null,
    zip: null,
    country: null,
  },
  returnUrl: 'https://api.example.test/back',
  callbackUrl: 'https://api.example.test/api/v1/hooks/tok',
  mode: 'test',
  way,
  to,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the test provider: a phone and a terminal, pending until paid on the test page; a reader that is off', async () => {
  expect(fakeAdapter.inPerson?.ways).toEqual(['phone', 'terminal']);
  await fakeAdapter.inPerson?.push(request('phone', '+8801711000111', 'TX-PHONE'));
  expect(fakeAdapter.pushed('TX-PHONE')).toEqual({ way: 'phone', to: '+8801711000111' });
  expect((await fakeAdapter.status('TX-PHONE', 'test', null))?.status).toBe('pending');
  // The customer pays: the same word as a payment with a page.
  expect(fakeAdapter.complete('TX-PHONE', true, 'secret')).not.toBeNull();
  const paid = await fakeAdapter.status('TX-PHONE', 'test', null);
  expect(paid).toMatchObject({ status: 'done', amount: '1250.00', currency: 'INR' });
  expect(paid).not.toHaveProperty('pushed');
  expect(fakeAdapter.pushed('TX-PHONE')).toEqual({ way: 'phone', to: '+8801711000111' });
  await expect(
    fakeAdapter.inPerson?.push(request('terminal', 'offline', 'TX-OFF')),
  ).rejects.toThrow('does not answer');
  expect(fakeAdapter.pushed('TX-OFF')).toBeNull();
});

test('Razorpay: the payment link texted to the phone, followed like a link the customer opened', async () => {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const adapter = razorpayAdapter({
    keyId: 'rzp_test_padma',
    keySecret: 'secret',
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (init?.method === 'POST')
        return json({ id: 'plink_1', short_url: 'https://rzp.io/i/abc', reference_id: 'TX-1' });
      return json({
        id: 'plink_1',
        reference_id: 'TX-1',
        status: 'paid',
        currency: 'INR',
        amount_paid: 125000,
        payments: [{ payment_id: 'pay_9' }],
      });
    }) as typeof fetch,
  });
  expect(adapter.inPerson?.ways).toEqual(['phone']);
  const pushed = await adapter.inPerson?.push(request('phone', '+91 98765-43210', 'TX-1'));
  expect(pushed).toEqual({ providerReference: 'plink_1' });
  expect(calls[0]?.path).toBe('/v1/payment_links');
  expect(calls[0]?.body).toMatchObject({
    amount: 125000,
    currency: 'INR',
    reference_id: 'TX-1',
    customer: { contact: '+919876543210' },
    notify: { sms: true, email: false },
  });
  expect(await adapter.status('TX-1', 'test', 'plink_1')).toMatchObject({
    status: 'done',
    amount: '1250.00',
    providerReference: 'pay_9',
  });
  // Not a phone number: refused before Razorpay is asked.
  await expect(adapter.inPerson?.push(request('phone', '12', 'TX-2'))).rejects.toThrow(
    '8 to 14 digits',
  );
  expect(calls.filter((c) => c.path === '/v1/payment_links')).toHaveLength(1);
  // A link the customer opens is still not texted.
  await adapter.createPayment(request('phone', 'x', 'TX-3'));
  expect(calls.at(-1)?.body).toMatchObject({ notify: { sms: false } });
});

test('Stripe: a payment for a present card handed to the reader; paid, declined, and its events', async () => {
  const calls: { path: string; form: Record<string, string> }[] = [];
  let intent: Record<string, unknown> = {};
  const adapter = stripeAdapter({
    secretKey: 'sk_test_padma',
    now: () => 1_800_000_000_000,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))),
      });
      if (url.pathname === '/v1/payment_intents') {
        intent = {
          id: 'pi_1',
          status: 'requires_payment_method',
          currency: 'inr',
          amount: 125000,
          payment_method_types: ['card_present'],
          metadata: { reference: 'TX-1' },
        };
        return json(intent);
      }
      if (url.pathname === '/v1/terminal/readers/tmr_off/process_payment_intent')
        return json({ error: { message: 'Reader is currently unreachable.' } }, 400);
      if (url.pathname.endsWith('/process_payment_intent')) return json({ id: 'tmr_A1' });
      return json(intent);
    }) as typeof fetch,
  });
  expect(adapter.inPerson?.ways).toEqual(['terminal']);
  expect(await adapter.inPerson?.push(request('terminal', 'tmr_A1', 'TX-1'))).toEqual({
    providerReference: 'pi_1',
  });
  expect(calls[0]).toMatchObject({
    path: '/v1/payment_intents',
    form: {
      amount: '125000',
      currency: 'inr',
      'payment_method_types[0]': 'card_present',
      'metadata[reference]': 'TX-1',
    },
  });
  expect(calls[1]).toMatchObject({
    path: '/v1/terminal/readers/tmr_A1/process_payment_intent',
    form: { payment_intent: 'pi_1' },
  });
  // Waiting for the card; then paid.
  expect((await adapter.status('TX-1', 'test', 'pi_1'))?.status).toBe('pending');
  intent = { ...intent, status: 'succeeded', amount_received: 125000 };
  expect(await adapter.status('TX-1', 'test', 'pi_1')).toMatchObject({
    status: 'done',
    amount: '1250.00',
    currency: 'INR',
    providerReference: 'pi_1',
  });
  // Another payment's intent is not this one's word.
  expect(await adapter.status('TX-OTHER', 'test', 'pi_1')).toBeNull();
  // A declined card.
  intent = {
    ...intent,
    status: 'requires_payment_method',
    last_payment_error: { message: 'Your card was declined.' },
  };
  expect(await adapter.status('TX-1', 'test', 'pi_1')).toMatchObject({
    status: 'failed',
    error: 'Your card was declined.',
  });
  // A reader that is off, and something that is no reader's id.
  await expect(adapter.inPerson?.push(request('terminal', 'tmr_off', 'TX-2'))).rejects.toThrow(
    'unreachable',
  );
  await expect(adapter.inPerson?.push(request('terminal', '../x', 'TX-3'))).rejects.toThrow('tmr_');

  // The webhook: signed, a terminal's intent is read; a Checkout page's own intent is left to its session.
  const event = (object: Record<string, unknown>, type: string) => {
    const body = JSON.stringify({ id: 'evt_1', type, data: { object } });
    const t = 1_800_000_000;
    const v1 = createHmac('sha256', 'whsec').update(`${t}.${body}`).digest('hex');
    return {
      method: 'POST',
      headers: { 'stripe-signature': `t=${t},v1=${v1}` },
      body,
      json: JSON.parse(body) as unknown,
      query: {},
    };
  };
  const succeeded = event(
    { ...intent, status: 'succeeded', amount_received: 125000, last_payment_error: null },
    'payment_intent.succeeded',
  );
  expect(await adapter.verifyCallback(succeeded as never, 'whsec')).toBe('evt_1');
  expect(adapter.readCallback(succeeded as never)).toMatchObject({
    reference: 'TX-1',
    status: 'done',
    amount: '1250.00',
  });
  expect(
    adapter.readCallback(event(intent, 'payment_intent.payment_failed') as never),
  ).toMatchObject({ reference: 'TX-1', status: 'failed' });
  expect(
    adapter.readCallback(
      event(
        { ...intent, status: 'succeeded', payment_method_types: ['card'] },
        'payment_intent.succeeded',
      ) as never,
    ),
  ).toBeNull();
});
