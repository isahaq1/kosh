# RFC 0035 — Migration beyond Odoo

- Status: **Proposed** (2026-11-16)
- Builds on: RFC 0034 §2.3 (the importer, steps 3 and 4), RFC 0012 (Studio), RFC 0014 (import), RFC 0019 (people,
  roles and the preview), RFC 0006 (jobs, outbox), RFC 0034 §2.2 (backups, `backup verify`)
- Why: RFC 0034 made the move from Odoo *possible and provable* from the command line: master data, the books and
  the stock at a cut-off, each reconciled with Odoo's. A company still cannot run its whole migration from Kosh: open
  orders, users, files, conversations, custom fields and history stay behind; the parallel run and the cut-over are
  not built; and only a person at a terminal sees the proof. This RFC makes migrating into Kosh **the best-run
  migration in the ERP market**: complete, watched from a screen, provable at every step and reversible until the
  first posting.

## 1. What "beyond Odoo" means here

Odoo moves data *between its own versions* (its upgrade service) and imports *one list at a time* (CSV). It has no
migration from another system, no parallel run, no reconciliation proof and no rollback. This RFC holds every item
to three tests:

1. **Nothing lost silently**: every Odoo record read is accounted for — imported, linked, skipped with a reason, or
   failed with Kosh's answer — and every figure that matters is compared with Odoo's.
2. **Proof a third party accepts**: the final reconciliation is a document an auditor can file, not a log line.
3. **Reversible**: until the first posting in Kosh, the company can go back to Odoo with nothing to undo.

## 2. What changes

### 2.1 The Migration workspace (Settings › Migration)

The command line stays; everything it does is also a screen, for Administrators only (a new access level
`migration.manager`, audited like any other).

- **Connections**: an Odoo's address, database and login, and its API key, kept in the installation's secret
  store (encrypted at rest with the installation key, never shown again, never in the audit log). Tested on save:
  Odoo's version, the apps installed in it, and which Kosh apps each would need.
- **Plan**: the steps that will run, each with the number of Odoo records it will read, the Kosh app it needs (with
  Install from the App manager when missing), and its mapping (2.2).
- **Runs**: a dry run or an import as a background job (RFC 0006), with live progress per step through the
  real-time gateway, resumable after a crash or a restart from the last finished step (each step's checkpoint is
  stored), and cancellable.
- **The report on screen**: every step's counts; every failed record with Kosh's answer and **links to the record
  in both systems** (Odoo's own URL for it, and Kosh's form); every check with its differences, each opening the
  records behind it. Export as XLSX and PDF. Runs are kept, so two runs can be compared ("12 failures fixed, 1 new").

### 2.2 Mapping that a person finishes once

Today the plan is fixed in code. Here it is proposed from both sides' metadata and finished on screen:

- **Fields**: every Odoo field of an imported model that has no Kosh counterpart is listed with sample values, and
  can be mapped to a Kosh field, to a new custom field (2.5), or explicitly left out.
- **Values**: selections, taxes, journals, payment terms, units and accounts that do not match by name or code are
  shown side by side and matched once (with a suggestion by similarity).
- The mapping is saved per connection, versioned, and audited; a run records the mapping version it used.

### 2.3 Everything a company works with, not only its master data

New steps, each with its counts, its failures and a check:

- **Open sales and purchase orders**: confirmed and not fully delivered or invoiced, as confirmed Kosh orders for
  what is left — delivered and invoiced quantities kept, so delivery and invoicing carry on in Kosh; quotations as
  quotations. Check: each open order's remaining quantity and amount equals Odoo's.
- **People and roles**: Odoo's internal users as Kosh people, invited by email (never a password copied); Odoo's
  groups mapped to Kosh roles by a proposed table (Sales / User → `sales.user`, …), finished on screen, with RFC
  0019's **preview of who gains and loses what** before anything is applied. Portal users become portal users of
  their contact (RFC 0015). Records keep their salesperson and owner.
- **Files**: each imported record's attachments into Kosh's storage, with their names, types and dates, hashed;
  check: every file's size and hash.
- **Conversations**: each imported record's chatter — comments, notes and logged changes — with their authors and
  dates, marked as imported; its followers; its open activities with their deadlines and assignees.
- **Employees, departments and projects with their tasks and stages** (RFC 0034 already lists them).

### 2.4 History, without touching the books

Closed documents of past years (paid invoices, done orders) are wanted for reference, but importing them as
documents would post them twice — the opening entry already holds their effect. They come as **Odoo history**: a
read-only record per document with its number, dates, partner, lines, totals and state, and Odoo's own PDF stored
with it, shown in a **From Odoo** panel on the contact, the product and the record they relate to, and searchable.
Reports can include them with a filter. Nothing in the ledger changes.

### 2.5 Custom fields through Studio

Odoo's custom fields (`x_…`, Studio's `x_studio_…`) on imported models become a **Kosh Studio module** (RFC 0012):
the importer writes its spec — fields with their types, labels and selection values, placed in the forms and lists
where Odoo shows them — and Studio's review shows the diff and the SQL before it is applied. Their values are then
imported like any other field. Custom models follow the same way, if the mapping keeps them.

### 2.6 The parallel run

- **Incremental sync**: each step reads only what changed since its last watermark (`write_date`), detects
  records deleted in Odoo (an archive in Kosh, never a delete), and runs every night or on demand.
- **Odoo stays the book of record** until cut-over: a Kosh record also changed in Kosh since the last sync is not
  overwritten; it is listed as a conflict with both versions, resolved on screen.
- **Daily reconciliation**: every check of RFC 0034 (trial balance, partners, open documents, stock quantity and
  value) runs after each sync; the drift is a chart over the days, and a difference notifies the migration managers.
- Postings in Kosh during the parallel run are refused (a company setting, *Migration in progress*), so the books
  can still be rebuilt from Odoo; everything else — reading, reporting, training — works.

### 2.7 Cut-over and rollback

- **A checklist on screen**: the last sync, the final reconciliation green, Odoo users told to stop (Kosh never
  writes to Odoo; making Odoo read-only is a step a person ticks), the cut-over date.
- **A verified backup** (RFC 0034 `backup` and `backup verify`) taken automatically just before.
- **The reconciliation certificate**: a PDF with both systems' figures for every check, the counts per step, the
  mapping version, the time, the people who approved, and the hash of the full JSON report — signed with the
  installation key, stored in Documents, verifiable later (`shutro-erp odoo verify-certificate`).
- **Rollback** until the first posting in Kosh: one action restores the pre-cut-over backup and reopens the
  parallel run. After the first posting, the action says why it is no longer offered.

### 2.8 Scale

Paged reads streamed into the run (never all of a model in memory), batched writes, one transaction per step with a
savepoint per record (as now), and the checkpoint per step. Budgets in the benchmark suite: 100,000 contacts and
products and 1,000,000 journal items reconciled in under 30 minutes on the reference machine.

### 2.9 Later, on the same pipeline

The steps read through a **source adapter** (Odoo's JSON-RPC today). The same workspace, checks and certificate then
serve other systems — Tally and ERPNext first (common where Kosh is aimed), QuickBooks after — each a module adding
an adapter. Not in this RFC's steps.

## 3. What this RFC needs from you

- **Approval** of the scope and the order below.
- The answers to the open questions (§5).

## 4. Steps

1. **The workspace and runs as jobs**: connections with the secret store, the plan, runs in the background with
   live progress, resume and cancel, the report on screen with links to both systems, run comparison, XLSX / PDF.
2. **Open orders**: sales and purchase, with what is left to deliver and invoice, and their check.
3. **Mapping on screen**: fields and values, saved and versioned per connection.
4. **People and roles**: users invited, groups mapped to roles with the preview, portal users, owners kept.
5. **Files, conversations, followers and activities.**
6. **Custom fields through Studio.**
7. **Employees, departments, projects and tasks.**
8. **History** as read-only Odoo history with its PDFs.
9. **The parallel run**: incremental sync, conflicts, the daily reconciliation with its drift chart, the
   *Migration in progress* lock on postings.
10. **Cut-over**: the checklist, the backup, the signed certificate and its verification, rollback until the first
    posting.
11. **Scale**: streaming, batches, the benchmark budgets.

Each step: typed end to end, integration tests on real PostgreSQL against a recorded Odoo 18 (re-recorded live),
permission tests (only migration managers), E2E for the screens, English and Bangla, light and dark, desktop and
phone, docs (docs/odoo.md and docs/pilot.md). This RFC replaces step 4 of RFC 0034 (parallel run and cut-over).

## 5. Open questions

1. **Secrets in the database** (2.1): the API key encrypted with the installation key, so the screen can run
   migrations. The alternative is the environment only (`ODOO_PASSWORD`), as today, with the screen unable to start
   a run by itself. Proposed: the secret store, with the environment still honoured.
2. **History** (2.4) as read-only records rather than documents: agreed?
3. **Locking postings during the parallel run** (2.6): on by default for the migrated company?
4. **Writing to Odoo**: never (proposed), or an opt-in to archive Odoo users at cut-over?
5. **The next source** after Odoo: Tally, ERPNext or QuickBooks?

## Implementation notes

(None yet.)
