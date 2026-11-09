# RFC 0023 — The module standard

- Status: Accepted (2026-10-31)
- Depends on: RFC 0001 (manifest), 0004 (views), 0005 (documents), 0006 (events), 0014 (import), 0020 (settings),
  0022 (depth and polish)

## 1. Summary

Every Shutro ERP module meets one written standard, and the repository **proves** it: a checker runs with
`pnpm lint` and refuses a module that falls short, unless the manifest waives the rule for a named model with a
reason. Odoo has conventions (a model, its views, access rights, a report, demo data, translations) but nothing
enforces them: a module may ship without a search view, without a report, without translations, with `unlink`
where an archive was due, and nobody notices until a customer does. Here the standard is a list a machine reads.

This RFC sets the standard (§3), measures the forty-one modules against it (§4: the audit of 2026-10-31) and plans
the passes that bring every module up to it (§5). It adds three platform pieces the standard needs: **translated
metadata** (a module's labels in Bangla and any language, served per request language), **Duplicate** on every
record, and the **checker**.

## 2. How Odoo does it, and its weaknesses

- Conventions live in the documentation and in reviewers' heads. The OCA's `pylint-odoo` catches syntax, not
  substance: a model without a search view or a report passes.
- Translations are `.po` files per module, extracted by a command, often stale; untranslated labels show in English
  with no measure of coverage.
- Every record can be duplicated and deleted; archiving (`active`) exists on some masters, by the author's choice.
  Deleting a product that an order used fails with a database error.
- Reports: one QWeb report per document the author remembered to write; purchase orders have one, pickings have one,
  but many community modules have none.
- Import: the generic import screen for every model, with no module-provided template or sample file.

## 3. The standard (version 1)

A rule applies to the models it names; `(waivable)` means the manifest may exempt a model with a reason
(`standard: { waive: [{ rule, model, reason }] }`), which the checker prints, so every exception is traceable.

**Declaration** (checked since RFC 0001): an app or an extension, access levels, menu and action ids, versions.

**Models**

- M1 Every model has a label. *(met)*
- M2 Every model with a list view has a **search spec** — filters, group-bys, a default. *(waivable: lines shown
  inside their parent only)*
- M3 **Master data is archived, never deleted**: a model that other records refer to and that has no state has
  `active`; its list hides archived records by default. *(waivable)*
- M4 **Documents keep their story**: a model with a state has a chatter and tracks its state and key fields. *(waivable:
  sub-documents shown inside their parent)*
- M5 Every state, selection and computed-amount field has **help** (RFC 0022 §3.4 shows it on forms). *(waivable)*

**Views**

- V1 Every public model has a **list and a form**. *(waivable: ledgers and lines)*
- V2 A model with stages or a date has a kanban or a calendar. *(advisory: reported, not refused)*

**Printing, import, events**

- P1 Every document model has a **print template** (RFC 0005): the order, the delivery slip, the production order,
  the leave request… *(waivable)*
- I1 Every master and document model has an **import template** with a sample workbook (RFC 0014 §5.4). *(waivable)*
- E1 Every state transition of a document model emits a named **event** (RFC 0006), so notifications, automations and
  webhooks can take it by name. *(waivable)*

**Apps**

- A1 An app has an overview, demo data, a docs section and an E2E in the apps' catalogue. *(met except as noted)*
- A2 An app with behaviour that differs per company declares a settings section (RFC 0020). *(advisory)*

**Translations**

- T1 Every module ships its labels — models, fields, selections, menus, actions, views' labels and descriptions,
  constraint messages, documents' fixed texts — in **Bangla**; the checker measures coverage (100% required) and
  `pnpm i18n:extract` writes the missing keys. *(platform piece §3.1)*

**Records**

- R1 Every record can be **duplicated** from its form and the API (platform piece §3.2).

### 3.1 Translated metadata

Labels are English strings in the Shutro models (`label: 'Quotations valid for'`); the UI translates only its own
strings today, so a Bangla user sees Bangla chrome and English fields. The manifest already has `i18n: { bn: () =>
import('./i18n/bn.js') }`, unused. Design:

- A module's dictionary is keyed by the **English source string** (as `.po` files are, so one translation serves
  every field called "Name") with optional context keys (`'sale.order.state.draft'`) for strings that differ by
  place. Written in TypeScript (`src/i18n/bn.ts`), typed as `Readonly<Record<string, string>>`.
- The server loads every installed module's dictionaries at start and **translates the metadata, views, menus and
  actions it serves** per the request's language (`Accept-Language`, RFC 0019's profile language): field labels, help,
  selection labels, model labels, view labels, section and page titles, menu labels, button labels, document
  template texts, and the messages of constraints and guards when they reach the client. English stays the key, so
  code never changes.
- `pnpm i18n:extract` walks the registry and the manifests, lists every source string per module, writes the ones
  missing from `bn.ts` as `'Source': ''` and the checker counts them: a module ships 100% or the lint fails.
- Shutro's `translate: true` fields (RFC 0011) keep translating **data**; this is about metadata.

### 3.2 Duplicate

`POST /api/v1/models/:model/:id/duplicate` makes a draft copy as the user: stored, writable, non-unique, non-computed
fields; one2many lines copied, many2one kept; sequences and states reset to their defaults; a field marked
`copy: false` in the model is skipped. The form's menu offers *Duplicate*; the copy opens unsaved-looking but saved,
as Odoo's. If Shutro has a `copy()` it is used; else this is Shutro request #32 and Kosh does the generic copy from
the metadata meanwhile.

### 3.3 The checker

`scripts/check-modules.ts` loads the catalogue (as `generate:models` does), evaluates every rule for every module
and prints a matrix; `pnpm lint` runs it. Each rule is switched on in `pnpm lint` only once every module meets it or
waives it (§5), so the build never goes red for history; new modules meet the whole standard from day one.

## 4. The audit (2026-10-31)

Measured on the demo catalogue (41 modules: 19 apps, 22 extensions).

| Rule | Met | Gaps |
|---|---|---|
| M1 label | all | — |
| M2 search | most | `uom.uom`, `product.category`, `account.tax`, `res.currency.rate`, `res.bank.account`, `account.withholding`, `account.journal`, `account.fiscal.year`, `account.payment.term`, `project.task.stage`, `pos.payment.method` (lists without a search); lines and private models to waive |
| M3 archive | most masters | `product.category`, `project.task.stage`, `crm.stage`, `hiring.stage`, `res.currency.rate`, `stock.lot`, `trade.lc.limit` |
| M4 chatter | the main documents | `production.workorder`, `trade.lc.amendment`, `trade.lc.presentation`, `trade.lc.charge`, `website.submission`, `account.fiscal.year` have a state without a chatter |
| M5 help | 5 fields of ~1 050 | nearly all |
| V1 list + form | most | `purchase.order.line` (no list), `pos.payment.method` (list only), lines and ledgers to waive |
| P1 print template | Sales (quotation), Accounting (2), Event Hub, Counter, `l10n_bd` (4) | **Purchase**, Stockroom (delivery slip, receipt, count sheet), Production (order, work order), Asset Care (work order), Trade Finance (LC), Workforce (leave, contract), Projects (task sheet, timesheet), Pipeline, Hiring, Agenda, Focus, Sites |
| I1 import template | Contacts (1) | every other master and document |
| E1 events | Sales, Purchase, Accounting (1 each), Event Hub (2), Sites, Counter | Projects, Focus, Agenda, Pipeline, Workforce, Hiring, Stockroom, Production, Asset Care, Trade Finance |
| A1 app basics | all apps have an overview and demo data; docs and E2E for every app | — |
| T1 Bangla labels | none (6 modules have Bangla for their own pages only) | all 41 |
| R1 duplicate | none | all |

## 5. Delivery plan (each step reviewed)

1. **The checker and the quick model pass**: `check-modules` with waivers; M2 search specs, M3 `active` on the
   masters listed, M4 chatter and tracking on the documents listed, V1 lists and forms; rules M1–M4 and V1 switched on.
2. **Printing**: a template for every document model (P1), on the Print menu and in the portal where the document is
   shared; `pnpm lint` enforces P1.
3. **Import**: templates and sample workbooks for every master and document (I1).
4. **Events and Duplicate**: E1 on every transition; R1 on the platform (§3.2) with its E2E.
5. **Translations**: the platform (§3.1), `i18n:extract`, Bangla for every module (T1) — the largest pass, last so it
   covers what steps 1–4 add.
6. **Help**: M5 on every state, selection and computed amount (the texts that guidance shows), then the standard is
   version 1 complete.

## 6. Open questions

1. **Order**: the checker and quick model pass first, translations last (proposed), or translations first because the
   Definition of done already names Bangla?
2. **Waivers**: in the manifest (proposed: traceable, reviewed with the module) or in one repository file?
3. **Duplicate**: through Shutro (`copy()`, request #32) or Kosh's generic copy from the metadata?

## Alignment with CLAUDE.md

- Explicit over magic: the standard is a list, exceptions are named with reasons, the checker is in `pnpm lint`.
- Metadata-driven: translations, printing, import and duplicate all come from declarations, not per-module code.
- Secure by default: archive instead of delete keeps referential history; Duplicate is a create as the user.
- Kosh never reimplements ORM features: record copying is asked of Shutro first.

## Decisions (2026-10-31)

1. **Order**: the checker and the quick model pass first; printing, import, events and Duplicate next; translations
   last, so they cover what the earlier steps add; help closes version 1.
2. **Waivers** live in the manifest (`standard: { waive }`), reviewed with the module.
3. **Duplicate**: asked of Shutro (request #32, a metadata-aware `copy()`); Kosh copies from the metadata meanwhile.

## Implementation notes (2026-10-31): step 1 — the checker and the quick model pass

- **The checker** (`scripts/check-modules.ts`, `pnpm check:modules`, run by `pnpm lint`): loads every module in
  `modules/` from its package entry (`scripts/source-loader.mjs` lets Node run the TypeScript sources as they are),
  measures each rule of §3 for each model, subtracts the manifests' waivers and fails on an enforced rule. Rules
  enforced today: M1, M2, M3, M4, V1; M5, P1, I1, E1, T1 are reported with their counts (139, 15, 48, 14, 41 open
  after this step) until their passes land. A **document** is a model with a state (`f.state`, or a selection named
  `state`); a **line** belongs to a parent (`ondelete: 'cascade'`) and is shown and imported with it; **master data**
  is named, referred to by other records, and neither.
- **M2**: search specs for the twelve lists that had none (units, categories, taxes, order lines, currency rates,
  bank accounts, withholding kinds, journals, fiscal years, payment terms, task stages, payment methods) and
  Payment's providers and transactions.
- **M3**: product categories, task stages, deal stages, hiring stages and lots are archivable (their modules move up
  a version for the new column). Waived with reasons: full reconciliations and stock levels.
- **M4**: fiscal years, work orders, LC amendments, presentations and charges, website submissions and Payment's
  providers and transactions got a chatter and track their state.
- **V1**: portal announcements are private (sent, never browsed); reconciliation records and valuation layers are
  waived as ledgers seen from the records they belong to.


## Implementation notes (2026-11-04): step 2 — printing

- **Every document model has a print template** (P1, now enforced by `pnpm lint`). Twenty were missing:
  - fiscal years, purchase orders, requests (Approvals), meetings, document requests, events with their attendees;
  - maintenance orders, transfers, stock count sheets, scrap notes, production orders;
  - payment providers and receipts, counter session reports, project plans, job openings, signature requests;
  - to-dos, letters of credit, and shipping labels (with a QR of the tracking reference).
- Each template binds only its own module's fields, so it prints with that module alone; bridges add theirs. Each is
  on the record's Print menu, and in the portal where its document is shared.
- **P2, enforced**: every shipped template binds fields its model and the models it reaches have. The checker builds
  each model's fields across the catalogue (its own, its extensions', and those every record has) and runs
  `layoutProblems` of `@kosh/reporting`, the check the template designer already ran on drafts.
- It found two mistakes:
  - the Attendance register's table bound `records` instead of `$records`, so it printed an empty table;
  - one new template bound a bill of materials' `name`, which bills of materials don't have.

## Implementation notes (2026-11-04): step 3 — import

- **Every master and document model has an import template** (I1, now enforced). 53 templates were added across 22
  modules. Each lists the model's own fields that a person fills in, by their labels, and for documents up to five
  fields of their lines (`lines.product`…). Left out:
  - what the system fills (states, numbers, results, hashes);
  - fields that point at records the system makes (entries, payments, transfers);
  - baselines and approved budgets, which only managers set.
- **Waived with their reasons**: records only the system makes, which no sheet should create — reconciliations,
  payment transactions, counter sessions and sales, signature requests, shipments, stored files and payroll runs.
  Expense reports were already waived.
- **I2, enforced**: every column of every import template (the existing ones too) is a field the importer accepts —
  it exists on the model or its extensions, is not read-only, computed or a state, is a cell kind, and a
  `line.field` path goes through a one2many to a field of its lines. All templates met it.
- Sample workbooks come from the importer as before: `GET /api/v1/import-templates/:model?mapping=<module>.<key>`.

## Implementation notes (2026-11-04): step 4 — events and Duplicate

- **E1, enforced**: every document model emits a named event. `emitting(topic, transition)` (`@kosh/server`) wraps a
  transition so that, after its own `after`, it emits `topic` with `{ id }` for each record — in the transaction,
  through the outbox. The module declares the topic in its manifest's `events`, for webhooks and automations.
  - New topics: payments posted; meetings cancelled; maintenance started and done; transfers done, counts applied and
    scraps done; production orders confirmed and done; counter sessions closed; job openings closed; to-dos done;
    letters of credit issued and settled; shipments delivered and returned.
  - Fiscal years and online payments have no transitions, so their code emits `account.fiscal.year.closed` and
    `payment.transaction.done`. Requests already emitted `approval.ask.approved`; it is now declared.
  - Payment providers are waived: they are configuration, not documents.
- **R1 Duplicate** on every record, from the form's menu and the API (`POST /api/v1/models/:model/:id/duplicate`, in
  the OpenAPI document). The copy is made as the user, from the metadata (Shutro request #32 stays open for a
  `copy()` of its own):
  - stored, writable fields are copied — many2one kept, many2many the same set;
  - states, numbers and computed fields start again;
  - a field of a unique constraint (beside the company) is left out, or gets "(copy)" when it is a required text;
  - one2many lines are copied with the record, without their link back.
  The form opens the copy, saying so.
- **Tests**: unit tests of `emitting`; on real PostgreSQL a project copied with its phases and a new number, a type's
  required unique code copied with "(copy)", a user without the right to create refused; end to end, *Duplicate*
  from a project's form opening its copy.

## Implementation notes (2026-11-04): step 5 — Bangla for every module

- **The platform** (`packages/server/src/i18n.ts`):
  - Each module's manifest names its dictionary (`i18n: { bn: () => import('./i18n/bn.js') }`, keyed by the English
    text), and the server merges the installed modules' dictionaries at start.
  - A `preSerialization` hook translates what it serves to the request's language (`Accept-Language`, which the
    back-office sends from the person's language; `bn_BD` falls back to `bn`): apps, menus, actions, views, searches,
    model metadata, overviews, settings and the next step of a record.
  - Problems' details have their known messages translated too.
  - A field's label may have a context key, `<model>.<field>`, for where the English word means something else.
  - English stays the key, and what has no translation is served in English. Changing the language refetches what
    the screen shows.
- **`pnpm i18n:extract`** (`scripts/i18n-extract.ts`, with `scripts/i18n-strings.ts`) lists every string a module
  serves:
  - its models' and fields' labels (Shutro's derived labels included), help, selection and state labels, and
    constraint and guard messages;
  - its manifest's app, roles, actions, menus, views, searches, settings, overview, print and import templates,
    events and approval policies.
  It writes `src/i18n/bn.ts`, keeping translations and context keys and adding what is missing as `''`. `--check`
  lists what is missing.
- **T1, enforced**: every module ships Bangla for everything it serves — about 3,850 strings across 58 modules (2,669
  distinct), translated to `docs/i18n-glossary-bn.md`. Common words were made the same everywhere; 42 strings differ
  by module on purpose (an Indian state is রাজ্য; a till receipt is রসিদ and goods received প্রাপ্তি).
- **Tests**: unit tests of merging, language fallback, what is and is not translated, and problems; on real PostgreSQL
  a Bangla request getting Bangla menus and field labels and an English one English.

## Implementation notes (2026-11-04): step 6 — help, and the standard complete

- **M5, enforced**: every state, selection and computed amount has its help — 192 fields across 28 modules:
  - what the value means, or how it is computed, in one sentence for the person reading the form;
  - with its Bangla, so T1 still holds;
  - the e-invoice fields l10n_in mirrors onto invoices carry the same help as their originals.
- **A1, enforced**: every app has an overview and demo data.
  - Approvals, Documents and Sign now have overviews: requests waiting and decided, files received, signatures out
    and signed, with charts by category, folder, state or template. They depend on Reporting for them.
  - Approvals' demo data is a business trip waiting for approval and a draft purchase request.
  - Sign is waived: demo signature requests need a template made from an uploaded PDF.
- **Every rule of version 1 is enforced by `pnpm lint`**: M1–M5, V1, P1–P2, I1–I2, E1, T1, A1, plus R1 on the
  platform. A new module meets the standard or explains, in its manifest, why not.
