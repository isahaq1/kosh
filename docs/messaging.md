# Chatter and attachments

Every record of a served model can have a **chatter**: messages to its followers, internal notes, @mentions, files,
followers, planned activities, and the change log read from Shutro's audit trail (RFC 0006 §5.1). It is exactly as
visible as the record: every route reads the record as the caller first, so record rules and field security decide.

```ts
import { messaging } from '@kosh/messaging';

export const purchase = defineModule({
  // ...
  depends: [contacts, messaging],
  views: {
    'purchase.order.form': form(PurchaseOrder, (f) => ({
      sheet: [/* ... */],
      chatter: true, // the form shows the chatter below the sheet
    })),
  },
});
```

```tsx
import { messagingMessages, registerMessagingWeb } from '@kosh/messaging/web';

registerMessagingWeb(registry); // the `chatter` component
<KoshApp api={api} registry={registry} messages={{ messaging: messagingMessages }} />;
```

Users need the **Messaging** access level (`messaging.user`, which implies **Attachments**, `storage.user`).
Activity types are data: install the defaults with `installActivityTypes(env)` (To-do, Call, Meeting, Email,
Upload document); administrators add or archive types.

## What users get

- **Send message** (`comment`, for the followers; notifications arrive with RFC 0006 part 3) and **Log note**
  (`note`, internal). Text with a small markdown subset (paragraphs, `- ` lists, `**bold**`, `_italic_`, `` `code` ``,
  links) and **@mentions** picked from a suggestion list (keyboard: arrows, Enter / Tab, Escape). The server renders
  the HTML: everything typed is escaped and only Kosh's markup is emitted, so a stored body is safe by construction;
  mentions show the user's current name, never the typed label. Authors edit or delete their own messages.
- **Files**: attached in the composer (uploaded at once, removable before sending), downloaded from the message;
  images show a preview. Deleting a message deletes its files.
- **Followers**: the author of a message follows the record; anyone who can read it follows or unfollows
  themselves; users who may write the record add or remove other followers.
- **Activities**: a type, a summary, a due date (the type's default days ahead), an assignee, a note. Overdue and
  today's are marked. Their creator or assignee completes one (with feedback, logged in the timeline as
  "Call done: …") or cancels it. `GET /api/v1/activities/mine` lists the caller's open activities on records they
  can still read.
- **Change log**: the record's creation and every change of a tracked field (state fields by default, plus the
  model's `tracking` list), grouped per transaction, with selection labels and display names. It is the audit trail
  read as the user (`records.trail()`), so it cannot be edited, and fields the user may not read are left out.
- The timeline merges messages and changes, newest first, grouped by day, and pages through long histories.

## Routes

| Route | |
|---|---|
| `GET /api/v1/chatter/:model/:id?beforeMessage=&beforeChange=&limit=` | a page of the timeline (`next` is the cursor of the older page), followers, open activities |
| `POST /api/v1/chatter/:model/:id/messages { kind, text, attachments? }` | `kind`: `comment` or `note`; `attachments`: the caller's uploads on this record |
| `PATCH` / `DELETE /api/v1/chatter/messages/:id` | the author's own messages |
| `POST /api/v1/chatter/:model/:id/followers { follow, user? }` | the caller, or (write access) another user |
| `POST /api/v1/chatter/:model/:id/activities { type, deadline, assignee?, summary?, note? }` | |
| `PATCH /api/v1/activities/:id`, `POST /api/v1/activities/:id/done { feedback? }`, `DELETE /api/v1/activities/:id` | its creator or assignee |
| `GET /api/v1/activities/types`, `GET /api/v1/activities/mine` | |
| `POST /api/v1/attachments/:model/:id` | the raw file as the body (`Content-Type`, `X-Filename` URI-encoded), up to `KOSH_ATTACHMENT_MAX_BYTES` (25 MB) |
| `GET /api/v1/attachments/:model/:id`, `GET /api/v1/attachments/:id/download[?inline=true]`, `DELETE /api/v1/attachments/:id` | the uploader deletes |

A record outside the caller's rules is a 403 and an unknown one a 404, as in the REST API. The chatter's models
(`mail.message`, `mail.follower`, `mail.activity`, `mail.activity.type`, `storage.attachment`) are private: the
generated API, reports and exports never serve them.

Downloads are always `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff` and a sandboxing CSP;
only PNG, JPEG, GIF, WebP and PDF are shown inline when asked (`?inline=true`), so an uploaded HTML or SVG file never
runs in the application's origin.

## Chat (RFC 0006 part 6)

Public channels of the company, private groups and direct conversations on the same message model
(`resModel = 'mail.channel'`), with one-level threads, reactions and read receipts. Membership is the fence: a
channel the caller is not in is a 404 (a public one is readable and joinable by every user of the company),
posting needs membership, and a member removed from a group loses its history. `messaging.manager` creates and
runs public channels; a group's creator runs the group; authors edit and delete their own messages, and a manager
or the creator removes anyone's (the text goes, the row keeps the thread whole). Live updates come through the
gateway's `record:mail.channel:<id>` channel (changes announced after commit, typing relayed to the channel's
subscribers); the notification pipeline tells mentioned members (`mention`) and the other side of a direct
conversation (`chat.direct`: in-app and web push, never email unless switched on).

| Route | |
|---|---|
| `GET /api/v1/chat/channels` | mine and the public ones, with unread counts |
| `POST /api/v1/chat/channels { kind: 'group' \| 'channel', name, description?, public?, members? }` | public channels: managers |
| `POST /api/v1/chat/channels/direct/:user` | the direct conversation with a user of the company, made on first use |
| `GET` / `PATCH /api/v1/chat/channels/:id { name?, description?, add?, remove?, muted?, pinned? }` | the creator or a manager changes it; any member mutes or pins |
| `POST /api/v1/chat/channels/:id/join`, `…/leave` | public channels are joined; groups are added to |
| `GET /api/v1/chat/channels/:id/messages?before=&limit=&thread=` | newest first (a thread oldest first) |
| `POST /api/v1/chat/channels/:id/messages { text, parent? }` | members; `parent` replies in a thread |
| `POST /api/v1/chat/channels/:id/read { message? }` | the read receipt |
| `PATCH` / `DELETE /api/v1/chat/messages/:id` | the author (deletion: the creator or a manager too) |
| `POST /api/v1/chat/messages/:id/reactions { emoji }`, `DELETE …/reactions/:emoji` | |

Posting emits `chat.message.posted` (`{ model: 'mail.channel', id, message, author, mentions, direct, preview }`):
`mentions` are the mentioned members (never a non-member), `direct` the other, unmuted side of a direct
conversation. Files are attached to the channel (`POST /api/v1/attachments/mail.channel/:id`: the channel is a
private model that the manifest marks `attachable`, so the attachment routes serve it under its rules) and
listed on the message. The Chat app and its dock are described in `docs/ui.md`.

## Replies by email (RFC 0006 part 7)

Every notification email about a record carries a **reply address**, `reply+<model>-<id>-<user>-<token>@<domain>`,
whose token is an HMAC of the model, the record and the recipient with `MAIL_INBOUND_SECRET` (`MAIL_INBOUND_DOMAIN`
names the mailbox's domain, `MAIL_INBOUND_ALIAS` the local part, default `reply`). A reply to it comes back through
the provider's webhook, `POST /api/v1/mail/inbound`, authenticated by `MAIL_INBOUND_WEBHOOK_SECRET`
(`X-Kosh-Inbound-Secret`, or `?secret=`): a raw message (`message/rfc822`), Postmark's JSON, or `{ RawEmail }`.
Each message is logged once by its Message-ID (`mail.inbound_message`), then:

- an auto-reply, a bounce or a bulk message is **dropped** (a bounce of a message we sent marks its delivery);
- the target is the reply address's token, else `In-Reply-To` / `References` against the Message-IDs we sent;
  without one the message is **quarantined** (`no-target`);
- a reply from the recipient's own address is **posted as that user** through the chatter, under their rules
  (the quote cut at the usual markers, the files attached to the record); one they may not read any more is
  quarantined (`no-access`);
- a reply from the record's partner or from a follower's address is posted as the system naming the sender
  (`authorEmail`, shown as "Name <address>"); any other sender is quarantined (`sender-unknown`).

Without a webhook provider, set `IMAP_URL` (`imap://user:password@host:143/INBOX`, or `imaps://` for TLS): one
node at a time (a PostgreSQL advisory lock) reads the mailbox every `MAIL_INBOUND_POLL_MS` (30 s), hands each
unseen message to the same handler and marks it seen. Mailgun's forward to a URL ending in `/mime` is accepted
too (`body-mime` in a form post). A **catch-all alias** declared by a module (`inboundAliases` in its manifest:
`support@<domain>` in Projects makes a task in the support project, the sender named on it) takes a message that
names no record; a bounce of a message we sent marks its delivery `bounced` and tells, through the bell, the user
whose action caused the email (`email.bounced`).

HTML from outside is reduced to a small allow-list (`sanitize-html`); the chatter shows the plain text. The
**Email** app (`mail.manager`) lists the log by state: a quarantined message is attached to a record by hand
(posted as the system naming the sender, on a record the manager can read), tried again, or discarded.
Routes: `GET /api/v1/mail/inbound?state=`, `POST /api/v1/mail/inbound/:id/attach { model, id }`, `…/discard`,
`…/retry`. The webhook answers 404 until `MAIL_INBOUND_WEBHOOK_SECRET` is set; `kosh init` writes both secrets
into `.env` (the domain stays to fill in).

## Storage

Bytes live in an object store, metadata in `storage.attachment` (name, type, size, SHA-256, object key):

- `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (and `S3_REGION`): any S3-compatible store (AWS S3,
  SeaweedFS as in `docker-compose.yml`, MinIO), path-style, signed with SigV4 (`@kosh/storage` signs on
  `node:crypto`; no SDK).
- `KOSH_STORAGE_DIR`: a directory (development, tests, single-node installs with a backed-up volume).
- `useStorage(app, storage)` sets any `Storage` implementation (`put`, `read`, `delete`).

Without a store, uploads answer 503. The object is written before its row: a failed transaction leaves an orphan
object, never a row without its bytes; deleted rows remove their objects after commit.

## Events

Posting emits `mail.message.posted` (`{ model, id, message, kind, author, mentions, preview }`) and assigning an
activity `mail.activity.assigned` (`{ model, id, activity, assignee, deadline, by }`) as Shutro outbox events in the
same transaction: they exist exactly when the message or activity does. The notification pipeline (RFC 0006 part
3) subscribes to them and re-checks each recipient's access before delivering.

## Not yet

Typing across nodes (relayed on the node of the sender only), sending chat messages offline, Mailgun's signed
webhook parameters (the shared secret authenticates instead); a cleanup job for objects left behind by failed commits and for attachments of deleted records; decimal
changes are shown as stored (`8,000 → 8,500`, without the field's scale).
