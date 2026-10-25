# RFC 0006: Communication & notification architecture

- **Status:** Accepted; part 1 (chatter, attachments) implemented. The jobs backend decision (below) is still open.
- **Depends on:** 0001, 0002, 0003; Shutro RFC 0013 (audit), 0018 (outbox events, jobs)

## 1. Summary

Every record can have a **chatter** (notes, messages, @mentions, attachments, followers, scheduled activities and a
change log read from Shutro's audit trail). Delivery is one pipeline: **Shutro outbox event → notification rules and
user preferences → jobs → channel adapters** (email, SMS, WhatsApp, web push, in-app), with retries, fallbacks,
digests and delivery tracking. Realtime updates go through a WebSocket gateway fed by LISTEN/NOTIFY and fanned out
across nodes with Valkey pub/sub. Internal chat and inbound email reuse the same message model.

## 2. Problem

Approvals, mentions and exceptions must reach the right people on the right channel, exactly when their transaction
committed, without duplicates, with a trace of delivery, and without leaking records people cannot read.

## 3. How Odoo does it, and its weaknesses

`mail.thread` mixin (messages, followers, tracking values), `mail.activity`, `mail.mail` queue sent by cron,
`bus.bus` long-polling for realtime, SMS/WhatsApp in separate modules.

- **Sending tied to cron and transactions loosely:** mails queued in the transaction but sent by a cron; failures
  are retried crudely; no unified delivery tracking across channels.
- **Tracking stored as messages** (editable, partial: only tracked fields).
- **Bus** is a table polled by long-polling; scaling requires workarounds.
- **Preferences** are coarse (email vs inbox), not per event and channel.
- **Followers can receive content of records they can no longer read.**

## 4. Options

| | A. Outbox → jobs → adapters (PostgreSQL only) + Valkey for fan-out | B. External broker (RabbitMQ/Kafka) | C. Direct send in request |
| --- | --- | --- | --- |
| Exactly-once with the business transaction | Yes (Shutro outbox) | Needs an outbox anyway | No |
| Ops | PostgreSQL + Valkey (already used for cache/rate limits) | Extra cluster | None |
| Throughput | Tens of thousands of messages/min with SKIP LOCKED workers | Higher | Request-bound |

## 5. Recommendation: A

1. **Chatter** (`@kosh/mail`): `mail.message` (record ref, author, body HTML sanitized, type note/comment/system,
   mentions, attachments in MinIO/S3), `mail.follower`, `mail.activity` (type, deadline, assignee, done). The change log
   is not copied: it is read from Shutro's audit trail (`records.trail()`), so it cannot be edited. Access to a
   record's chatter follows the record's rules (RFC 0003); attachments are downloaded through rule checks.
2. **Events**: business code emits Shutro outbox events (`approval.requested`, `mail.mentioned`,
   `activity.due`); notification types are declared in manifests (RFC 0001) with templates per channel and locale.
3. **Routing**: a subscriber resolves recipients (followers, mentioned users, role members), **re-checks each
   recipient's access to the record** (as that user), applies per-user, per-event channel preferences and quiet
   hours, then enqueues one delivery job per recipient and channel (dedup key: event + recipient + channel).
4. **Adapters** (`email` via SMTP/Mailpit in dev, `sms`, `whatsapp`, `webpush`, `inapp`): pluggable providers; a
   delivery row records attempts, provider ids, status callbacks (delivered, read, bounced); fallback channels when a
   channel fails or is disabled; digests group low-priority notifications per user per period.
5. **Realtime**: a WebSocket gateway subscribes users to channels they may read (records, chat channels, their inbox);
   database notifications (LISTEN/NOTIFY on commit) are fanned out across nodes through Valkey pub/sub. Clients refresh
   views and chatter without polling.
6. **Chat**: channels, DMs, threads, reactions, read receipts on the same message model (`model = 'mail.channel'`).
7. **Inbound email**: a mailbox poller / webhook parses messages, resolves the target record from reply-to tokens
   (signed `record@reply` aliases), checks the sender, and posts to the record's chatter.

## 6. Purchase with approvals

Submitting a 750 000 BDT order emits `approval.requested` twice (two levels). The department head gets in-app +
web push (their preference); the finance director gets email (WhatsApp fallback if email bounces). Each delivery is
tracked; if Rahim is removed from the approver role before the job runs, the access re-check drops his notification.
Replying to the approval email posts the reply on the order's chatter.

## 7. Open questions

- Retention of delivered notifications and chat (per company policy, GDPR erasure).

## Alignment with CLAUDE.md

- **Jobs (decision needed).** CLAUDE.md names pg-boss for jobs. Shutro now ships PostgreSQL jobs (`env.enqueue`,
  `shutro.work`, RFC 0018 there) whose completion commits **in the job's own transaction**, so a job's database work
  happens exactly once, and which run as the enqueuing user under their record rules; pg-boss runs jobs outside the
  ORM's transactions. Since CLAUDE.md also says Kosh never reimplements ORM features, this RFC proposes `packages/jobs`
  on Shutro's jobs (scheduler and cron on top) instead of pg-boss. This changes the stated stack, so it needs your
  explicit approval; if declined, `packages/jobs` wraps pg-boss and the outbox still comes from Shutro.
- Packages: chatter, followers, activities and chat in `packages/messaging`; email (outbound, inbound, templates with
  React Email) in `packages/mail`; channels and adapters (in-app, web push, mobile push, email, SMS, WhatsApp,
  Telegram) in `packages/notify`; the gateway in `packages/realtime`; attachments in `packages/storage`.

## Implementation notes (2026-10-19, part 1: chatter)

- `@kosh/messaging` and `@kosh/storage` as described in §5.1; guide in `docs/messaging.md`. The chatter's models are
  private (no generated API); its routes read the record as the caller first, so the chatter needs no superuser
  scope to read: ordinary rules on the private models (authors edit their messages, creators and assignees their
  activities) plus the record check.
- Bodies are rendered on the server from text with a small markdown subset and mention tokens; everything typed is
  escaped, so no HTML sanitizer is needed yet. Inbound email (part 5) brings HTML from outside and will need one.
- The change log is `records.trail()` as the user. Shutro gained what that needed: field security on trails, a
  `before` cursor, `limit` counting visible rows, and `env.access.checkRecords` for "may write" checks
  (`docs/shutro-requests.md` #15, #16).
- Attachments: S3-compatible storage signed with SigV4 on `node:crypto` (four calls: put, get, delete, create
  bucket; tested against the AWS documentation's example and a SeaweedFS container), or a directory. Downloads never
  render active content in the application's origin.
- Outbox events `mail.message.posted` and `mail.activity.assigned` are emitted for part 3.

## Implementation notes (2026-10-25, part 2: the realtime gateway; part 3: in-app notifications)

- **Gateway** (`@kosh/realtime`, §5.5): see RFC 0010's notes. PostgreSQL `NOTIFY` reaches every node of a database,
  so Valkey pub/sub was not needed for the fan-out.
- **Notifications, in-app channel** (`@kosh/notify`, §5.2–5.4):
  - Subscribers on Shutro's outbox (`shutro.subscribe`, one per topic: `mail.message.posted` for mentions,
    `approval.requested`, `approval.decided`, `mail.activity.assigned`) turn each event into
    `notify.notification` rows in the handler's transaction (exactly once), as the RFC's routing step describes:
    recipients are resolved (mentioned users; holders of the approver roles in the record's company; the requester;
    the assignee), **each recipient's access to the record is re-checked as that user** (ACL and record rules, in a
    read-only unit of work of their own), and their `notify.preference` for the kind is applied.
  - A notification stores a `kind` and `params` (names, a preview, a state), never a rendered text: the client
    translates it in the reader's language. Both models are private and rule-scoped to their owner.
  - `/api/v1/notifications` (list, count, read one, read all, preferences). The bell (`@kosh/notify/web`) is a
    header item of the shell, live through the gateway (`model:notify.notification`), and opens a record where the
    user may open it (`GET /api/v1/routes`).
  - Found on the way: Kosh's identity loader returned the user's raw role assignments, while Shutro replays an
    event's stored group closure to its subscriber and checks it against the loader; the loader now returns the
    closure (`AuthService.verify`).
- **Jobs decision (Alignment section): taken on 2026-10-25.** Kosh's jobs are Shutro's transactional jobs and
  outbox subscribers, as this RFC proposed; pg-boss is not introduced (CLAUDE.md updated). A scheduler on top of
  them comes with the scheduled reports' move off their own engine.
- **Not yet:** SMS and WhatsApp adapters, digests, quiet hours, inbound email, chat (web push: part 5).

## Implementation notes (2026-10-25, part 4: the email channel)

- `@kosh/mail`: the `Mailer` interface, the SMTP mailer (nodemailer, the package's one dependency: STARTTLS,
  authentication, the usual SMTP edge cases) configured by `SMTP_URL` and `MAIL_FROM`, a memory mailer for tests,
  and a plain HTML/text layout (inline styles, a `dir` for right-to-left languages, no images or scripts).
- `@kosh/notify`: when notifications are written, the recipients whose preference allows email and who have an
  address get a `notify.delivery` row and a `notify.deliver` job, in the same transaction (the job exists iff the
  rows do). The job (`shutro.work`) renders the email in the recipient's language from the shared sentence
  catalogue, with a link `${KOSH_BASE_URL}/open/<model>/<id>` that the back-office resolves to where the user may
  open the record, sends it, and marks the delivery sent in its own transaction. A provider failure records the
  attempt and the error outside the rolled-back transaction and lets Shutro retry with backoff (`failed` stays
  visible on the delivery).
- Without `SMTP_URL`, no email deliveries are created (the inbox still is). In development, Mailpit from
  `pnpm dev:services` (`smtp://localhost:1025`, inbox on http://localhost:8025).
- Tests: `packages/notify/test/email.integration.test.ts` sends through a Mailpit container and reads its API.

## Implementation notes (2026-10-25, part 5: the web push channel)

- Standard Web Push with VAPID (`web-push`, the one new dependency), no third-party push service: the browser's
  push service (Mozilla's, Google's, Apple's) gets an encrypted payload the server signs with the installation's
  keys. `kosh init` generates `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` into `.env`; without
  them push is off (`GET /api/v1/notifications/push/key` answers 404 and the bell shows no switch).
- A device opts in from the bell ("Turn on"): the app registers the service worker (`/sw.js`, built by the
  Vite plugin `@kosh/ui/vite`, one copy for every Kosh app), asks the browser's permission, subscribes with the public key and saves the subscription
  (`notify.push_subscription`: endpoint and the keys the browser made, owned by the user, rule-scoped) through
  `POST /api/v1/notifications/push`; "Turn off" deletes it on both sides. The service worker shows the message
  (title, body, record link) and a click focuses an open Kosh tab, or opens one, on `/open/<model>/<id>`.
- Delivery reuses the email pipeline: the `webpush` channel gets a `notify.delivery` and a `notify.deliver` job per
  notification (same transaction; recipients without a subscription get none), and the job sends to every
  subscription of the recipient. A subscription the push service reports gone (404, 410) is deleted; a delivery is
  `sent` when one push service accepted, `skipped` when none is left, `failed` with a retry on other answers.
- `notifyModule({ mailer, pusher, baseUrl, workers })` builds the module with explicit providers (tests, an
  installation wiring its own); `notify` is the environment-configured one.
- Tests: `packages/notify/test/push.integration.test.ts` (a memory pusher; subscriptions, ownership, a mention
  pushed to each device, a gone endpoint deleted).

