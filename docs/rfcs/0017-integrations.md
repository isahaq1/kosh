# RFC 0017: Integrations platform

- Status: accepted (2026-10-28)
- Scope: API keys and service accounts, OAuth 2.0 apps (Shutro ERP as the provider), outbound webhook
  subscriptions, inbound webhooks, online payments with provider adapters (the fourth gap chosen with RFC 0014)

## 1. Summary

Other systems talk to Shutro ERP today only by signing in as a user and holding a session token. This RFC makes
integration a first-class, permission-checked, audited part of the framework:

1. **API keys** for scripts and servers: scoped, expiring, revocable tokens that act as a user or as a **service
   account** (a non-human user with roles, no password, no 2FA prompt).
2. **OAuth 2.0 apps**: third-party applications ask a user's consent (authorization code + PKCE) and act on their
   behalf within the granted scopes; refresh tokens; the user sees and revokes them.
3. **Outbound webhooks**: subscriptions to record events (created, updated, a state change, posted, paid…) per
   model, signed, retried with back-off, with a delivery log and replay. Automation rules' webhook action becomes
   one kind of subscription.
4. **Inbound webhooks**: endpoints modules declare (`inboundWebhooks` in the manifest) for events from outside
   (a payment provider's callback, a shipping status), verified (HMAC or the provider's signature), idempotent,
   logged and replayable.
5. **Online payments**: a `PaymentProvider` adapter (create a payment for a document, verify the callback, refund
   later). The portal's invoices get **Pay now**; a confirmed payment registers an `account.payment` and reconciles
   the invoice, exactly once. Adapters for the countries Shutro ERP serves first.

## 2. Problem

- Scripts and partner systems need credentials that are not a person's password: today they hold a user's session,
  which expires, carries all of that user's rights, cannot be limited, and is not told apart in the audit log.
- Third-party apps (a mobile app, an e-commerce plugin, a BI tool) cannot ask users for limited access.
- Outbound events exist only inside automation rules; integrators want "tell me when an invoice is paid" without
  writing a rule, with a log to see what was sent and to resend.
- Nothing receives events from outside in a standard, verified way.
- Customers cannot pay an invoice online; accountants register every payment by hand.

## 3. How Odoo does it, and its weaknesses

- **API keys** (per user, in preferences): they carry all of the user's rights, no scopes, no expiry by default,
  no last-use; XML-RPC / JSON-RPC only.
- **OAuth**: Odoo is an OAuth *client* (sign in with Google), not a provider for third-party apps.
- **Webhooks**: automated actions can "send a webhook notification" (unsigned, no retry, no delivery log) and
  receive one (an unauthenticated URL with a secret in it).
- **Payments**: many providers (Stripe, Adyen, PayPal, Razorpay…) with a solid model of transactions, but tied to
  the website / portal stack; regional providers vary by edition.

Shutro ERP can do better on all four with what it has: REST with OpenAPI and a typed client, server-side
permissions, the audit log, the transactional outbox and jobs.

## 4. Options

- **A. One integrations package (`@kosh/integrations`) on the server's auth and the outbox** — keys, service
  accounts and OAuth are new kinds of credential the server's authentication understands; webhooks run on the
  outbox and jobs; payments are a module (`payment`) with adapters, bridged to Accounting and the portal.
- **B. An external gateway** (Kong, an API management service) in front of the API — keys and OAuth there,
  webhooks elsewhere. Another system to run, and it cannot see record rules or the audit log.
- **C. Only API keys now** — quick, but leaves partners without OAuth and customers without online payment.

## 5. Recommendation: A

### 5.1 Credentials: API keys and service accounts

- `auth.api_key`: a name, the user it acts as (a person, or a service account), **scopes**, an expiry (default 1
  year, at most 2), last use (time, address), created by. The secret is shown once (`sk_live_…` with a visible
  prefix), stored as a hash, compared in constant time.
- **Scopes** narrow, never widen: `read:<app>`, `write:<app>` (create / update / delete on its models), `export`,
  `act:<permission>` (e.g. `act:account.post`); `*` for all the user's rights. A request with a key is checked
  against the key's scopes **and** the user's ACL, field security and record rules — both must allow.
- **Service accounts**: `res.users` flagged as service (no password, no sign-in, no 2FA, no seat in the UI's user
  list by default), with roles like any user; every change they make is audited under their name and the key's.
- Header `Authorization: Bearer sk_…` (or `X-Api-Key`); rate limits per key (Valkey); revocation is immediate.
- Screens: Settings › Users › a user's API keys (their own, or service accounts' for administrators); create
  with scopes and expiry, revoke, see last use.

### 5.2 OAuth 2.0 apps (Shutro ERP as the provider)

- `oauth.app`: name, logo, redirect URIs, confidential or public (PKCE required for public), allowed scopes,
  owner. Client id; client secret (hashed) for confidential apps.
- **Authorization code + PKCE** (`/oauth/authorize` with a consent screen listing the scopes in words,
  `/oauth/token`, `/oauth/revoke`, discovery at `/.well-known/oauth-authorization-server`). Access tokens short
  (1 hour), refresh tokens rotated, both hashed; the grant is per user and app, listed and revocable by the user.
- The same scope model as keys; tokens act as the consenting user, inside the scopes.
- Not in this RFC: Shutro ERP as an OpenID Connect provider for single sign-on, and signing in *with* Google /
  Microsoft (the auth decision of 2026-10-18 places them on the same models later).

### 5.3 Outbound webhooks

- `webhook.subscription`: a URL (HTTPS; the allow-list of automation applies), events (`<model>.created`,
  `<model>.updated` with fields, `<model>.<transition>`, module events such as `account.move.posted`,
  `account.move.paid`), an optional filter (a domain), the secret, active, created by, acting as (whose read rights
  decide what the payload may contain).
- Delivery: from the outbox, a job per delivery, `POST` JSON `{ id, event, occurredAt, data }`, headers
  `X-Shutro-Event`, `X-Shutro-Delivery`, `X-Shutro-Signature: t=…,v1=hmac-sha256(t.body)` (timestamped against
  replay); retries with exponential back-off for 24 hours, then the subscription is flagged; a delivery log
  (status, attempts, response code and time) with replay.
- Automation's webhook action keeps working and appears in the same log. The existing `X-Kosh-Signature` header
  stays for those, for compatibility.

### 5.4 Inbound webhooks

- Modules declare endpoints: `inboundWebhooks: [{ key: 'sslcommerz.ipn', verify, handle }]` → `POST
  /api/v1/hooks/<module>/<key>`. `verify` checks the provider's signature (or an HMAC with a secret configured per
  company); unverified calls are refused and logged.
- Every call is stored (`webhook.inbound`: headers, body, verified, result), handled in a job (as a service account
  of the module, with the rights the manifest declares), **idempotent** by the provider's event id, replayable from
  the log.

### 5.5 Online payments

- Module `payment`: `payment.provider` (per company: the adapter, its mode `test` / `live`, credentials from the
  secret store — never in records — and which journals it pays into), `payment.transaction` (document, amount,
  currency, provider reference, state `pending` → `authorized` / `done` / `failed` / `cancelled`, the
  `account.payment` it made).
- Adapter interface `PaymentProvider`: `createPayment(document, return URLs) → redirect URL or client secret`,
  `verifyCallback(request) → event`, `fetch(reference)` (to confirm a status on return), later `refund`.
- Flow: the portal's invoice (and an emailed payment link) shows **Pay now** → the provider's page → the provider's
  callback (an inbound webhook) and the customer's return both confirm against the provider → the transaction is
  `done` → an `account.payment` is registered and the invoice reconciled, **once** (idempotency by the provider's
  reference). The customer sees the invoice paid; the accountant sees the payment with the provider's reference
  and fee.
- First adapters (open question 1): **SSLCommerz** and **bKash** (Bangladesh), **Razorpay** (India), **Stripe**
  (everywhere else); a **fake** provider for tests and demonstrations, as for e-invoicing.

### 5.6 Security and operations

- Every credential is hashed; secrets are shown once; everything is audited (key created / used / revoked, app
  consent, webhook subscription changes, payments).
- Rate limits per key, per app and per inbound endpoint; circuit breakers for payment providers.
- OpenAPI documents the security schemes (bearer session, API key, OAuth 2.0 with scopes); the typed client takes
  any of them.

### 5.7 Tests

- Keys: scopes narrow the user's rights (read-only key refused on write; another app's model refused), expiry,
  revocation, service accounts, audit, rate limit.
- OAuth: the code flow with PKCE, wrong verifier / redirect refused, refresh rotation, revocation, consent listing.
- Webhooks out: an event delivered signed, a failure retried, replay; the payload limited by the acting user's
  rights. In: a verified call handled once (a duplicate ignored), an unverified one refused.
- Payments: the fake provider end to end (portal Pay now → callback → payment → invoice paid), a duplicate callback,
  a failed payment, the return before the callback.
- E2E: create an API key and call the API with it; pay an invoice in the portal.

## 6. Delivery plan (each step reviewed)

1. API keys, scopes and service accounts (server auth, Settings screens, OpenAPI security schemes).
2. Outbound webhook subscriptions with the delivery log and replay; automation's action on the same log.
3. Inbound webhooks (manifest declaration, verification, log, idempotency, replay).
4. Payments: the `payment` module, the fake provider, the portal's Pay now, Accounting registration; then the first
   real adapters (with sandbox accounts).
5. OAuth 2.0 apps (provider, consent, tokens, revocation, the apps screen).

## 7. Open questions (answers wanted with the approval)

1. **Payment providers first**: SSLCommerz + bKash (Bangladesh), Razorpay (India), Stripe — which ones, in what
   order? Each needs a sandbox account to test the real adapter.
2. **OAuth in this RFC** (step 5), or later on demand?
3. **Service accounts**: count as users for any future licensing / seat count, or not?

## Decisions (2026-10-28)

1. **Payment providers**: real adapters for SSLCommerz, bKash, Razorpay and Stripe, after the fake provider; each
   tested on its sandbox when an account is available.
2. **OAuth 2.0 apps** are in this RFC, as step 5.
3. **Service accounts** do not count as seats (nothing counts seats today); to revisit if licensing comes.

## Implementation notes (2026-10-28): step 1 — API keys and service accounts

- **`auth.api_key`** (private): name, user, the secret's SHA-256 digest and its prefix, scopes, expiry (1–730 days),
  last use (time, address), revoked, issued by. `res.users.isService`: service accounts have no credential, so they
  never sign in; they are never administrators.
- **Authentication**: `X-Api-Key` or `Authorization: Bearer sk_…`, looked up (cached `cacheMs`) before sessions; the
  identity is the user's, with the key's scopes; administrator groups never count through a key (they need a session
  with a second factor). An unknown `X-Api-Key` is 401; a bearer `sk_…` that is no key is tried as a session.
- **Scopes** are enforced in the server's request hook, not in the ORM (Shutro can add rights to a unit of work, not
  remove them): the route's app is the module that registered it (routes are tagged while each module registers
  them) or the owner of its `:model`; no app → `*` only. GET / HEAD read; everything else writes. Credential routes
  refuse keys. The ORM still applies the user's ACL, field security and record rules.
- **Routes**: keys (list, create — the secret once —, revoke), service accounts (administrators with their second
  factor), the scopes of the installation. OpenAPI declares the `session`, `apiKey` and `cookie` security schemes.
  Rate limits per key.
- **Screen**: API keys in the user menu, for every signed-in user, outside any app — a new kind of page the shell
  serves at `/me/<name>` (`registry.registerUserPage`), so the Settings app stays with the App manager and users
  without roles still see no apps. English and Bangla.
- **Tests**: scopes on model and module routes (read refused on write, another app refused, `*`), listing without
  secrets and with last use, invalid scopes and expiry, no key management with a key, unknown / revoked / expired keys,
  audit; service accounts (administrators only, no sign-in, keys for them). E2E: create, use, refuse, revoke.
- Not in this step: `export` and `act:<permission>` scopes (RFC §5.1) — exports and actions follow read / write.

## Implementation notes (2026-10-28): step 2 — outbound webhooks

- **`@kosh/integrations`**, the Integrations app (`integrations.manager`): `webhook.subscription` (URL, events, signing
  secret, acting user, failures in a row, last delivery) and `webhook.delivery` (event, payload, state, attempts,
  response status and body, duration, error, replay of).
- **Events**: Shutro's change events of every served model (`<model>.created|updated|deleted`; the module turns
  them on with `changeEvents: '*'`), and the events modules declare in their manifests (`events: [{ topic, model,
  label }]` — `account.move.posted`, `sale.order.confirmed`), each read by an outbox subscriber. Events of no
  company (installation work) are skipped.
- **Payloads**: `{ id, event, occurredAt, data: { model, id, record, …the event's own fields } }`; the record is what
  `GET /api/v1/models/<model>/<id>` gives the webhook's user (`readApiRecord`, now exported by the server); a record
  they may not read is not sent; one deleted since is sent without its record.
- **Delivery**: a job per delivery (8 attempts, Shutro's back-off), each attempt recorded in its own transaction so
  retries keep it; headers `X-Shutro-Event`, `X-Shutro-Delivery` (the event id, kept by replays) and
  `X-Shutro-Signature: t=…,v1=…` (HMAC-SHA256 of `"<t>.<body>"`); no redirects followed; the allow-list
  (`SHUTRO_ERP_WEBHOOK_HOSTS`) checked at creation and before each delivery.
- **Routes** for the events, creation with checks, ping, new secret and replay; the screens are generated list and
  form views with two components (test event and new secret with the events offered; send again), English and
  Bangla. Installed by default with `shutro-erp init`; in the npm bundle.
- **Tests**: events offered, URL and events checked, managers only; created / updated / deleted deliveries with the
  signature checked as a receiver would; a failing endpoint recorded and retried; replay with the same event id;
  ping; new secret; a webhook acting as a user who cannot read the model sends nothing; a declared module event.
  E2E: a webhook made on its form, the events offered, a test event in Deliveries; no Integrations without access.
- Automation's webhook action keeps its own log for now (RFC §5.3 planned one log for both).

## Implementation notes (2026-10-28): step 3 — inbound webhooks

- **Declaration**: `inboundWebhooks: [{ key, label, verify(call, secret), handle(env, call) }]` in the manifest
  (`@kosh/modules-sdk`: `InboundCall` = headers, query, raw body, parsed JSON). `verify` returns the provider's
  event id, or `null` to refuse; `hmacVerifier({ header, prefix?, algorithm?, encoding?, eventId })` covers providers
  that sign the raw body with an HMAC.
- **Switched on per company**, not per module path (a change from §5.4): `webhook.endpoint` (name, `<module>.<key>`,
  a random URL token, the secret, active). The URL is `POST /api/v1/hooks/<token>` — two companies, two URLs and two
  secrets for the same provider. The token is looked up across companies (superuser with `checkCompany: false`); the
  rest runs in the endpoint's company.
- **The route** has no sign-in (`auth: false`, so still rate limited per address) and its own raw body parser (1 MB);
  a refused call is stored (`refused`, 401), a repeated event id answers 200 `{ duplicate }` without a second
  handling, a new one is stored (`received`) and queued (202). Only `content-type`, `user-agent` and `x-…` headers are
  kept, never credentials or cookies.
- **Handling**: a job (6 attempts, Shutro's back-off) runs `handle` as the system in the endpoint's company (the
  manifest is the module's declaration of what it does — RFC §5.4's per-module service account was not needed);
  each attempt's outcome is written in its own transaction; the last failure marks the call `failed`. Replay (verified
  calls only) queues it again.
- **Routes**: the endpoints offered, creation (the declared endpoint checked; the answer has the path and the secret),
  new secret, replay. Screens: Inbound webhooks (with the URL to give the provider, a new secret, the endpoints
  offered) and Inbound calls (handle again), English and Bangla.
- **Tests**: endpoints offered, managers only, unknown endpoint refused, unknown token 404; a signed call handled into
  a record of the endpoint's company; a duplicate ignored; a forged call refused and logged (and not replayable); a
  failing handler recorded and retried, then replayed; a new secret refuses the old one. E2E: an endpoint made on its
  form with its URL, a signed call handled and a forged one refused in Inbound calls.

## Alignment with CLAUDE.md

"Secure by default": scopes narrow and never widen the user's rights; server-side checks on every call; hashed
secrets; audit. "Explicit over magic": inbound webhooks are declared by modules. "Kosh never reimplements ORM
features": the outbox, jobs, audit and record rules are Shutro's. "Metadata-driven": events come from the models'
transitions and the modules' declared events; OpenAPI describes the new security schemes.
