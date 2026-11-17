# RFC 0036 — Tools on Shutro: the opening-balance kit, generators, data health

- Status: **Accepted** (2026-11-17)
- Builds on: RFC 0014 (data import), RFC 0012 (Studio), RFC 0023 (the module standard and `shutro-erp check`),
  RFC 0034 §2.2 (doctor, backups), RFC 0009 / 0021 (Accounting, Stockroom and its valuation)
- Replaces: RFC 0034 §2.3 (the Odoo importer, withdrawn 2026-11-16). Kosh ships no tools for other systems: every
  tool here works with Shutro's metadata and Kosh's own models only, whatever the company used before.

## 1. Why

Three things decide whether a company can run on Kosh and whether a developer can build on it, and Odoo leaves each
to consultants:

1. **Starting**: a company arrives with balances, unpaid invoices and stock from *somewhere* (another system, a
   spreadsheet, an accountant's ledger). Odoo offers list imports and an opening-balance screen per account, with no
   proof that what was entered equals what the company had.
2. **Building**: a developer adding a model in Odoo writes Python, XML views, CSV access rights and translations by
   hand, and learns about a missing piece in production. Kosh has `module create` and the module standard; nothing
   yet generates a model *with everything the standard asks for*.
3. **Staying healthy**: duplicates, broken links and books that drift from stock pile up silently. Odoo has a
   duplicate merger for contacts and nothing else.

## 2. What changes

### 2.1 The opening-balance kit (Settings › Start from your figures, and `shutro-erp opening`)

One workbook per company, downloaded from Kosh with the company's own chart, partners, products, warehouses and
lots already listed (RFC 0014's templates), in five sheets:

| Sheet | What it holds | Becomes |
| --- | --- | --- |
| Trial balance | each account's balance at the cut-off; this year's for income and expense | one posted **opening entry**, the earlier years' result on retained earnings |
| Receivables | each unpaid customer invoice and credit note: number, dates, partner, amount left | a posted invoice or credit note of that kind for what is left, payable and followed up in Kosh |
| Payables | each unpaid vendor bill and refund | a posted bill or refund, the same way |
| Stock | product, warehouse location, lot or serial number, quantity, unit cost | one validated **inventory adjustment per location**, lots on their lines, valued at the cost given and dated the cut-off (stock valuation's accounting date and unit cost, kept from the withdrawn importer) |
| Control totals | what the old system says: total receivable, total payable, stock value, each account's balance | nothing — they are what the proof checks against |

**The proof**, run in the same transaction (so a check-only run proves it too) and shown on screen with every
difference opening its rows:

- the trial balance at the cut-off equals the sheet, account by account;
- each partner's receivable and payable equals the sum of their open documents, and the totals equal the control
  totals;
- the stock's quantity per product, location and lot equals the sheet, and its value equals the control total;
- the stock account's balance equals the stock's value (or the difference is named, for a company whose old system
  did not value stock in its books);
- the **Opening balances** clearing account nets to zero.

Every row keeps its old reference as an external id (`opening.<sheet>_<ref>`), so a second load finds the same
rows instead of duplicating them; one opening per cut-off. Until the first posting after the cut-off, **Undo the
opening** reverses all of it in one action (like the import's undo). The result is a signed **opening
certificate** (PDF: the figures, the checks, the time, who approved, the hash of the workbook) stored in Documents.

The same flow runs from the command line: `shutro-erp opening template`, `shutro-erp opening check <file>`,
`shutro-erp opening load <file> --commit`.

### 2.2 Generators (`shutro-erp make …`)

Each generator writes code that **passes `shutro-erp check` on its first run**, reading Shutro's registry so it
never guesses a field or a model:

- `make model <module> <name> --fields "name:char! amount:money partner:m2o:res.partner state:state"` — the Shutro
  model with company scoping, archiving and chatter as the standard asks; its list, form, kanban and search views;
  the menu and action; access levels (user / manager) with model rights; a print template and an import template;
  a named event; English labels with their Bangla entries to fill (`pnpm i18n:extract`); a demo seeder; an
  integration test with a permission test that proves a user without the role is refused.
- `make field <model> <name:type>` — the field added to the model, its views and both templates, with a migration.
- `make transition <model> <name> --from draft --to confirmed` — the state change with its button, its named event
  and its test.
- `make report <model>` (a pivot and a chart), `make action <model> <name>` (a server action with its permission),
  `make page <module> <name>` (a custom React page wired into the menu, light and dark, both languages).
- `make bridge <a> <b>` — the bridge module between two apps, its dependency declared, its test.

Every generator prints what it wrote, never overwrites a file a person changed (it shows a diff instead), and runs
the typed model generation. `--dry-run` shows the files without writing them.

### 2.3 Data health (`shutro-erp check data`, and Settings › Data health)

Checks over each company's data, each finding with the records behind it and, where it is safe, a repair:

- **Duplicates**: contacts (name, tax id, email, phone, normalized), products (code, barcode, name) — reviewed side
  by side and **merged**: every link to the duplicate moved to the record kept (found from Shutro's relations, not a
  hand-kept list), its chatter and attachments carried over, the duplicate archived, the merge audited and undoable
  for 7 days.
- **Broken or doubtful links**: documents pointing at archived partners or products still open, lines whose product's
  unit category differs from their unit, orphan attachments.
- **Books against operations**: the stock account against the valuation layers; receivable and payable accounts
  against open documents; posted documents against their entries; quants against the stock ledger. Each difference
  is named with the documents that cause it.
- **Sequences and numbering**: gaps and duplicates in document numbers per journal and year.
- A weekly run as a job, with a notification to Administrators when something new is found; the latest result on
  the doctor (`shutro-erp doctor`) and on the Administrator's home page.

Repairs never post to the books and never delete: they relink, archive or propose an adjusting document for a
person to post.

## 3. Past Odoo

- Odoo's opening balances are typed account by account, with no receivables as documents, no stock with lots and
  costs in one step, no proof and no undo.
- Odoo's scaffold (`odoo-bin scaffold`) writes an empty module; it knows nothing of views, rights, translations or
  tests.
- Odoo merges contacts only; it has no consistency check between its books and its stock.

## 4. Steps

1. **The opening-balance kit**: the workbook template, check and load from the command line, the proof, external
   ids and one opening per cut-off.
2. **The kit on screen**: Settings › Start from your figures, the proof with its differences, Undo the opening, the
   signed certificate.
3. **Generators, part 1**: `make model` and `make field`, passing `shutro-erp check`.
4. **Generators, part 2**: `make transition`, `report`, `action`, `page`, `bridge`, the diff instead of overwriting.
5. **Data health, part 1**: `shutro-erp check data` with books against operations and numbering.
6. **Data health, part 2**: duplicates and merging with undo, broken links, the weekly job, the screen.

Then RFC 0034's feature steps (5 onward: sign-in, calendars, rich text, subscriptions, timesheet billing, leave
accruals, surveys and careers, loyalty and live chat), already accepted.

Each step: typed end to end, integration tests on real PostgreSQL, permission tests (only Administrators run the
opening and the repairs), E2E for the screens, English and Bangla, light and dark, desktop and phone, docs.

## 5. Open questions

1. The kit's workbook: XLSX only (proposed), or CSV per sheet as well?
2. Merging duplicates: Administrators only, or also each app's managers for their own records (Contacts managers
   for contacts)?
3. Generators write into `src/modules/<module>/` of an installation (proposed), and into `modules/` when run inside
   this repository?

Answered 2026-11-17 with the proposals: XLSX only; Administrators merge; generators write into `src/modules/`
(and `modules/` inside this repository).

## Implementation notes

- **Step 1 (2026-11-17).** **The opening-balance kit from the command line**: `shutro-erp opening template | check
  <file> | load <file>`. The engine is in Accounting (`modules/accounting/src/opening.ts`: the workbook's template and
  reader on `@kosh/reporting`'s writer and `@kosh/import`'s reader, the load, the proof); Stockroom's models are
  reached by name, so the Stock sheet is refused with the reason without Stockroom. The trial balance is entered as
  it is at the cut-off (income and expense for the year so far), so no fiscal-year reckoning is needed; it must
  balance. Every miss — an account code, a contact, a product, a location, a lot missing on a tracked product — is an
  error with its sheet and row, all of them listed before anything is written. The stock goes first (an adjustment
  per location with the system-only accounting date and unit cost of stock valuation), then the opening entry at
  each account's balance less what Kosh already posted by the cut-off, then the documents. A load is kept only when
  every check is equal; *stock in the books* names a difference without refusing. One opening per cut-off (external
  id `opening.entry_<date>`). Docs: docs/opening-balances.md. Left for step 2: the screen, Undo, the certificate.
- **Step 2, part 1 (2026-11-17).** **The kit on screen, and Undo.** Each load is an `account.opening` (what it
  made, the proof it passed, the workbook's SHA-256, who and when; read by accounting managers, written by the
  system only); one loaded opening per cut-off replaces the external ids of step 1. **Undo** until the first
  posting after it (`lastMove` kept at the load): each entry and document reversed at the cut-off with
  `reverseMove` and reconciled with its reversal per account and partner, each stock adjustment returned line by
  line (`returnOf`, so it leaves at the value it came in at), lots on their lines; refused with the reason once
  something was posted or the stock moved; a corrected workbook then loads again. The API (`/accounting/opening`,
  `…/template`, `…/check`, `…/load`, `…/undo`) is for Administrators — `env.administrator`, which needs their second
  factor — and runs the load and the undo as the system with the user kept. The page is **Accounting › Configuration
  › Start from your figures** rather than a Settings section: Accounting does not depend on the Settings app, and
  the menu is shown to Administrators only (the server does not serve the action to anyone else). Left: the signed
  certificate (part 2).
- **Step 2, part 2 (2026-11-17).** **The opening certificate.** At the load the opening is sealed: the company, the
  cut-off, the workbook's hash, the counts, every check with its summary, who and when, kept as text (`sealed`) with
  its SHA-256 (`seal`) and, when the installation has `KOSH_SIGNING_KEY` (now written by `init`), its HMAC-SHA-256
  (`signature`). The checks are also lines (`account.opening.check`) so the certificate is an ordinary document
  template (`accounting.opening_certificate`) printed by the existing renderer — no PDF code of its own; the page's
  Download the certificate and the form's Print menu use it. `verifyOpening` (the API's `/opening/verify`,
  `shutro-erp opening verify [file]`): the seal, the record against what was sealed, the signature, the workbook's
  hash. The certificate is produced on demand from the sealed record rather than stored as a file in Documents
  (Accounting does not depend on Documents, and the record is what is sealed). The opening, now referred to by its
  lines, is waived from M3 and I1 with reasons. Step 2 complete; next step 3 (generators).
