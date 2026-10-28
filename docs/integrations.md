# Integrations

How other systems work with Shutro ERP (RFC 0017): they call its API with **API keys** ([server.md](server.md#api-keys-and-service-accounts)),
it tells them what happens with **webhooks**, and they tell it with **inbound webhooks**. Online payments and OAuth
apps come next.

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
