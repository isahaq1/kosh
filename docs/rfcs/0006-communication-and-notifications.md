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
