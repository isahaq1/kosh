# Integrations

How other systems work with Shutro ERP (RFC 0017): they call its API with **API keys** ([server.md](server.md#api-keys-and-service-accounts)),
and it tells them what happens with **webhooks**. Inbound webhooks, online payments and OAuth apps come next.

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
