# RFC 0006: Communication & notification architecture

- **Status:** Accepted; parts 1–7 implemented (chatter, the realtime gateway, the inbox, email, web push, SMS and WhatsApp, internal chat, inbound email); the jobs decision taken on 2026-10-25. Part 8 (fallback channels, digests, quiet hours) designed below and accepted on 2026-10-27 with the proposed answers; implemented (steps 1–3).
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

## Design (2026-10-26): part 6 — internal chat; part 7 — inbound email

What §5.6 and §5.7 say in one line each, made precise enough to build. Both reuse what exists: `mail.message`
for the text, the outbox and `@kosh/notify` for who is told, the gateway for the live part, `@kosh/storage` for
attachments. Nothing is copied from Odoo's `discuss`: no bus of its own, no second message table, no per-channel
member table hidden behind a kanban.

### 6.1 Chat: the model

- **`mail.channel`** (`@kosh/messaging`, private model, company-scoped): `name`, `kind` (`channel` | `group` |
  `direct`), `description`, `members` (many2many `res.users` through `mail.channel.member`, see below), `public`
  (a channel every user of the company may read and join; false for groups and directs), `archived`
  (`archivable`), `lastMessageAt` (stored, for the sidebar's order). A **direct** channel is a two-member
  channel with no name (its name is the other member's); the same pair never gets a second one (a unique index on a
  sorted pair key, `pairKey`, set for directs only).
- **`mail.channel.member`**: `channel`, `user`, `lastReadMessage` (many2one `mail.message`, the read receipt),
  `muted` (no notifications), `pinned`, `joinedAt`. One row per member; the chatter's `mail.follower` stays what it
  is (record followers), these are chat members.
- **Messages** are `mail.message` rows with `resModel = 'mail.channel'`, `resId = channel`, kind `comment`, plus
  three fields added to the model: `parent` (many2one `mail.message`, the thread a reply belongs to; a top-level
  message has none; one level only, like Slack), `replyCount` (stored compute), `reactions` (one2many
  `mail.message.reaction`: `message`, `user`, `emoji`; unique per message, user and emoji). The record card of
  §5.5 is a message whose `text` holds a record token `#[Name](record:sale.order:12)`, rendered by the existing
  markdown subset as a link the reader may or may not open (`GET /api/v1/routes` decides, as the bell does).
- **Typing** is not stored: the gateway relays `{ type: 'typing', channel }` to the channel's subscribers for
  five seconds, as it does presence.

### 6.2 Chat: who may do what

- `messaging.user` may read and post in the channels they are a member of (a rule on `mail.channel.member`:
  `user = uid`; messages of a channel are reachable through the channel's routes only, which check membership
  first, like the chatter checks the record), create groups and directs, join and leave public channels.
- `messaging.manager` (new group, implies `messaging.user`) creates and archives public channels and manages
  their members; the Settings → Chat page lists channels and members for administrators.
- Authors edit and delete their own messages (the existing `own` rule); a manager deletes any message of a
  channel they manage (audited, the row keeps `deletedAt` and loses its text, so threads stay whole).
- Record rules are the fence here as everywhere: a direct message never reaches a user of another company; a
  user removed from a channel loses the history with the membership (no copy exists elsewhere).

### 6.3 Chat: API, realtime, notifications

- Routes under `/api/v1/chat`: `GET /channels` (mine, with unread counts from `lastReadMessage`), `POST /channels`
  (group or public), `POST /channels/direct/:user`, `GET /channels/:id/messages?before=&limit=` (and
  `?thread=<message>` for a thread), `POST /channels/:id/messages` (text, attachments, `parent`), `POST
  /channels/:id/read` (the receipt), `POST /channels/:id/join|leave`, `POST /messages/:id/reactions` and its
  `DELETE`, `PATCH /channels/:id` (name, description, members, by a manager or the group's creator).
- Gateway channel `chat:<id>`: subscribing needs membership (the gateway's `#mayRead` learns one more prefix and
  asks `mail.channel.member`); the server announces `message`, `reaction`, `read` and `typing` events on it after
  commit through the existing `NOTIFY kosh_changes` path (a change on `mail.message` with the channel in its
  payload). Clients refetch the tail through the API, as views do; the payload never carries the text.
- Notifications ride the existing pipeline: posting emits `chat.message.posted`; `@kosh/notify`'s subscriber
  creates a `mention` notification for mentioned members, and a new kind `chat.direct` for the other member of a
  direct channel (in-app, and web push when the recipient is away, i.e. no presence anywhere for two minutes;
  never email by default). Muted channels create nothing. Preferences per kind as today.
- Unread counts come from `lastReadMessage` and a message count per channel, computed in one query for the sidebar;
  no counter column to keep in step.

### 6.4 Chat: the UI (`@kosh/messaging/web`)

- A **Chat** app (`messaging.action_chat`, a client action; menu under its own app icon, and `Ctrl+Shift+K` in the
  palette) with the sidebar (pinned, channels, directs, unread badges), the message pane (day separators, grouped
  consecutive messages, reactions, thread side panel, composer with mentions, attachments, record tokens
  through the palette's record search), and the channel header (members, join, mute, pin).
- A **dock**: a small bubble per open direct conversation at the bottom right of any page, so a conversation
  continues while working on a record; the bell counts chat too.
- Works offline for reading (the persisted query cache) and queues sent messages like other writes (RFC 0010).
- Everything through i18n, keyboard reachable, light and dark; the live part through the gateway hook views use.

### 7.1 Inbound email: how a message comes in

- **Reply addresses.** Every outbound notification email of a record sets `Reply-To` to
  `<alias>+<token>@<MAIL_INBOUND_DOMAIN>`: `alias` is the installation's inbound mailbox, `token` a signed value
  (`HMAC-SHA256` of `model:id:recipient user` with the installation's `MAIL_INBOUND_SECRET`, base32, 20
  characters, plus the model and id in clear so a human can read it). The token proves the mail was sent by us
  to that person about that record; no guessable `record-12@` aliases.
- **Catch-all aliases** (optional, per company): `sales@…` creates a lead-like record when an app declares an
  `inboundAlias` in its manifest (`{ alias: 'support', model: 'project.task', defaults, assignTo }`); version 1
  ships the mechanism and one user in Projects (a task in the support project). Unknown aliases are refused with
  a bounce only when the sender is a known partner; otherwise dropped and logged (no backscatter).
- **Two sources, one parser.** `@kosh/mail` gains `inbound/`: a parser (`postal-mime`, pure JS; the one new
  dependency) that turns a raw RFC 5322 message into `{ from, to, subject, text, html, attachments,
  messageId, inReplyTo, references }`, and two entry points: `POST /api/v1/mail/inbound` for a provider webhook
  (Postmark, Mailgun, SES/SNS, Mailpit's webhook in development: the raw message, authenticated by a shared
  secret header per provider adapter), and an **IMAP poller** (`imapflow`, the second dependency, only loaded
  when `IMAP_URL` is set) that runs as a worker like the outbox subscribers (`pollMs` 30 s, one node at a time by
  a `pg_advisory_lock`), fetches unseen messages, hands them to the same handler and marks them seen on success.
- **The handler** (`mail.inbound` job, exactly once per `messageId`: a unique index on `mail.inbound_message`):
  resolves the target from the token, else from `In-Reply-To` / `References` against our own sent `Message-ID`s
  (`notify.delivery.messageId`, new column), else from a catch-all alias; checks the sender against the
  recipient the token names (the user's email, or a partner's address of the record: a vendor replies about the
  bill from `accounts@vendor`), and **posts to the record's chatter as that user** when the sender is a user, or
  as the system with the partner named as the author (`mail.message.authorEmail`, new field) when the sender is
  a partner; mails whose sender matches neither are kept in `mail.inbound_message` as `quarantined` for an
  administrator to attach by hand or discard (Settings → Email → Inbound).
- **Bodies.** HTML from outside is sanitized (`sanitize-html`, allow-list: paragraphs, emphasis, lists, links
  with `rel="noopener nofollow"`, images only as attachments), quoted history is cut at the usual markers
  (`On … wrote:`, `-----Original Message-----`, our own separator) and kept folded, attachments go to
  `@kosh/storage` under the record and the message, inline images referenced by `cid:` become attachment links.
- **Bounces and auto-replies** (`Auto-Submitted`, `X-Autoreply`, `Return-Path: <>`) never post; a bounce of our
  own message marks the delivery `bounced` (§5.4) and tells the sender of the original message through the bell.

### 7.2 Inbound email: permissions and tests

- Posting as the sender user goes through the same route logic as a typed comment: the user's record rules
  decide; a user who may not read the record any more gets the mail quarantined, not posted (the token is not a
  capability, only an address).
- A partner's reply is posted by the system (audited, `reason: inbound email`) only on records where that partner is
  the record's partner or a follower address; everything else is quarantined.
- Tests: the parser on a fixture set (plain, HTML with quotes, attachments, inline images, auto-replies, a
  bounce), the handler on real PostgreSQL (token reply as a user, a vendor's reply on a bill, a mail without a
  valid target quarantined, the same message delivered twice posted once), the webhook with a bad secret
  refused, and an IMAP round trip against a GreenMail container; E2E: a reply shows in the chatter live.

### 7.3 Delivery plan (each step reviewed)

1. Chat model, routes, gateway channel, notifications, tests on PostgreSQL (`@kosh/messaging`).
2. Chat UI: the app, the dock, offline, E2E (`@kosh/messaging/web`).
3. Inbound parser, reply tokens on outbound mail, the webhook and the handler, quarantine page, tests.
4. IMAP poller, catch-all aliases with the Projects user, bounce handling, E2E.

### 7.4 Open questions (answers wanted with the approval)

- **Retention** (§7): propose per-company settings, default to keep everything; erasure of a user's messages on
  request replaces text by "message removed" and keeps the row (threads and audit stay consistent).
- **Email providers for the webhook**: Postmark and Mailgun adapters first (clear raw-message webhooks), SES
  when asked. Development uses Mailpit's webhook. Yes?
- **Chat retention of attachments** counts against the company's storage like record attachments. Yes?
- **Dock on mobile widths**: a full-screen conversation instead of bubbles. Yes?

## Design (2026-10-27): part 8 — fallback channels, digests, quiet hours

§5.4 promises them; today every channel a user enables gets every notification at once, and a failed or bounced
delivery just stays failed. Odoo has no quiet hours, no fallback between channels, and its digest is a separate
"digest email" app of KPIs, not a summary of what happened to you.

### 8.1 The user's notification settings

One private model `notify.settings` per user (created on first save; absent means the defaults), edited on the
existing Notifications page next to the per-kind channel switches:

| Field | Default | Meaning |
| --- | --- | --- |
| `quietFrom`, `quietTo` | none | quiet hours, `HH:MM` in the user's time zone (`res.users.tz`); may cross midnight (22:00–07:00) |
| `quietDays` | none | whole days off (`sat`, `sun`, …) |
| `digestHour` | 08:00 | when the daily digest goes out, in the user's time zone |
| `fallback` | `email` | the channel that takes over when another one cannot deliver; `none` to switch it off |

The per-kind, per-channel switch (`notify.preference.enabled`) becomes a **mode** for email: `instant` (today's
behaviour), `daily` (in the digest) or `off`. Other channels stay on / off. Existing rows map `true` → `instant`,
`false` → `off` (a data migration of `notify`).

### 8.2 Quiet hours

During a user's quiet hours, the **interrupting channels** (web push, SMS, WhatsApp) are held: the delivery is
created in a new state `held` with `notBefore` set to the end of the quiet period, and its job is enqueued with
Shutro's `runAt` at that instant. When the job runs, it delivers if the notification is still unread (read in the
inbox meanwhile: `skipped`, reason `read`). The inbox and email are never held: they do not interrupt. No kind
bypasses quiet hours in version 1; an "urgent" flag per kind can come later if users ask for it.

### 8.3 Digests

An email delivery whose mode is `daily` is created in state `digest` (no job). One job per user and day,
`notify.digest:<user>:<date>` (deduplicated by key, `runAt` = the next `digestHour`), sends **one** email listing
the user's `digest` deliveries since the last digest, grouped by record, each line linking to it, translated in the
user's language, skipping notifications already read in the inbox. Every included delivery becomes `sent` with the
digest's provider id; an empty digest sends nothing. The digest email uses the same transport as instant email, so
bounces mark every included delivery `bounced`.

### 8.4 Fallback channels

When a delivery on a channel other than the inbox ends **without reaching the user** — `failed` after its last
attempt, `bounced`, or `skipped` because the channel has no destination (no phone number, no push subscription
left) — and no other channel of the same notification was `sent`, a delivery on the user's `fallback` channel is
created (`fallbackOf` = the failed delivery) and runs like any other (quiet hours and the mode apply; a `daily`
email fallback goes in the digest). One level only: a fallback never falls back again, and a channel is never its
own fallback, so there is no loop. SMS and WhatsApp as fallbacks still need the user's opt-in and a phone number.

### 8.5 Permissions and tests

Settings are the user's own (record rules as for preferences); the inbox re-check of the recipient's access
(§5.3) runs again when a held or digest delivery is finally sent, so a user who lost access meanwhile gets nothing.
Tests on PostgreSQL: quiet hours across midnight in a non-UTC time zone hold a push and release it at the end
(read meanwhile → skipped); a daily email goes in one digest with two notifications, a read one left out, an empty
digest sends nothing; a bounced email falls back to web push once, a failed push falls back to email, a fallback
never chains; access lost before the digest drops the line. E2E: the settings on the Notifications page (English
and Bangla).

### 8.6 Delivery plan (each step reviewed)

1. `notify.settings`, modes, the data migration, quiet hours (held deliveries); the settings API.
2. Digests (the daily job and email), fallback channels.
3. The Notifications page: quiet hours, digest hour, fallback, the email mode per kind; E2E.

### 8.7 Open questions (answers wanted with the approval)

- **Interrupting channels**: web push, SMS and WhatsApp held in quiet hours, email not (proposed); or email too?
- **Default fallback**: email (proposed), or none until the user picks one?
- **Digest period**: daily only (proposed), or also weekly?

## Implementation notes (2026-10-27, part 8 step 3: the settings dialog)

- §8.1 assumed a Notifications page; there was none (the per-kind switches only had an API). The settings are a
  dialog opened from the bell ("Notification settings", `NotificationSettings` in `@kosh/notify/web`): quiet hours
  (time inputs, "every day" to switch them off), days off, the digest hour and the fallback channel saved with
  Save; and a table of kinds by channel — the bell, push, SMS and WhatsApp as switches, email as at once / daily
  summary / off — each saved at once. The time zone is named; the table scrolls sideways on a phone. English and
  Bangla; kinds have short names (`kindNames`) next to the sentences the bell shows.
- E2E (`apps/web/e2e/notification-settings.spec.ts`): Maria sets quiet hours to 06:30, Friday off, the summary
  at 09:15, push as fallback, mentions by email daily and without push; the API returns all of it and the dialog
  shows it after a reload; the dialog has no serious axe violation in light or dark theme, and reads in Bangla.

## Implementation notes (2026-10-27, part 8 step 2: digests and fallback channels)

- **Digest**: a `daily` email delivery enqueues `notify.digest` `{ user }` with Shutro's `runAt` at the user's next
  digest hour and the key `notify.digest:<user>:<local date>`, so a day has one job however many notifications
  arrive (the key deduplicates while it is pending). The job (`sendDigest`) takes the user's `digest` deliveries,
  leaves out the read ones and the records the user may no longer read (`skipped`), and sends one email: the
  layout of `@kosh/mail` gained `sections` (a linked heading and its lines, per record); the subject and
  introduction are translated (English, Bangla). Every included delivery becomes `sent` with the same provider id.
- **Fallback** (`queueFallback`, `notify.delivery.fallbackOf`): after a delivery is `skipped` for want of a
  destination (not `read` / `no access`), after its last failed attempt (`MAX_ATTEMPTS`, Shutro's default: the last
  attempt no longer throws, it falls back and ends the job), or when it bounced, and when no other channel of the
  notification was sent, a delivery on the user's fallback channel is created and runs like any other (the email
  mode, quiet hours, the channel's opt-in and destination apply). Never a second level, never the same channel, never
  a channel the notification already used. Bounces are recorded by the mail package, which cannot import notify: it
  emits `notify.delivery.bounced`, and notify's `notify.fallback` subscriber falls back.
- Found on the way: Shutro's transactions are repeatable read, so a job must not write a row its attempt counter
  already changed outside the transaction (a serialization failure): the last attempt tells the fallback the
  delivery failed instead of rewriting it. The helpers moved out of the inbox (`prefs.ts`, `jobs.ts`) to keep the
  modules free of import cycles.
- Tests: the next digest hour (also across a daylight-saving change) and its local date; on PostgreSQL, three daily
  mentions on two books make one digest job at 08:00 Dhaka, one email of two (the read one left out, grouped by
  book, one provider id), and a second run sends nothing; a push to a gone device falls back to email, which is
  sent; a bounced email falls back to push through the event, and that push does not fall back again; four failed
  attempts retry and the fifth falls back.

## Implementation notes (2026-10-27, part 8 step 1: settings, email modes, quiet hours)

- Answers: web push, SMS and WhatsApp are held in quiet hours, email is not; the default fallback is email;
  digests are daily only.
- `notify.settings` (one per user, private, own rows only) and `GET` / `PUT /api/v1/notifications/settings`
  (validated: `HH:MM` times, both quiet bounds or neither, the day names, a fallback among email, web push, SMS,
  WhatsApp or none). `notify.preference.mode` holds the email mode; **no data migration**: an unset mode means
  `enabled` (`instant` or `off`), so existing rows keep working, and switching email on or off resets the mode.
  The preferences API returns `emailMode` per kind and takes `mode` for email.
- Quiet hours are pure functions on instants (`quiet.ts`, `Intl` for the time zone and its daylight saving):
  hours that may cross midnight, days off, and the end of a period stepping through adjacent ones (a day off into
  the next quiet morning); when every day is off, nothing is held. A delivery on an interrupting channel in quiet
  hours is `held` with `notBefore`, its job enqueued with Shutro's `runAt`; when it runs, a notification read
  meanwhile is `skipped` (`read`), and the recipient's access to the record is checked again (`skipped`,
  `no access`). An email whose mode is `daily` is a `digest` delivery without a job (step 2 sends the digest).
- `notify` is version 0.2.0 (the settings table, two columns, two delivery states).
- Tests: quiet hours (Dhaka across midnight, the last seconds of a period, days off chained with the night, every
  day off); the settings API (defaults, every validation, own rows only), the email modes; on PostgreSQL, three
  mentions in Dina's quiet hours held about an hour, not run early, then read meanwhile / sent / access lost; a
  daily email waiting for the digest.

## Implementation notes (2026-10-26, part 6 step 1: the chat model, routes, gateway, notifications)

- `@kosh/messaging`: `mail.channel` (channel / group / direct; `pairKey` keeps one direct conversation per pair),
  `mail.channel.member` (read receipt, mute, pin), `mail.message.reaction`, and `parent` / `replyCount` /
  `deletedAt` on `mail.message`. Record rules are the fence: a channel is visible to its members (and to
  everyone when public), writable by its creator or a `messaging.manager` (the new group: it runs public channels,
  it does not read private groups). `docs/messaging.md` lists the routes.
- Live: no new gateway prefix was needed. A chat conversation is the record channel `record:mail.channel:<id>`,
  whose subscription check (ACL and rules) is the membership check; posts, reactions, edits and removals announce
  the channel's change, and a new client message `typing` is relayed to the channel's subscribers on the node
  (across nodes with step 2).
- Notifications: `chat.message.posted` joins the inbox subscriber's topics; mentioned members get a `mention`,
  the other side of a direct conversation the new kind `chat.direct` (in-app and web push; email off unless the
  user switches it on: `OFF_BY_DEFAULT`). Muted members are left out of the event by the poster.
- Found on the way: Shutro's event tables are created on first use inside the emitting transaction, and a rollback
  of that first transaction leaves later emits without a table (`docs/shutro-requests.md` #25); tests create them
  up front.
- Tests: `packages/messaging/test/chat.integration.test.ts` (groups, public channels, directs, receipts and unread
  counts, threads, reactions, pagination, editing and removal), the inbox test's chat case, the gateway's typing
  test.

## Implementation notes (2026-10-26, part 6 step 2: the Chat app and the dock)

- `@kosh/messaging/web`: the page `messaging.Chat` (sidebar, conversation, thread panel, composer reusing the
  chatter's mention area and files) and the header item `messaging.Dock` (unread count, recent conversations,
  small panels at the bottom corner of any page; full screen on a phone, as decided). `messaging` became an app
  (`chat`, category Communication) with the client action and its menu, so the palette and the launcher reach it;
  `Ctrl+Shift+K` opens the dock (`data-kosh-chat`).
- Attachments: the manifest's new `attachable` lists private models whose records take attachments through the
  attachment routes under their own rules (`mail.channel`); the chat composer uploads to the channel.
- Live: the browser's realtime client gained `onTyping` / `sendTyping` (the gateway's `typing` message); a
  conversation subscribes to its record channel and refetches on others' changes; the channel list to
  `model:mail.channel`. The read receipt follows the newest message shown. The `chat` query keys are kept by the
  offline persister, so conversations read offline.
- Not in this step: sending offline (the queue is for model writes), typing across nodes.
- Tests: `apps/web/e2e/chat.spec.ts` (a group made from the app, live for its member, a reaction and a thread
  seen by both; a direct message in the dock and the bell; no dock without Messaging; accessibility).

## Implementation notes (2026-10-26, part 7 step 3: replies by email, the webhook, the quarantine)

- `@kosh/mail` is a Kosh module now (`mail`, every installation has it; the Email app shows for `mail.manager`):
  `inbound/token.ts` (the signed reply addresses; `@kosh/notify` sets `Reply-To` on every record email when
  `MAIL_INBOUND_SECRET` and `MAIL_INBOUND_DOMAIN` are set), `inbound/parse.ts` (`postal-mime` for raw messages,
  Postmark's JSON, `sanitize-html` for HTML from outside, quote cutting, auto-reply and bounce detection),
  `inbound/handle.ts` (the log row once per Message-ID, the target from the token or `In-Reply-To` against the
  Message-IDs we sent — the SMTP mailer's `providerId` —, posting as the recipient under their rules or as the
  system naming a known sender, quarantine otherwise), `inbound/routes.ts` (the public webhook with its shared
  secret; the log's routes) and `web/InboundPage.tsx`.
- `mail.message` gained `authorEmail` / `authorName` for messages from outside, and the chatter has
  `postExternalMessage` (a superuser scope the caller opens, audited). The chatter and the chat show such a sender
  as "Name <address>".
- The two dependencies: `postal-mime` (pure JS MIME parsing) and `sanitize-html` (the allow-list).
- Step 4 (2026-10-26): `inbound/poller.ts` reads a mailbox (`imapflow`, `IMAP_URL`) every `MAIL_INBOUND_POLL_MS`,
  one node at a time by `pg_try_advisory_xact_lock`, unseen messages received and marked seen (left unseen on a
  failure, logged); the manifest's `inboundAliases` (Projects: `support@` makes a task in the support project, or
  the first project, else the message is quarantined `alias-unavailable`); a bounce marks its delivery `bounced`
  (a new delivery state) and writes an `email.bounced` notification for the notification's actor; Mailgun's form
  posts (`body-mime`, urlencoded or multipart). Tests: the poller against GreenMail (SMTP in, IMAP out, the
  lock), an alias making a deal, the two Mailgun shapes, and the bounce in the notify tests.
- Tests: `packages/mail/test/parse.test.ts` (addresses, a raw message with an attachment, quotes, HTML, automatic
  messages, Postmark), `packages/mail/test/inbound.integration.test.ts` (the webhook's secret; a reply posted as
  the user with the file; delivered twice posted once; a partner's reply as the system; quarantine, attach by
  hand, discard; an auto-reply dropped; Postmark's JSON) and the notify tests (the reply address on the email; a
  reply resolved by `In-Reply-To`).

## Implementation notes (2026-10-26, part 4b: the SMS and WhatsApp channels)

- `@kosh/notify`: the `Messenger` adapter (`messenger.ts`): `createTwilioMessenger` (Twilio's Messages API over
  `fetch`, basic authentication, a form body, the `whatsapp:` prefixes; no SDK), `messengerFromEnv`
  (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`, `TWILIO_WHATSAPP_FROM`), a memory messenger for
  tests. `res.users.phone` (E.164, normalized) is the recipient. The inbox subscriber queues one delivery per
  channel the provider serves (`queueMessages`), the delivery job sends the sentence and the record's link, and
  a provider failure is recorded and retried like email.
- **Opt-in**: `sms` and `whatsapp` are off for every kind until the user switches them on (`defaultEnabled`,
  which the preferences API reports), as the design's cost rule asks. A Twilio account is needed to run it; the
  tests use the memory messenger and a local HTTP server for the adapter.
- Not yet: fallback channels when one fails or bounces, digests, quiet hours (§5.4).

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

