# Kosh against Odoo

An honest ledger, kept current as parts land: where Kosh is ahead today, where it matches, and where Odoo is still
ahead. "Today" means code on `main` with tests; planned work is in the last section, not in the ledger.

## Ahead today

| Area | Odoo | Kosh |
|---|---|---|
| Types | Python classes, untyped field access; renamed fields break at runtime | TypeScript end to end: model → generated views → REST → OpenAPI → generated client → UI. A wrong field in a view, a query or a client call is a compile error; views are also checked against the models when the server starts |
| Security enforcement | ACL and rules in Python; any public method is an RPC entry point; `sudo()` anywhere; field `groups=` on views is UI-only in places | One engine (Shutro) in SQL for every read and write, including aggregates, exports and reports; the generated API exposes operations, not methods; a generated test matrix proves forbidden users get 403 on every endpoint type of every model |
| Administrator | `base.group_system` bypasses ACL; no 2FA requirement; the last admin can be locked out | One explicit bypass (Shutro administrator mode), rights withheld until a second factor, the last active 2FA administrator cannot be archived, stripped or lose 2FA; integrity rules still apply |
| Roles | Groups are global; configuration is XML / CSV in modules | Roles built from access levels in the admin API, assigned **per company** (manager in one company, user in another), field security per role without code, special grants with expiry, every change audited twice (Kosh and Shutro) |
| Approvals | Per-module (purchase double validation, Approvals app), different models | One engine: ordered levels with domain conditions, approver role per company, separation of duties (administrators included), policies shipped by modules and edited as data, every decision audited |
| Pivots | `read_group` per header level; totals recomputed client-side; cross-currency sums | One `GROUPING SETS` statement for every level and total (expand / collapse without a query); amounts stay per currency at every level; drill-down domains on every header; period comparisons aligned on buckets; `asOf` for models with history |
| Exports | Load into memory; some field restrictions bypassed | Streamed CSV of millions of rows in one consistent transaction with bounded memory; XLSX with real types and formats; the `export` permission and an audit event on every export; formula-safe CSV |
| Documents | QWeb XML templates, wkhtmltopdf (unmaintained) | JSON layouts bound to fields, printed by Chromium via Playwright (modern CSS, paged media); a drag-and-drop designer with a live preview; bindings validated on save; renders audited; rules apply to the printed data |
| Concurrency | Last write wins | Compare-and-set end to end: ETags on the API, `If-Match` from the UI, a stale record asks for a reload instead of overwriting |
| Jobs and events | Cron on `ir.cron`; side effects in the request | Transactional outbox and jobs in PostgreSQL: an event or job exists iff the transaction committed; handlers run as the user who caused them, under their rules |
| Front end | OWL (proprietary), XML views, patches on prototypes | React 19, TanStack, Radix, Tailwind; views as typed data extended by anchors with recorded origins; light / dark, RTL by construction, i18n with ICU; axe-checked |
| API contract | JSON-RPC `call_kw`, no OpenAPI, no versioning | REST with RFC 9457 problems, OpenAPI 3.1 generated from the registry, a typed client generated and checked in CI, idempotency keys on unsafe calls |

## At parity today

- List, kanban, form, calendar, gantt, map, hierarchy, cohort, graph, pivot, dashboard and spreadsheet views, with
  one shared search layer (filters, group-by, favorites, saved and shared searches) across all of them.
- Multi-company with per-company currency rounding; audit trail per record (Shutro); scheduled reports by cadence.
- Module system with manifests, dependencies, access levels, menus, actions, default data (policies, templates).

## Odoo is still ahead

- **Breadth of business apps**: Kosh has the framework and demo modules; Odoo has accounting, inventory, HR, CRM,
  manufacturing, e-commerce, point of sale, localizations, and thousands of community modules.
- **Chatter, messaging, email, notifications** (RFC 0006): not built yet.
- **Attachments and documents on records**, a file store, OCR, digital signatures.
- **Spreadsheet** depth (Odoo Enterprise: pivot insertion, charts, collaborative editing). Kosh's is formulas and
  live report totals.
- **Reporting** extras: Odoo's accounting reports, cash flow, aged balances are app-level work.
- **Mobile apps**, offline, PWA; barcode scanning.
- **Ecosystem**: partners, hosting (odoo.sh), marketplace, certifications, documentation volume.
- **Materialized aggregates** for dashboards (Kosh dashboards are live queries, client-cached briefly).

## What makes the "more flexible" claim true in practice

- Every screen is data: a module changes another module's view by anchor without forking it, and the server records
  who changed what (`resolveView` chain).
- Every renderer, widget and node component is registered by name and replaceable; a view can be replaced by a React
  component when metadata is not enough.
- Conditions are domains, evaluated in SQL on the server and (where possible) in the browser, never strings in a
  mini-language.
- The framework never reimplements the ORM: when Kosh needed something (grouping sets, runtime field security,
  cache release, binary batches), Shutro gained it with tests, and `docs/shutro-requests.md` records every request.

## Next

RFC 0006 (chatter, realtime, notifications, chat, inbound email) and the demo apps with feedback and benchmarks
close most of the "Odoo is still ahead" rows that are framework work; the business apps are a separate roadmap.
