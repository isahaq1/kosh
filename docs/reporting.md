# Reporting

Every analytical view runs on one server-side **report query** built on Shutro's `aggregate()`,
under the caller's record rules and field security (RFC 0005). Documents are layouts printed to PDF by Playwright;
exports and scheduled reports run on the server. Nothing here bypasses permissions: a report is a read like any
other.

## The report query

`POST /api/v1/models/:model/report`

```json
{
  "rows": ["vendor", "state"],
  "cols": ["dateOrder:month"],
  "measures": { "orders": "count", "total": { "sum": "amountTotal" } },
  "where": { "state": { "in": ["approved", "done"] } },
  "comparison": { "field": "dateOrder", "from": "2026-01-01", "to": "2026-10-01", "mode": "yoy" },
  "asOf": "2026-09-30T23:59:59Z"
}
```

- **One statement** per pivot: the leaf grouping (every row group × every column group) is aggregated in SQL, and
  every subtotal and total is rolled up from the leaves on the server with exact arithmetic (decimal strings, amounts
  per currency, averages weighted by count). That is the result `GROUPING SETS` would give, with one hash table and
  parallel aggregation in PostgreSQL instead of one table per level; a pivot expands and collapses without another
  query. The response is two header trees (labels, depth, and the **drill-down domain** of each header) and
  `cells[rowKey][colKey][measure]`.
- Dates group by `day`, `week`, `month`, `quarter`, `year`; header domains are ranges (datetimes in the user's time
  zone), so "open the records" of any cell is a plain search.
- Monetary measures stay **per currency** at every level (`[{ amount, currency }]`); counts and decimals combine
  exactly across the currency rows of a cell (averages weighted by count).
- `comparison`: the previous period of the same length, or the same period a year earlier; the comparison cells are
  aligned onto the current period's buckets. `asOf` reads models with history as they were at that instant.
- Field security applies to every group and measure (a restricted field is `403`); the selection labels and display
  names of many2one headers are resolved within the caller's access.

Views (RFC 0004 builders in `@kosh/views`): `pivot`, `graph`, `calendar`, `gantt`, `map`, `hierarchy`, `cohort`,
`spreadsheet`, `dashboard`. They are validated against the models when the server starts and served per user; the
renderers are in `@kosh/reporting/web` (`registerReportingWeb(registry)`), with ECharts and MapLibre loaded on demand.

## Exports

| Route | |
|---|---|
| `POST /api/v1/models/:model/export { fields?, filter?, order?, format: csv\|json }` | lists; CSV **streams** (keyset pages in one transaction, cache released per page, up to 10M rows) |
| `POST /api/v1/models/:model/export/xlsx { fields?, filter?, limit? }` | a list as a formatted workbook (names for many2one, dates, money formats) |
| `POST /api/v1/models/:model/report/export { ...report query, format: xlsx\|csv, title? }` | a pivot as a workbook (indented levels, totals, money formats) or CSV |

All need the `export` permission (RFC 0003) and write a `data.export` audit event. CSV cells that look like formulas
are neutralized. The XLSX writer is Shutro ERP's own (`node:zlib`), no dependency.

## Documents

A template is a **layout**: blocks bound to fields (`heading`, `text` with `{{partner.name}}`, `field`, `fields`,
`table` over a one2many or `$records` for list documents, `columns`, `divider`, `pageBreak`, `signature`), with
header, footer (`{{page}}`, `{{pages}}`, `{{now}}`), paper and orientation. Modules ship defaults in their manifest
(`documents: [{ key, name, model, layout, scope? }]`, installed as `report.template` records by `installTemplates`);
report designers edit them in the **designer** (drag-and-drop blocks, live preview of a real record, bindings
validated on save) or create new ones.

- `GET /api/v1/models/:model/documents` lists templates; `POST /api/v1/models/:model/documents/:template { ids }`
  (or `{ filter }` for list templates) returns the PDF; `?format=html` returns the HTML (previews); designers may
  pass an unsaved `layout`. Several ids print as one document with page breaks.
- The record and its related rows are read **as the caller**; values are formatted for the document's language
  (Money, dates, selection labels); tables can total a column. Every render is audited (`document.rendered`).
- The `reporting.Documents` component gives any form a *Print* menu: add
  `{ kind: 'component', id: 'documents', component: 'reporting.Documents' }` to the view (or by extension).
- Rendering: the HTML (CSS paged media) is printed by Playwright's Chromium, one shared browser per process,
  launched on first use and closed with the server.

## Scheduled reports

`report.schedule` records (Reports → Scheduled reports): a pivot query, a list, or a document template over a search;
`xlsx`, `csv` or `pdf`; daily / weekly (weekday) / monthly (day of month) at an hour in the owner's time zone;
recipients. The engine:

- plans `nextRunAt` from the cadence (on save; a changed cadence is replanned);
- a ticker (every minute, any instance) enqueues due schedules as **Shutro jobs**, keyed per due time, so two
  instances never enqueue the same run;
- the job renders **as the owner** (their rules and field security), stores a `report.output` (the file as a binary
  field) visible to the owner and recipients, records `lastRunAt` / `lastError`, and hands the output to the
  **delivery adapters** (`engineOf(app).use({ name, deliver })`: the notification channels of RFC 0006 plug in here);
- `POST /api/v1/reports/schedules/:id/run` runs one now as the caller; outputs download from
  `GET /api/v1/reports/outputs/:id/download`. `SHUTRO_ERP_SCHEDULES=off` disables the ticker (tests, one-off scripts).

The queue is behind a one-method `JobQueue` interface in `schedules.ts`: switching to another backend touches that
file only (the Shutro-jobs-vs-pg-boss decision of RFC 0006 is still open).

## Dashboards and spreadsheets

Both are records (`report.dashboard`, `report.spreadsheet`), private or shared, governed by record rules, under the
Reports app. Dashboards are a grid of cards (KPI with change against the previous period or last year, chart, small
pivot, top records), each a live report query, arranged by drag-and-drop without code. Spreadsheets are cells with
values and formulas (`SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `IF`, `ROUND`, `ABS`, references and ranges) plus
`REPORT("model", "sum:field", "domain json")`, a live report total within the viewer's rules.

## Budgets

`pnpm bench` seeds 1 000 000 orders in a PostgreSQL 18 container and measures API time through the real server:
a pivot of 3 row levels × 12 month columns in under 1 s, the first bytes of a 1M-row CSV export in under 500 ms,
and list pages of 1 000 rows with the total count in under 300 ms. CI runs it on `main`. Results: `docs/benchmarks.md`.
