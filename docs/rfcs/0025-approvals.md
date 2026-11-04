# RFC 0025 — Approvals: an app of its own

- Status: Accepted (2026-11-04)
- Builds on: RFC 0003 §5.3 (multi-level approvals), RFC 0018 (workspace back-office), RFC 0022 (app depth)

## 1. Why

Approvals today are an engine, not a product. A module declares policies (`approvals` in its manifest), each with
ordered levels decided by holders of a role; a submitted record gets one request per matching level; the last approval
runs the policy's transition. The engine is sound — separation of duties, levels in order, audited, conditions as
domains checked when saved — but the people who use it get little:

- **No place of their own.** Decisions wait in a short list on the Today home and a small panel on the record's form.
  There is no Approvals app, no history of what one decided, no view of what one asked for.
- **Only documents.** Nothing can be asked without a document behind it: a business trip, a payment, borrowing a
  laptop, a budget overrun, a price exception. Odoo has an Approvals app for exactly these.
- **One approver model.** A level is "anyone holding this role". No named people, no "the requester's manager",
  no quorum ("two of the three directors"), no levels side by side.
- **Nothing happens when nobody decides.** No deadline, no reminder, no escalation, no delegation while someone is
  away; a request can wait forever.
- **Two answers only.** Approve or reject — no "send it back for changes", no required reason on a rejection.
- **Plain.** The panel shows raw states (`pending`) in English only, no progress, no time waited, no bulk decisions,
  no decision from an email or a phone.

## 2. What Odoo does, and where we go further

| | Odoo (Approvals, purchase double validation) | Kosh after this RFC |
| --- | --- | --- |
| Requests without a document | Approval categories with optional fields | Categories with fields **and lines**, an attachment rule, and an **outcome** (an RFQ, an expense, a leave…) made on approval |
| On documents | Per app (purchase threshold, leave validation) | **One engine for every app**, declared in manifests or made by administrators without code |
| Approvers | Users, manager, min. approvals | Users, roles, **the requester's manager (Workforce)**, a **quorum** (any, all, N of M), **parallel levels** |
| When nobody decides | — | **Deadlines** per level, **reminders**, **escalation** to a fallback, **delegation** while away |
| Answers | Approve / refuse | Approve, reject (**reason required**), **send back for changes** (the record returns to draft; the next submission is a new round, history kept) |
| Where | Its app | **An app**: inbox with key facts, my requests, history, overview; the record's **stepper**; **one-click decisions from email** (signed, confirmed); the Today home and the bell |
| Bulk | — | Select and approve many with one comment |
| Measure | — | Time to decide by level and approver, overdue, approval rate — pivots and charts |

## 3. Design

### 3.1 The Approvals app (`@kosh/approvals`, a module on top of `packages/permissions`' engine)

The engine stays in `packages/permissions` (RFC 0003 decided it lives there). A new module `modules/approvals` adds
the app — menus, pages, generic requests, the scheduler — so installing it is a choice, and every app keeps working
with the engine alone.

- **Inbox** (the app's home): what waits for me, as cards — the record's name and key facts (amount, partner, dates:
  the record's `k.stats`/summary fields), the requester with their avatar, the level and the stepper of all levels,
  how long it has waited (a chip that turns amber at half the deadline, red when overdue), the comment box, Approve /
  Reject / Send back. Filters by app, by overdue, by amount; select many and approve them with one comment. Keyboard:
  `J`/`K` to move, `A` approve, `R` reject, `C` comment.
- **My requests**: what I asked for, where each stands, who it waits for, since when; withdraw one.
- **History**: what I (or my team, for managers) decided, with comments.
- **Overview** (RFC 0022): waiting, overdue, decided this month, median time to decide, by app and by approver.
- **Configuration**: policies and categories edited on screen — levels as rows, the condition with the condition
  builder of the Automation app (RFC 0011), a **preview** of which of the last 50 records each level would have
  caught.

### 3.2 Generic requests (`approval.category`, `approval.ask`)

A category (Business trip, Payment, Equipment, Price exception…) says which fields a request has — amount, period,
partner, location, quantity, product lines, an attachment (required or not) —, its levels (as a policy does), and its
**outcome**: nothing, or a document made on approval through a hook other modules provide (`purchase`: an RFQ from the
lines; `expense`: an expense report; `hr`: a leave). Categories ship with modules (data) and are made by administrators.

### 3.3 Engine depth (in `packages/permissions`)

- **Approvers** of a level: a role (today), named users, the requester's **manager** (from Workforce, when installed;
  the role otherwise), or the record's own field (a project's manager).
- **Quorum**: any one (today), all of them, or N of them; each approver's decision is kept.
- **Parallel**: levels with the same sequence are decided side by side.
- **Deadline** per level (hours, business hours when Attendance's calendar exists): a reminder at half, then
  **escalation** to the level's fallback approvers; both audited.
- **Delegation**: "while I am away (from–to), my approvals go to X" — X decides in their own name, "for" the
  absent approver, shown and audited. Separation of duties still applies to the delegate.
- **Send back for changes**: a third answer with a required comment; the policy's `onSentBack` transition (usually
  back to draft) runs; the next submission starts a new **round**, the earlier rounds kept and shown.
- **Rejection reason** required (a policy may relax it).
- **Withdraw**: the requester cancels their pending requests (the record's transition, when declared).

### 3.4 Decisions from anywhere

- **Email**: each approver gets the request with Approve / Reject buttons — signed, single-use, expiring links that
  open a confirmation page (never a decision on a GET: mail scanners follow links); signed in or not, the decision is
  the approver's, audited with the address.
- **Notifications**: the bell and web push carry the request; the Today home keeps its list.
- **Phone**: the inbox works at phone width; cards swipe to approve or reject (with an undo toast).

### 3.5 What stays

Policies declared in manifests and their conditions, `requestApprovals` / `approvalGuard` for modules, the inbox API
(extended, compatible), separation of duties, audit of every step, the record's panel (redesigned as the stepper).

## 4. Steps

1. **The engine**: approvers (users, manager, field), quorum, parallel levels, send back with rounds, required
   rejection reason, withdraw; the API and its tests (every existing approval keeps working).
2. **The app**: the inbox with cards and bulk decisions, my requests, history, the stepper on records, English and
   Bangla; the overview.
3. **Deadlines, reminders, escalation, delegation**; decisions from email.
4. **Generic requests**: categories with fields and lines, outcomes through hooks (`purchase`, `expense`, `hr`),
   shipped categories; the policy and category editor with the preview.

## 5. Decisions (2026-11-04)

1. **Order**: the engine and the app first (steps 1 and 2), then deadlines, delegation and email (step 3), then
   generic requests (step 4).
2. **Approve from email**: yes — a signed, single-use, expiring link that opens a confirmation page; the decision is
   audited with the address, never made by opening the link.
3. **The requester's manager without Workforce**: a manager level names a fallback role, used when Workforce is not
   installed or the requester has no manager.

## Implementation notes (2026-11-04): step 1 — the engine

- **Approvers** per level (`approval.level.approverKind`): a role (the default), named people, the requester's
  manager (Workforce's `hr.employee.manager`, read when Workforce is installed), or the user in a many-to-one field of
  the record (`approverField`); a manager or a field with nobody — or the requester themself — uses the level's role
  (the decision of §5). Never the requester (separation of duties).
- **Quorum** (`quorum`: any, all, count): named people, or a role's holders in the record's company when all or a
  number of them must approve; the request records who decides (`approvers`), how many approvals it needs
  (`required`) and each **vote** (`approval.vote`, one per person); it is approved by the last vote it needs.
- **Parallel levels**: levels with the same sequence were already decided side by side (a level waits only for lower
  sequences); now documented.
- **Send back for changes** (`POST …/send-back`): a third answer; the round's other open requests are cancelled and
  the policy's `onSentBack` transition runs; a **round** number on every request — the next submission is the next
  round, the earlier kept and served with the record's history. **Rejections and sendings back say why** unless the
  policy's `reasonRequired` is off.
- **Withdraw** (`POST /api/v1/approvals/:model/:id/withdraw`): by the requester (or an administrator); the pending
  requests are cancelled, the policy's `onWithdrawn` transition runs, audited.
- **Compatible**: manifests keep `approverRole` (now also the fallback); every existing policy, test and screen keeps
  working; the inbox and the record's history carry `approvers`, `required`, `approvals` and `round`.
- **Tests**: on real PostgreSQL named people who must all approve (each vote, a second vote refused, someone not
  named refused, the inbox of each), sending back with a reason required and the second round, a rejection without a
  reason refused, withdrawing by the requester only and its transition, a manager level falling back to its role, and
  levels that do not name their approvers refused; the earlier approval tests unchanged.

## Implementation notes (2026-11-04): step 2 — the app

- **`@kosh/approvals`** (`modules/approvals`), the **Approvals** app every user has (its access level is `base.user`;
  *Policies* for the new **Approvals manager** group, which may edit `approval.policy` and `approval.level`).
- **To approve** (the app's home): a header — waiting for me, waiting over three days, decided this month, the median
  hours to decide (`GET /api/v1/approvals/stats`) — and the requests as **cards** (`GET /api/v1/approvals/cards?list=inbox`):
  the record's name and kind with its link, who asked, how long it has waited (amber after a day, red after three),
  the round, the votes, every level of the round as a **step**; a comment and *Approve*, *Send back for changes*,
  *Reject* (the last two only with a comment). Select many and **approve them at once** (`POST /api/v1/approvals/bulk`,
  each checked as a decision of its own, the refused ones saying why). Keyboard: J / K, A, R, X.
- **My requests** (`list=mine`): one card per record — its latest round, where it stands, what was said — withdrawn
  while it waits. **What I decided** (`list=history`): each of my votes with the record, the answer, the comment, when.
- **The record's panel**, redesigned: the current round as steps with their votes and comments, earlier rounds behind
  a disclosure, the user's decision with the three answers, *Withdraw my request* for the requester; in English and
  Bangla (`approvalPanel` messages), as every Approvals screen.
- **Policies on screen**: the policy with what happens (approved, rejected, sent back, withdrawn) and its levels as
  lines — who decides, the role, the people, the field, how many.
- An overview of declared cards is not possible yet: requests are private models (never served by the generated API
  the overviews read); the header gives the figures instead.
- **Tests**: on real PostgreSQL the inbox as cards (the record's name and kind, the requester, the steps), approving
  two at once with a refused third, my requests, what I decided, the header, an unknown list refused; end to end, a
  purchase order of 140 000 decided from the inbox and seen approved in the requester's requests.

## Implementation notes (2026-11-04): step 3 — deadlines, delegation, decisions from email

- **Deadlines** (`approval.level.deadlineHours`, `escalateRole`): a request's `dueAt` is set when it is asked. Hourly
  (and by `POST /api/v1/approvals/deadlines/run`) each pending request is **reminded** once at half its deadline and,
  once late, **escalated**: the level's escalation role may decide it too (`escalatedTo`), audited
  (`approval.escalated`); both email who may decide. The inbox shows when a request is due (red once late) and
  whether it was escalated. Business hours (Attendance's calendar) are left for later: deadlines count clock hours.
- **Delegation** (`approval.delegation`, Approvals › *Away*): "from … to …, X decides for me". Each person keeps
  their own (record rules); Approvals managers see all; never to oneself. A delegate sees the absent approver's
  requests in their inbox and decides **in their own name, for them**: the vote keeps `onBehalfOf`, the audit says it;
  separation of duties still holds, and a request decided by either is decided for both.
- **Decisions from email**: when a record's approvals are asked, and whenever a level is approved and the next one's
  turn comes, each person who may decide it now — its approvers or role's holders, the escalation role once late, and
  their delegates — gets an email with a **link of their own** (`approval.link`, a digest kept, seven days, single
  use). The link opens a confirmation page (its script allowed by a nonce); opening it decides nothing — mail scanners
  follow links. The decision runs **as that person** (their groups, the engine's checks), is audited with the address
  it came from (`approval.vote.ip`), and spends the link. Sent through the mailer (`SMTP_URL`) after the commit.
- **Fixed on the way**: datetimes read through `read()` arrive as ISO strings — `decidedAt` (and now `dueAt`) were
  always empty in the API; both are served.
- **Tests**: on real PostgreSQL (over the permissions package's purchase fixture) a delegation to oneself refused,
  the delegate emailed and deciding for the approver, the approver then refused a second decision, the delegation
  removed; reminded at half the deadline once, escalated past it to a role whose holder could not decide before and can
  after; an email link's page (nothing decided by opening it), a rejection without a reason and an unknown decision
  refused, the approval as its person, the link spent; when a request was decided; end to end, *Away* filled on screen.

## Implementation notes (2026-11-04): step 4 — generic requests

- **The engine** (`packages/permissions`): `approval.policy.condition`, a domain on the policy's model checked when
  saved; a policy with one covers only the records that meet it, before its levels' own conditions.
  `previewPolicy()` lists, for each level, which of the last 50 records within the policy's condition it would have
  asked about (`GET /api/v1/approvals/policies/:id/preview`, Approvals managers; the policy form's
  *What the levels would have asked about*).
- **Categories** (`approval.category`, in the Approvals app, which now depends on Contacts):
  - Name, code, an optional company, a description for whoever asks, and for each request field — amount, period,
    contact, location, quantity, lines, attachment — not asked, optional or required.
  - The outcome: a code an installed app offers, else refused.
  - Its policy on `approval.ask`, with the category as the condition and one level, the requester's manager (else an
    Approvals manager). It is made when the first request is submitted, or by *Set up its approvals* on the category
    (`POST /api/v1/approvals/categories/:id/policy`), and its levels are edited on the policy.
  - Business trip, Payment (a file required), Purchase request (lines required) and General ship as data.
- **Requests** (`approval.ask`, `REQ-00001`):
  - The category's fields, copied onto the request so the form shows and marks only those it asks for, and lines
    with their total.
  - Submitting checks the required ones (a file through the chatter's attachments), makes the category's policy
    when missing, asks the approvals and names the **deciders**: the pending levels' approvers, role holders and
    delegates. A record rule lets the deciders read the request; the requester reads theirs and changes them while
    a draft or refused; Approvals managers see all.
  - Approved, `runOutcome()` runs as the system; the event is `approval.ask.approved`.
- **Outcomes through hooks**: `approval.ask.outcomes()` (code → label) and `runOutcome()`, which apps extend. The
  `approvals_purchase` bridge (Approvals ↔ Purchase) adds a product to request lines and the `purchase` outcome: a
  request for quotation to the request's contact from its lines with products, once, shown on the request. When
  installed, it gives the shipped Purchase request category that outcome. Expense reports and leave as outcomes are
  left for their apps' bridges.
- **Tests**:
  - On real PostgreSQL:
    - the shipped categories;
    - a category made by a manager and refused to a user, an unknown outcome refused;
    - its policy made once with its condition, its level set to a named approver, a condition that is not a domain
      refused;
    - a request refused without its required amount, then submitted, asking only its category's policy, readable by
      its decider and not by others, frozen for its requester, approved from the inbox;
    - the preview;
    - a payment refused without its file, with its lines totalled.
  - With Purchase: an approved purchase request made into a request for quotation to its contact from its line with
    a product.
  - End to end: a business trip asked with the fields its category shows, then submitted.
