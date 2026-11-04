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
