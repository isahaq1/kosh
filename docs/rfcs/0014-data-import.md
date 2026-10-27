# RFC 0014: Data import

- **Status:** Accepted 2026-10-27 with the proposed answers (external ids for imported records through a Shutro
  request, all-or-nothing by default, 50 MB and 1 million rows, a 7-day undo); step 1 implemented (`@kosh/import`)
- **Depends on:** 0002 (metadata, the import route), 0003 (permissions, field security), 0004 (list views),
  0006 (jobs, notifications), 0007 (frontend), 0008 (apps); Shutro external ids (Shutro RFC 0017)

## 1. Summary

An import screen on every list: upload a CSV or XLSX file, map its columns to fields (guessed, then edited), see a
**dry run** with every error on its row and cell, and import. Rows can **create or update** records, matched by
id, external id or any unique field. Relations are matched by name, code or external id, and one2many lines come
from repeated rows. A mapping can be saved and reused. Large files run as a background job with progress. Every
import runs as the user, is all-or-nothing by default, is audited and can be undone.

## 2. Problem

Moving into an ERP means importing customers, products, opening balances and open orders, and that never stops:
price lists, stock counts, the bank's statement. Today Kosh has `POST /api/v1/models/:model/import`, which takes
up to 10,000 rows of already-typed values that can only create records. A user with a spreadsheet can't use it.

## 3. How Odoo does it, and its weaknesses

Odoo's `base_import` is one of its most-used screens: upload, column matching, a "Test" button, then import.

- **Errors are hard to act on**: the test lists messages, often only the first error, as a raw Python constraint
  text without the cell. Users fix one, retry and find the next.
- **Updates need the `id` column** from a previous export (`__export__.res_partner_42`). You can't update
  products by their SKU or partners by their email.
- **Relations** are matched by name only, ambiguously, unless the file uses `/id` columns.
- **One2many lines** use an awkward layout of blank parent cells that is hard to get right.
- **Large files** run in the request and time out (the documentation suggests splitting files).
- **No undo**: a wrong import of 5,000 partners has to be found and deleted by hand.
- Saved mappings are matched by column names only, per user, and can't be shared.

## 4. Options

- **A. A Kosh import service on the metadata API and Shutro's create / write**, with a parse → map → validate →
  commit pipeline, dry runs in a rolled-back transaction, and jobs for large files. Every model and field,
  custom and Studio ones included, is importable without code.
- **B. A client-side parser that sends typed rows to the existing route.** It is simpler, but validation would
  live in the browser, there'd be no updates and no large files, and rules would be checked twice.
- **C. A spreadsheet library** (SheetJS, ExcelJS) for parsing. It reads more formats, but it is a large
  dependency for something `node:zlib` and a small XML reader already handle (Kosh's XLSX writer is the same
  size).

## 5. Recommendation: A

### 5.1 The pipeline

1. **Upload**: the file goes to storage (`@kosh/storage`) as a private attachment of an `import.session`. CSV
   (encoding detected: UTF-8, UTF-16, Windows-1252; separator guessed) and XLSX (first sheet or a chosen one) are
   read on the server. Limits: 50 MB and 1 million rows, configurable.
2. **Map**: each column maps to a field path (`partner`, `lines.product`, `lines.quantity`) or is skipped. Kosh
   guesses from the field labels in every installed language (Bangla headers too), the keys and the external-id
   columns of an export. An export from Kosh re-imports with no edits.
3. **Convert**: cells become typed values: numbers with the user's decimal separator, money as `Decimal` (never
   `number`), dates in the user's format or ISO, booleans (yes/no, true/false, 1/0 and their translations),
   selections by value or label. Relations are matched by **external id, the target's unique fields, then its
   display name**, and the match is shown in the dry run. When a name is ambiguous, the cell gets an error, not a
   guess.
4. **Match** (update mode): rows update existing records when the chosen key matches: `id`, an external id, or any
   field with a unique constraint (SKU, email, VAT number). Rows with no match are created or reported, as the
   user chooses (`create`, `update only`, `create or update`).
5. **Validate (dry run)**: the whole import runs in a transaction that is rolled back. Onchanges, computes,
   constraints, sequences and record rules run as they would for real. The result is per row: created, updated,
   or the errors with the column and cell, the field's label and Shutro's declared message.
6. **Commit**: the same run, committed, all-or-nothing by default. A "skip rows with errors" option commits the
   valid rows in batches and returns a file of the rejected rows with an error column, ready to fix and re-import.

### 5.2 Lines (one2many)

A row whose key columns are empty continues the record above it, and its `lines.*` cells add a line. This is the
layout an export of an order with its lines produces, so a round trip works. The dry run shows each record with
its lines.

### 5.3 Large files

Up to 2,000 rows, the dry run and the import answer in the request. Above that they run as a Shutro job, as the
user, in batches of 1,000 rows, with progress sent over the realtime gateway. A notification arrives when it ends.
All-or-nothing jobs keep one transaction. With "skip errors", each batch commits on its own and a stopped job
resumes from its last batch.

### 5.4 Saved mappings and templates

A mapping (columns → fields, options, key) is saved by name per model, private or shared with a role. A file whose
headers match a saved mapping gets it proposed. Modules can ship templates as data, for example `contacts`'s
"Customers" with a downloadable sample XLSX that has the headers, a description row and the allowed values of
selections.

### 5.5 Undo

Every commit records the created ids and, for updates, the previous values of the changed fields (read before the
write, kept with the session). **Undo** deletes the created records and restores the updated values, if those
records haven't changed since the import (checked against the audit trail). Otherwise it lists the records that
moved on. Undo is open for 7 days and needs the same permissions as the import.

### 5.6 Security

- The `import` permission on the model, plus `create` and / or `write` as the mode needs. Field security applies:
  a column mapped to a field the user can't write is refused at mapping time, and again on the server.
- Rows are written through the ORM as the user: record rules, approvals, transitions and constraints all apply.
  Nothing is bypassed for speed.
- Matching relations reads the targets as the user, so a name the user can't see doesn't match.
- Formula cells in XLSX are read as their cached values and never evaluated. CSV cells starting with `=` are kept
  as text.
- Every dry run, import and undo is audited (`data.import`, `data.import.undo`) with the counts and the file name.
  Files are deleted with their session after 30 days.

### 5.7 API

```
POST   /api/v1/imports                    { model, attachment }       → session (columns, sample rows, guesses)
PUT    /api/v1/imports/:id/mapping        { columns, mode, key, options }
POST   /api/v1/imports/:id/dry-run                                    → per-row results (or a job)
POST   /api/v1/imports/:id/commit         Idempotency-Key             → counts, rejected-rows file (or a job)
POST   /api/v1/imports/:id/undo
GET    /api/v1/imports/:id                                            → state, progress, results
GET    /api/v1/models/:model/import-template?mapping=…               → sample XLSX
```

The existing `POST /api/v1/models/:model/import` stays for scripts: typed rows in, ids out.

### 5.8 The UI

**Import** in a list's action menu (shown when the user has the permission) opens a full-page wizard with three
steps: the file, then mapping (each column with its first values, the guessed field, a field picker that searches
labels and paths, the key and mode), then results (counts and a table of errors filterable by column, with "Fix
in file" downloading the rejected rows). Keyboard-first, works on mobile, all text through i18n, light and dark.

### 5.9 Tests

- Parsers: CSV encodings and separators, quoted newlines, XLSX shared strings, inline strings, dates, formulas,
  empty rows, Bangla text.
- Integration (real PostgreSQL): create, update by unique field and external id, lines, relations by name /
  code / external id, ambiguous names, field security, record rules, all-or-nothing, skip errors, undo with and
  without later changes, a 100k-row job with progress.
- Permission tests: users without `import`, `create` or `write` are blocked at the server on every route.
- E2E: import customers from an XLSX with a Bangla header, fix an error, re-import, undo.
- Budget: a dry run of 10k contact rows in under 5 s, an import of 100k rows in under 60 s.

## 6. Delivery plan (each step reviewed)

1. Parsers (CSV, XLSX reader in `@kosh/reporting` next to the writer), cell conversion, relation matching; the
   session model and the API with dry run and commit in the request; create mode.
2. Update mode (keys), lines, skip errors with the rejected-rows file, undo.
3. Jobs for large files with progress; saved mappings and module templates.
4. The wizard in the back-office; E2E; `docs/import.md`.

## 7. Open questions (answers wanted with the approval)

- **External ids for imported records**: Odoo gives every imported row an external id (`__import__.…`) so a
  later file can update it. Kosh can read external ids today (`env.refId`) but Shutro has no public way to
  *assign* one to a record outside module data. Should Kosh ask Shutro for one (request #28,
  `env.setExternalId`), which is proposed, or match updates on unique fields only?
- **All-or-nothing by default** (proposed), or skip errors by default?
- **The limits**: 50 MB and 1 million rows (proposed)?
- **Undo window**: 7 days (proposed)?

## Implementation notes (2026-10-27): step 1 — parsers, conversion, matching, dry run and commit

`@kosh/import` is a Kosh module with the `import.user` access level ("Import data"): every module declares what
administrators grant (RFC 0001). A user needs that level **and** the model's `import` and `create` permissions;
administrators pass.

- **Reading files**: `readCsv` (byte-order marks, else UTF-8 when the bytes are valid, else Windows-1252; the
  separator counted the same way on most of the first lines; RFC 4180 quoting) and `readXlsx` (`node:zlib` and a
  tag scanner: shared, inline and rich strings, booleans, numbers, dates from built-in and custom date formats,
  formulas read as their cached values, a sheet by name). The reader lives in `@kosh/import`, not next to the writer
  in `@kosh/reporting`: the import module stays free of the reporting stack. The writer builds the test files.
- **Conversion** (`convertCell`): decimals stay exact text (from `1,234.50`, `1.234,50`, `(1,200.00)`, `৳ ১২,৫০০`;
  `1,5` with a `.` decimal is an error, not 15), dates in the file's day order with impossible days refused,
  date-times with an offset as given or else as wall-clock times in the file's time zone (`Intl`, no library),
  booleans in English and Bangla, selections by value or label. Errors carry a stable code for the UI's messages.
- **Matching** (`matchOne`): `#42` (an id), an external id (`env.refId`), each char field the target keeps unique on
  its own (a unique constraint or index, the company aside), then the display name exactly and as the one name
  containing the text. Each distinct text once per import; several matches are `ambiguous`.
- **The run** (`runImport`): cells converted, relations matched, then one `create` of every valid row in a savepoint;
  when it fails, row by row in savepoints, so each failing row gets Shutro's message on the column of the field it
  names. A dry run, or any error, rolls the savepoint back. A required field without a column is reported once and
  nothing is written. (Shutro describes x2many fields as required, as they are never null: an empty set. The import
  counts them as optional.)
- **The session**: `import.session`, the uploader's own through a record rule, holds the file in a binary field (an
  import works without object storage configured), the mapping, the options, the state and the created ids.
- **API**: as in §5.7 for upload, read, mapping, dry run and commit (`Idempotency-Key`; 422 with the errors, 409 once
  imported; audited as `data.import`). Until jobs (step 3), a file of more than 10,000 rows is refused with 413.
- **Tests**: parsers and conversions (13 unit tests) and the API on PostgreSQL (access, the guessed mapping, field
  security, every error kind with its row and column, a constraint failing in the database, all-or-nothing,
  relations by name, code and external id, XLSX with a remapped column, idempotent replays, the row limit).

## Alignment with CLAUDE.md

"Server is always the authority": parsing, conversion and validation are on the server; the wizard shows results.
"Secure by default": the `import` permission, field security and record rules on every row; audited. "Money is
always `Decimal`": amounts are parsed as text into `Decimal`. "Justify every new dependency": none (a reader next
to the existing XLSX writer). "Metadata-driven": every model, custom and Studio fields included, is importable
without code.
