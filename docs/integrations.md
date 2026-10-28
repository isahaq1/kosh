# Integrations

How other systems work with Shutro ERP (RFC 0017): they call its API with **API keys** ([server.md](server.md#api-keys-and-service-accounts)),
it tells them what happens with **webhooks**, they tell it with **inbound webhooks**, and customers pay invoices
**online** through payment providers. OAuth apps come next.

## Webhooks

The **Integrations** app (access level *Integrations manager*) lists the webhooks of the company and every
delivery. A webhook has a URL, the events it wants, a signing secret, and the user it acts as (default: who made
it) — the record in each payload is what that user would get from `GET /api/v1/models/<model>/<id>`, their fields
and record rules applied; a record they may not read is not sent at all.

**Events**:

- `<model>.created`, `<model>.updated`, `<model>.deleted` for every model the API serves (`res.partner.created`,
  `sale.order.updated`…);
- the events modules declare: `account.move.posted` (an entry, invoice or bill posted), `sale.order.confirmed`;
- `webhook.ping`, sent by **Send a test event**.

`GET /api/v1/webhooks/events` lists them for an installation; a module declares its own in its manifest:

```ts
export const crm = defineModule({
  // …
  events: [{ topic: 'crm.lead.won', model: 'crm.lead', label: 'Lead won' }], // env.emit('crm.lead.won', { id })
});
```

**A delivery** is a `POST` of JSON:

```http
POST /your/endpoint
Content-Type: application/json
User-Agent: Shutro-ERP-Webhooks/1
X-Shutro-Event: res.partner.created
X-Shutro-Delivery: 6f1c…              # the event's id: the same on a replay — deduplicate by it
X-Shutro-Signature: t=1793180000,v1=5d3e…

{ "id": "6f1c…", "event": "res.partner.created", "occurredAt": "2026-10-28T09:30:00.000Z",
  "data": { "model": "res.partner", "id": 42, "record": { "id": 42, "name": "Bengal Steel", … } } }
```

**Checking the signature** (the receiver's side): compute HMAC-SHA256 of `"<t>.<raw body>"` with the webhook's
secret, compare it with `v1` in constant time, and refuse old `t` (more than five minutes) against replays:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret: string, header: string, body: string): boolean {
  const t = /t=(\d+)/.exec(header)?.[1];
  const v1 = /v1=([0-9a-f]+)/.exec(header)?.[1];
  if (t === undefined || v1 === undefined || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

**Retries and the log**: an answer other than 2xx (or none within 10 seconds) is retried with back-off — eight
attempts in all; each attempt's status, response (2 KB), time and error is on the delivery, and the webhook counts
its failures in a row. **Send again** on a delivery replays the same event. A webhook can be switched off, and its
secret replaced (**New signing secret**).

**Where webhooks may go**: https URLs (http only for `localhost`) on the allow-list `SHUTRO_ERP_WEBHOOK_HOSTS`
(comma-separated, `*.example.com` allowed; automation's `SHUTRO_ERP_AUTOMATION_WEBHOOK_HOSTS` when unset). The list
is checked when a webhook is made through `POST /api/v1/webhooks/subscriptions` and again before every delivery.

| Route | |
|---|---|
| `GET /api/v1/webhooks/events` | the events offered |
| `POST /api/v1/webhooks/subscriptions` `{ name, url, events, runAs? }` | a webhook (URL and events checked); the answer has its secret |
| `POST /api/v1/webhooks/subscriptions/:id/ping` | a test event |
| `POST /api/v1/webhooks/subscriptions/:id/rotate-secret` | a new secret |
| `POST /api/v1/webhooks/deliveries/:id/replay` | the same event, delivered again |

Webhooks and deliveries are also models of the generated API (`webhook.subscription`, `webhook.delivery`), so they
can be listed, filtered and exported like any other.

## Inbound webhooks

Other systems — a web shop, a payment provider, a form on the website — tell Shutro ERP what happened by calling an
**inbound webhook**. A module declares the endpoints it handles; a company switches one on in **Integrations ›
Inbound webhooks**, which gives the URL to paste into the provider and the secret calls are checked with.

```ts
import { hmacVerifier } from '@kosh/integrations';

export const shop = defineModule({
  // …
  inboundWebhooks: [
    {
      key: 'orders',
      label: 'Orders from the web shop',
      // The provider signs the raw body: X-Shop-Signature: sha256=<hex HMAC-SHA256>. The event id makes calls idempotent.
      verify: hmacVerifier({
        header: 'X-Shop-Signature',
        prefix: 'sha256=',
        eventId: (call) => (call.json as { id?: string } | null)?.id,
      }),
      // Runs as the system in the endpoint's company, in a job; a throw is retried.
      handle: async (env, call) => {
        const order = call.json as { ref: string; total: string };
        const made = await (env as Env).model('shop.order').create([{ ref: order.ref, total: order.total }]);
        return `shop.order ${made.ids[0]}`; // shown in the log
      },
    },
  ],
});
```

A `verify` of its own receives the call (`headers` in lower case, `query`, the raw `body`, its `json`) and the
endpoint's secret, and returns the provider's event id — or `null` to refuse the call.

**A call** to `POST /api/v1/hooks/<token>` needs no sign-in (it is rate limited per address):

| Answer | When |
|---|---|
| `202 { received: true, eventId }` | verified; stored and queued for the module |
| `200 { duplicate: true, eventId }` | an event id this endpoint already received: not handled again |
| `401` | `verify` refused it; stored as *Refused* for the log |
| `404` | no active endpoint has this token |

**Inbound calls** lists every call with its state (*Received*, *Handled*, *Failed*, *Refused*), attempts, the
handler's result or error, the headers kept (`content-type`, `user-agent` and `x-…`, never credentials) and the body.
A failing handler is retried with back-off, six attempts in all; **Handle again** runs a verified call once more,
after the cause is fixed. **New secret** on an endpoint refuses calls signed with the old one.

| Route | |
|---|---|
| `POST /api/v1/hooks/:token` | the provider's call |
| `GET /api/v1/webhooks/hooks` | the endpoints the installed modules offer |
| `POST /api/v1/webhooks/endpoints` `{ name?, hook }` | an endpoint (`hook` is `<module>.<key>`); the answer has its `path` and `secret` |
| `POST /api/v1/webhooks/endpoints/:id/rotate-secret` | a new secret |
| `POST /api/v1/webhooks/inbound/:id/replay` | a verified call, handled again |

Endpoints and calls are models of the generated API too (`webhook.endpoint`, `webhook.inbound`).

## Online payments

The `payment` module (with Accounting, the portal's `account_portal` and Integrations) lets customers pay their
invoices from the portal. A company sets up its **payment providers** in **Accounting › Configuration › Payment
providers**: the provider, its mode (*Test*, *Live* or *Disabled*) and the bank journal the money arrives in.
Credentials are never stored in records: each adapter reads its own from the environment.

**The customer's way**: an open invoice in the portal has **Pay now** (one button per provider when there are
several) → the provider's page → back to the invoice, which shows *Thank you: your payment of … is received* (or why
it failed). Behind it:

1. `POST /api/portal/v1/payments` checks that the invoice is the customer's and open, makes a **transaction**
   (`payment.transaction`: the invoice, what is due, a reference `PAY-…`) and asks the provider for its page.
2. The provider calls back the provider's **inbound webhook** (made with its first payment: Integrations › Inbound
   webhooks shows it, with its URL and secret), checked by the adapter and logged in Inbound calls, with retries and
   replay.
3. Paid: Accounting registers an `account.payment` for the invoice in the provider's journal — posted and reconciled,
   memo `<provider> <provider's reference>` — and the transaction is *Paid*. Declined or cancelled: the transaction
   says so and the invoice stays open.
4. Back before the callback: the portal asks for the payment (`GET /api/portal/v1/payments/:reference`) and the server
   asks the provider, settling it then.

**Once only**: a repeated callback, a replay from the log, or a callback after the return never pays twice — the
transaction is settled under a lock on its reference, and a paid one stays as it is (a failed or cancelled one
becomes paid if the provider confirms the payment later). An amount or currency that
differs from the transaction's is refused (*Failed*, with both amounts).

**Online payments** (Accounting) lists the transactions with their state, the provider's reference and the payment.

**Providers**:

- **Test provider** (`fake`): moves no money — its own checkout page lets you pay or decline — for trying the flow
  and for tests; it cannot be *Live*.
- **SSLCommerz** (`sslcommerz`, Bangladesh: cards, bKash, Nagad, Rocket and banks through its checkout): set
  `SHUTRO_ERP_SSLCOMMERZ_STORE_ID`, `SHUTRO_ERP_SSLCOMMERZ_STORE_PASSWORD` and `SHUTRO_ERP_SSLCOMMERZ_SANDBOX`
  (`true` unless `false`). One store per installation: with the sandbox, providers in *Test* mode are offered; with
  the live store, *Live* ones. Its IPN is never trusted as sent: a paid one is confirmed with SSLCommerz's order
  validation API (`val_id`), which must agree on the transaction, amount and currency; a failed one with its
  transaction query; the same query answers when the customer is back before the IPN.
- **bKash** (`bkash`, direct: the customer pays from their bKash wallet with OTP and PIN; BDT only): set
  `SHUTRO_ERP_BKASH_USERNAME`, `…_PASSWORD`, `…_APP_KEY`, `…_APP_SECRET` and `…_SANDBOX` (`true` unless `false`);
  `…_BASE_URL` overrides the API's address (default: bKash's tokenized checkout v2, sandbox or live). bKash has no
  server-to-server callback in this flow: it sends the customer back with `status=success|failure|cancel`, and the
  payment completes only when Shutro ERP **executes** it — which it does on that return, for the transaction's own
  bKash payment id, believing only bKash's answer (completed, for this invoice and amount). A forged "success" makes
  bKash refuse; a payment left on bKash's page stays pending and costs the customer nothing.
- **Razorpay** (`razorpay`, India: UPI, cards, netbanking, wallets through a Payment Link): set
  `SHUTRO_ERP_RAZORPAY_KEY_ID` and `SHUTRO_ERP_RAZORPAY_KEY_SECRET` — test keys (`rzp_test_…`) serve providers in
  *Test* mode, live keys *Live* ones. In Razorpay's dashboard, add a webhook for `payment_link.paid` (and
  `payment_link.expired` / `payment_link.cancelled`) with the provider's endpoint URL and **the endpoint's secret**
  (Integrations › Inbound webhooks, made with the first payment): `X-Razorpay-Signature` is checked with it and
  `x-razorpay-event-id` makes redeliveries harmless. On the customer's return the link is fetched from Razorpay.
- **Stripe** (`stripe`, cards and local methods worldwide through Checkout): set `SHUTRO_ERP_STRIPE_SECRET_KEY`
  (a secret or restricted key; `sk_test_…` serves *Test* providers, `sk_live_…` *Live* ones). In Stripe's dashboard,
  add a webhook endpoint with the provider's endpoint URL for `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and
  `checkout.session.expired`; Stripe shows its signing secret (`whsec_…`): paste it into **the endpoint's Secret**
  (Integrations › Inbound webhooks). `Stripe-Signature` is checked with it, events older than five minutes are
  refused, and the event id makes redeliveries harmless. On the customer's return the session is fetched from
  Stripe.

A provider is offered in the portal only when its adapter has credentials for the provider's mode. An adapter
implements:

```ts
interface PaymentAdapter {
  readonly code: string;
  configured(mode: 'test' | 'live'): boolean; // its credentials are set for this mode
  createPayment(request: PaymentRequest): Promise<{ redirectUrl: string }>; // reference, amount, customer, URLs
  verifyCallback(call: InboundCall, secret: string): string | null | Promise<string | null>; // event id, or null
  readCallback(call: InboundCall): PaymentResult | null; // reference, status, provider's reference, amount
  status(reference: string, mode: 'test' | 'live', providerReference: string | null): Promise<PaymentResult | null>;
  returned?(input: { reference; providerReference; mode; query }): Promise<PaymentResult | null>; // on the return
}
```

**Addresses**: providers send customers back (GET or POST) to `SHUTRO_ERP_API_URL` + `/api/v1/payment/return/<reference>`,
which forwards them to the invoice in the portal (`SHUTRO_ERP_PORTAL_URL` + `/d/invoices/<id>?payment=<reference>`),
and call back at `SHUTRO_ERP_API_URL` + `/api/v1/hooks/<token>`; both must be the public addresses in production.
