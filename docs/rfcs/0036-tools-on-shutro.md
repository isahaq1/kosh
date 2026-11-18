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
- **Step 3 (2026-11-17).** **Generators, part 1: `make model` and `make field`.** A generated model is a **part**:
  `src/modules/<module>/parts/<name>.ts` exports its model, action, menu, views, search and import template;
  `parts.ts` (generated, rewritten by each `make model`) merges the parts; the manifest takes them through
  `withParts(parts, {…})` of the modules SDK and the Shutro module through `models: [..., ...parts.models]`. So no
  generator rewrites hand-written code: `index.ts` is touched once, to merge the parts, when it has the scaffold's
  shape — otherwise the two lines to add are said. `make field` inserts at `// make:` markers in the part and says
  what to add by hand where a marker was removed. Field specs `name:type[!]` (char, text, integer, decimal, boolean,
  date, datetime, selection:a|b, m2o:model), refused with what is wrong; a selection gets a help (M5). `module
  create`'s own first model now has a label and a search, so a new module passes `shutro-erp check` as made. The
  test generates a module, two models and a field and runs the real check on them (the generated code loads through
  Shutro's `defineModel` and Kosh's `defineModule`). Left for part 2 (step 4): documents — a state with its
  transitions, chatter, print template and named event (`make transition`) —, `make report / action / page /
  bridge`, a demo seeder and a generated test with its permission test, and the diff instead of a refusal when a
  part exists.
- **Step 4, part 1 (2026-11-17).** **`make transition`: documents.** The first transition of a part adds the
  state (`f.state` with its states, initial, help and the transition wrapped in `emitting(<model>.<to>)`),
  `tracking: ['state']`, the state as a badge on the list, the form's header (status bar, the button) and
  `chatter: true`, a print template from the model's plain fields, and the event; later ones insert at
  `make:states / transitions / buttons / events`. Parts now always export `documents` and `events`, and `parts.ts`
  merges them. A document needs Messaging and Reporting: `index.ts` of the scaffold's shape gets both as
  dependencies and `<module>.user` implies `messaging.user` and `reporting.user`, as the shipped apps do (found
  when a user of the generated module could not list its print templates); otherwise the lines are said. Proved
  running (`make.integration.test.ts`): the generated module installed on PostgreSQL and served — create, steps in
  order (out of order refused), search, the print template, a required field, and 403 for someone without the role
  and for a user's delete. Left: `make report / action / page / bridge`, a demo seeder, a generated test, the diff
  instead of a refusal.
- **Step 4, part 2 (2026-11-17).** **The other generators.** `make action`: a transition with `requires` and an
  `orm.definePermission` for `<module>.manager` (or `--group`) — the RFC's "server action with its permission" is a
  guarded step, which is what Kosh's action permissions are. `make report`: a pivot and a chart (`graph`) at
  `make:views`, on the model's action, with Reporting wired. `make page`: `web/<Name>Page.tsx` (its words in both
  languages beside it), a generated `web/index.ts` registering the module's pages and exporting their messages, a
  part with the client action and menu, and `src/main.tsx` wired when it has the starter's shape. `make bridge`:
  `src/modules/<a>_<b>/` depending on both (yours by path, an app by `shutro-erp/<app>`), `bridge: [a, b]`, listed
  in `src/modules.ts`. Parts now also export `permissions` and `data` (a sample record, when no required relation
  must be guessed); `wireParts` is incremental and merges them into the Shutro module; parts made earlier are
  brought up to date by `syncParts`. `make model` writes the model's test, on **`testInstallation`** — new in
  `@kosh/server/testing` (`shutro-erp/testing`): modules installed and served on a scratch database, a company, the
  Administrator with their second factor and the users asked for, `call(method, url, as)`; without
  `KOSH_TEST_POSTGRES` it uses the installation's `DATABASE_URL` server. The starter gets `vitest` and `npm test`.
  A part that exists is left and the lines `make model` would write are shown (`lineDiff`). Proved: the generated
  module with its action, report and seed on a served installation (a user is refused the manager's step, the
  sample is there, the pivot's query answers); the generated page loaded with React stubbed and called; the bridge
  through `shutro-erp check`. Not proved: the page in a browser, and the generated test file run inside a real
  installation (its helper is what this repository's own test runs on). Step 4 complete; next step 5 (data health).
- **Step 5 (2026-11-17).** **Data health, part 1: `shutro-erp check data`.** Checks are **declared by the modules**
  (`dataChecks` in the manifest: a key, a label saying what holds, `run(env)` returning findings with their
  records) rather than kept in one tool: only the installed apps' run, and a company's own module adds its own.
  `checkData` (`@kosh/server`) runs them per company as the system, each in a savepoint, and rolls the run back, so
  looking changes nothing; a check that breaks is reported as broken. Shipped: Accounting (entries balance, a
  document's amount left against its receivable or payable lines, numbering without gaps or duplicates), Stockroom
  (stock on hand against what the validated transfers moved, per product across the internal locations — putaway
  inside the warehouse does not disturb it), stock valuation (the layers against the stock accounts, the layers'
  quantities against the stock on hand). The test loads an opening, sees every check hold, then damages the stock,
  the valuation and a document's amount left and sees each named with its record; it also found that a posted
  entry's number cannot be changed by SQL at all (the database's immutability), so the numbering check's failure
  path is not exercised by a test. The check labels are in Bangla (T1). Docs: docs/data-health.md. Next (step 6):
  duplicates and merging, broken links, the weekly job with its notification, the doctor and the screen.
- **Step 6, part 1 (2026-11-18).** **Duplicates and merging.** Modules declare `duplicates` (a model and the keys —
  sets of fields, `digits` for phone numbers — that suggest two records are one): Contacts by tax ID, email, phone
  and name, Products by name. `findDuplicates` groups the active records by normalized key, through the ORM (the
  caller's rules apply). `mergeRecords` (`@kosh/server`) moves every stored many-to-one to the model and every
  record referring by `resModel` / `resId` to the record kept — found from `apiModels`, not a list —, archives the
  duplicates and logs what moved in `kosh.merge` (private, in base). It writes through the ORM in a system scope:
  audited, constraints applied; a link that cannot be written (a posted entry's partner) refuses the whole merge.
  `undoMerge` within 7 days puts back what still points at the record kept and restores the duplicates. Routes in
  Settings (`/settings/data-health`, `/duplicates`, `/duplicates/merge`, `/merges`, `/merges/:id/undo`),
  Administrators only — the RFC's answer; reads run as the Administrator, since a read-only request cannot open a
  system scope. Not done: many-to-many relations to the merged record; merging by app managers. Next (part 2): links
  to archived records, the weekly run stored with its notification, the doctor; then the page (part 3).
