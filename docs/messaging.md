# Chatter and attachments

Every record of a served model can have a **chatter**: messages to its followers, internal notes, @mentions, files,
followers, planned activities, and the change log read from Shutro's audit trail (RFC 0006 §5.1). It is exactly as
visible as the record: every route reads the record as the caller first, so record rules and field security decide.

```ts
import { messaging } from '@isahaq/kosh-messaging';

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
import { messagingMessages, registerMessagingWeb } from '@isahaq/kosh-messaging/web';

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

## Storage

Bytes live in an object store, metadata in `storage.attachment` (name, type, size, SHA-256, object key):

- `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (and `S3_REGION`): any S3-compatible store (AWS S3,
  SeaweedFS as in `docker-compose.yml`, MinIO), path-style, signed with SigV4 (`@isahaq/kosh-storage` signs on
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

Realtime updates (part 2: the chatter refreshes after the user's own actions, not yet when someone else posts),
notifications (part 3), chat channels (part 4), replies by email (part 5); a cleanup job for objects left behind by
failed commits and for attachments of deleted records; decimal changes are shown as stored (`8,000 → 8,500`, without
the field's scale).
