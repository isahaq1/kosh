# RFC 0027 — Approvals: the matrix, beyond Paragon's `dynamic_approval`

- Status: Accepted (2026-11-07)
- Builds on: RFC 0025 (Approvals, an app of its own), RFC 0003 §5.3, RFC 0024 step 5 (cost centres)
- Reference: `pg-odoo/custom-addons/dynamic_approval` (Odoo 19, Paragon) — templates per model by companies or
  segment, levels by role type, backup approvers, reassignment, skip duplicate approvers, pending sync, a matrix log
  with timings, a personal dashboard

## 1. Why

Paragon runs its group on `dynamic_approval`. For Kosh's Approvals to replace it, everything it does must work in
Kosh, and better. RFC 0025 already goes further on most axes; this RFC closes the rest.

### 1.1 Where Kosh is already ahead

| | `dynamic_approval` | Kosh (RFC 0025) |
| --- | --- | --- |
| Which records | One template per model and company, first match | Policies **with conditions** (amount, any field) and **conditions per level** — "above 1 lakh, the director too" |
| How many decide | Any one approver | **Any, all, or N of M**, each vote kept |
| Answers | Approve, reject (reason) | Approve, reject (reason), **send back for changes** with rounds, **withdraw** by the requester |
| When nobody decides | — | **Deadlines** per level, a reminder at half, **escalation** to a role |
| Absence | Standing backup users per level | **Away**: a delegate between two dates, deciding in their own name, audited "for" |
| Where to decide | The form, the dashboard | The app's inbox with **bulk approval** and the keyboard, the record's stepper, **one-time email links** |
| Without a document | — | **Generic requests**: categories with fields, outcomes on approval (an RFQ…) |
| Checking a policy | — | **Preview**: who would decide this record, before saving |
| Languages | English | English and Bangla |

### 1.2 What `dynamic_approval` has and Kosh lacks

1. **Department head** as an approver (the head of the requester's department).
2. **Department / cost-centre approvers**: people named on a department who approve for it.
3. **Product-group approvers**: the approvers of the product categories on the document's lines.
4. **Extra people on any level**: named people *added* to whoever the role type resolves.
5. **Standing backup approvers** per level (beside the date-bound Away).
6. **Skip duplicate approvers**: a level whose approvers include someone who already approved this round is approved
   automatically, marked as such.
7. **Scope by several companies or a segment** (a group of companies: Feed, Poultry, Dairy). Kosh: one company or all.
8. **No approver found → refuse the submission and say why** (who was looked for). Kosh falls back to a role, and with
   nobody in it the request waits for no one.
9. **Pending sync**: when a level's approvers change, the waiting requests follow — add only or replace — with a
   notice to the people added.
10. **Reassignment** by an Approvals manager (replace or add, with a reason), logged and notified.
11. **The matrix log** per request: created, started, approved, auto-approved, rejected, cancelled, reassigned,
    synced, notified — and **how the approvers were found** ("Rahim → manager Dina; assigned: Karim").
12. **Timings**: when a level became current, how long it waited for earlier levels, how long it has been current.
    Kosh sets a level's deadline at submission, so a third level's clock runs while the first is deciding — a defect.
13. **Dashboard cards** per policy and document type: waiting, approved, rejected, over a period (7 days … all),
    **direct or delegated**.

## 2. Design

All in the engine (`packages/permissions/src/approvals.ts`) and the Approvals app; modules only gain hooks.

### 2.1 More ways to find the approvers (1–4)

`approval.level.approverKind` gains:

- `department_head` — the head of the requester's employee's department (Workforce);
- `department_approvers` — the people on the department's new **Approvers** (`hr.department.approvalUsers`,
  added by `hr`; a cost centre's too, `account.analytic.approvalUsers`, used when the record has a cost centre);
- `record` — **the record decides**: the model's `approvers(levelKey)` method returns user ids per record. Purchase
  overrides it for product-category approvers (`product.category.approvalUsers`, on the lines' products); any module
  can do the same — more general than one hard-coded "product group".

A new `approval.level.extraUsers` adds named people to whatever the kind resolves (for `users`, they are the same
list). Resolution returns, beside the ids, **an explanation** (§2.5).

### 2.2 Backups and skipping duplicates (5–6)

- `approval.level.backupUsers`: always allowed to decide the level, beside its approvers; votes are marked "as backup".
  Away delegation stays for absences between dates.
- `approval.policy.skipDuplicates`: when a level becomes current, if one of its approvers already approved this round,
  their vote is copied — `decision: 'approved'`, `auto: true`, comment "Already approved at level X" — and the quorum
  checked as usual (a level needing two still needs a second person).

### 2.3 Scope: companies and segments (7)

- `res.company.segment` → `res.segment` (name, code, companies), managed in Settings › Companies.
- `approval.policy` gains `scope: 'all' | 'companies' | 'segment'`, `companies` (many2many) and `segment`. The
  existing `company` becomes `companies` with one entry (a migration). Policies still match by condition, so
  segment-wide and company-specific policies can coexist; a company-specific policy wins over a segment-wide one with
  the same target and sequence (`overrides` on the policy, explicit, shown in the preview).

### 2.4 When nobody is found (8)

`policy.whenNobody: 'refuse' | 'admins' | 'skip'` — when a level finds no person and has no role to stand in. Default
**refuse**: the submission fails with a 422 naming the level and the explanation ("Rahim has no manager with a user in
Workforce"). `admins` lets administrators decide; `skip` records the level as skipped in the log (every level skipped:
approved at once). A level with a role always has someone — administrators decide a role nobody holds yet, as before —
and its explanation says so.

### 2.5 The log, explanations and timings (11–12)

- `approval.event` (request, at, user, kind — `created | started | voted | auto | rejected | sent_back | cancelled |
  reassigned | synced | escalated | reminded | notified` —, note). Read through the request's record rule.
- `approval.request.explanation` (text): how the approvers were found, written at creation and on every sync.
- `approval.request.startedAt`: set when the level becomes current; **the deadline counts from it** (the defect in
  §1.2 #12 fixed). Computed `waitedHours` (created → started) and `activeHours` (started → decided or now).

### 2.6 Keeping waiting requests right (9–10)

- `approval.policy.syncPending: 'off' | 'add' | 'replace'` (default `add`) and `notifyOnSync`. Saving a level's
  approver fields re-resolves its pending requests in the same transaction, logs `synced` and notifies the people
  added to a current level. A **Sync now** button on the policy, with the count.
- **Reassign** on a pending request, for Approvals managers: new approvers, replace or add, a required reason;
  logged and notified; never the requester (separation of duties holds).
- **Notify backups** on a current request: a chatter note mentioning them, logged.

### 2.7 The dashboard (13)

The Approvals overview gains a **Matrix** section: a card per policy (or document type) with waiting / approved /
rejected for a chosen period, each number opening the filtered list; a **Direct / Delegated** switch (delegated:
requests I may decide only as a backup or a delegate). Also: **average hours to decide per level** and **who is the
bottleneck** (approvers with the most overdue) — which `dynamic_approval` cannot show.

## 3. Beyond `dynamic_approval` as well

- Approvers found by **record**, not only by product group (§2.1).
- Duplicate-skip respects quorum; backups vote in their own name; every automatic step is in the log.
- Refusing with an explanation at submission, instead of a dead request.
- The deadline clock starts at the level's turn, and escalation and reminders use it.
- The preview shows segment scope, backups, extra people and duplicates skipped before a policy is saved.

## 4. Steps

1. Approver kinds (`department_head`, `department_approvers`, `record` with Purchase's product categories),
   `extraUsers`, `whenNobody`, explanations; `approval.event` and `startedAt` with the deadline fix.
2. Backups, skip duplicates, reassign, notify backups, pending sync.
3. Segments and company scope (migration of `company`), the preview updated.
4. The Matrix dashboard: cards per policy and period, direct / delegated, time to decide, bottlenecks.

Each step: tests on real PostgreSQL (permission tests for reassign and backups), English and Bangla, the E2E of the
inbox and the policy form, docs/approvals.md (new; today the engine is in docs/permissions.md).

## 5. Notes

- **Step 1 (2026-11-07).** Approver kinds `department_head`, `department_approvers` (`hr.department.approvalUsers`) and
  `record` (`approvalUsers(key)`; Purchase: `product.category.approvalUsers`, the nearest up the tree), `extraUsers`
  beside any kind (a role's holders named when a role level has extra people). `whenNobody` is
  `refuse | admins | skip`: a role always has someone — administrators decide a role nobody holds, as before — so it
  applies to levels with no person and no role. `approval.request.explanation` and `startedAt`; the deadline is set
  when the level's turn starts, and the sweep counts the reminder from it. `approval.event` is the log, returned with
  the record's approvals (`events`) and shown in the panel under "How the approvers were found". The cost-centre
  approvers of §2.1 wait for a record field naming the cost centre; they come with step 2.
- **Step 2 (2026-11-07).** `backupUsers` on levels and `backups` on requests (deciding beside the approvers, in the
  turn's emails, votes marked `asBackup`); `skipDuplicates` copies an earlier approval of this round as an `auto`
  vote when the level starts, and a level approved this way starts the next turn or approves the record; `reassign`
  (Approvals managers, a reason, never the requester; the people added emailed) and `notifyBackups` (approvers and
  managers); `syncPending` (`off | add | replace`, default `add`) and `notifyOnSync`, run by the Approvals module's
  subscriber on the level's change events, and "Sync waiting requests" on the policy. A write of many-to-many fields
  alone emitted no change event: Shutro request #35, fixed in Shutro 0.3.5. The cost-centre approvers wait for a
  cost centre on the records approved (purchase orders carry it on their lines only).
