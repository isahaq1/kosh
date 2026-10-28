# Shutro ERP against Odoo

An honest ledger, kept current as parts land: where Shutro ERP is ahead today, where it matches, and where Odoo is still
ahead. "Today" means code on `main` with tests; planned work is in the last section, not in the ledger.

## Ahead today

| Area | Odoo | Shutro ERP |
|---|---|---|
| Types | Python classes, untyped field access; renamed fields break at runtime | TypeScript end to end: model → generated views → REST → OpenAPI → generated client → UI. A wrong field in a view, a query or a client call is a compile error; views are also checked against the models when the server starts |
| Security enforcement | ACL and rules in Python; any public method is an RPC entry point; `sudo()` anywhere; field `groups=` on views is UI-only in places | One engine (Shutro) in SQL for every read and write, including aggregates, exports and reports; the generated API exposes operations, not methods; a generated test matrix proves forbidden users get 403 on every endpoint type of every model |
| Administrator | `base.group_system` bypasses ACL; no 2FA requirement; the last admin can be locked out | One explicit bypass (Shutro administrator mode), rights withheld until a second factor, the last active 2FA administrator cannot be archived, stripped or lose 2FA; integrity rules still apply |
| Roles | Groups are global; configuration is XML / CSV in modules | Roles built from access levels in the admin API, assigned **per company** (manager in one company, user in another), field security per role without code, special grants with expiry, every change audited twice (Shutro ERP and Shutro) |
| Approvals | Per-module (purchase double validation, Approvals app), different models | One engine: ordered levels with domain conditions, approver role per company, separation of duties (administrators included), policies shipped by modules and edited as data, every decision audited |
| Pivots | `read_group` per header level; totals recomputed client-side; cross-currency sums | One statement for every level and total (the leaf grouping, rolled up exactly on the server; expand / collapse without a query; 1M rows in ~0.5 s); amounts stay per currency at every level; drill-down domains on every header; period comparisons aligned on buckets; `asOf` for models with history |
| Exports | Load into memory; some field restrictions bypassed | Streamed CSV of millions of rows in one consistent transaction with bounded memory; XLSX with real types and formats; the `export` permission and an audit event on every export; formula-safe CSV |
| Documents | QWeb XML templates, wkhtmltopdf (unmaintained) | JSON layouts bound to fields, printed by Chromium via Playwright (modern CSS, paged media); a drag-and-drop designer with a live preview; bindings validated on save; renders audited; rules apply to the printed data |
| Chatter | `mail.thread` mixin per model; tracking values copied into messages (editable, only tracked fields); followers may receive content of records they can no longer read; message HTML sanitized after the fact | Every served model, no mixin; the change log *is* the audit trail read as the user (cannot be edited; field security hides restricted fields); every chatter route re-checks the record under the caller's rules; bodies rendered from escaped text; attachments never render active content in the app's origin |
| Concurrency | Last write wins | Compare-and-set end to end: ETags on the API, `If-Match` from the UI, a stale record asks for a reload instead of overwriting |
| Jobs and events | Cron on `ir.cron`; side effects in the request | Transactional outbox and jobs in PostgreSQL: an event or job exists iff the transaction committed; handlers run as the user who caused them, under their rules |
| Front end | OWL (proprietary), XML views, patches on prototypes | React 19, TanStack, Radix, Tailwind; views as typed data extended by anchors with recorded origins; light / dark, RTL by construction, i18n with ICU; axe-checked |
| API contract | JSON-RPC `call_kw`, no OpenAPI, no versioning | REST with RFC 9457 problems, OpenAPI 3.1 generated from the registry, a typed client generated and checked in CI, idempotency keys on unsafe calls |
| Customer portal | Portal users reach the same JSON-RPC as employees, limited by record rules alone (every readable field of a ruled model is one `read` away); pages per app in QWeb with their own controllers | Portal users reach only the portal API (the server refuses them everything else in one check); documents are declared once in a manifest — fields, lines, PDF, actions, thread — and only declared fields are returned; a declaration without its record rule stops the server; signatures keep a hash of what was signed; a separate, phone-first app in English and Bangla (RFC 0015) |
| Data import | `base_import`: errors often one at a time, as raw messages; updates only by the `/id` of an earlier export; relations by ambiguous name; large files time out in the request; no undo | Every error at once on its row and column; updates by id, external id or any unique field (a code, an email); relations by external id, code or name, never a guess between several; lines from continuation rows that round-trip with exports; skip errors with a rejected-rows file; files of up to 1 million rows in the background with progress; undo for 7 days that leaves records changed since alone; saved and shared mappings, module templates and sample workbooks (RFC 0014) |

## At parity today

- List, kanban, form, calendar, gantt, map, hierarchy, cohort, graph, pivot, dashboard and spreadsheet views, with
  one shared search layer (filters, group-by, favorites, saved and shared searches) across all of them.
- Multi-company with per-company currency rounding; audit trail per record (Shutro); scheduled reports by cadence.
- Module system with manifests, dependencies, access levels, menus, actions, default data (policies, templates).

## Odoo is still ahead

- **Breadth of business apps**: Shutro ERP has Contacts, Products, Sales, Purchase, Accounting and Projects with their
  bridges; Odoo has inventory, HR, CRM, manufacturing, e-commerce, point of sale, localizations, and thousands of
  community modules.
- **Documents on records**: a document management app, OCR, digital signatures.
- **Spreadsheet** depth (Odoo Enterprise: pivot insertion, charts, collaborative editing). Shutro ERP's is formulas and
  live report totals.
- **Mobile apps** (Shutro ERP is a PWA with offline forms; no native app yet); barcode scanning.
- **Ecosystem**: partners, hosting (odoo.sh), marketplace, certifications, documentation volume.
- **Materialized aggregates** for dashboards (Shutro ERP dashboards are live queries, client-cached briefly).

## What makes the "more flexible" claim true in practice

- Every screen is data: a module changes another module's view by anchor without forking it, and the server records
  who changed what (`resolveView` chain).
- Every renderer, widget and node component is registered by name and replaceable; a view can be replaced by a React
  component when metadata is not enough.
- Conditions are domains, evaluated in SQL on the server and (where possible) in the browser, never strings in a
  mini-language.
- The framework never reimplements the ORM: when Shutro ERP needed something (grouping sets, runtime field security,
  cache release, binary batches), Shutro gained it with tests, and `docs/shutro-requests.md` records every request.

## Next

Country localizations (Bangladesh first) and an integrations platform (API keys, OAuth apps, inbound webhooks,
online payments) are the next framework RFCs; the business apps are a separate roadmap.
