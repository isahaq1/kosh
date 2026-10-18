# RFC 0005: Reporting engine

- **Status:** Draft (for review)
- **Depends on:** 0002, 0003, 0004; Shutro RFC 0016 (aggregate), 0018 (jobs, history)

## 1. Summary

All analytical views (pivot, chart, calendar, gantt, map, hierarchy, cohort, spreadsheet, dashboard) run on one
server-side **report query** built on Shutro's `aggregate()`, extended with grouping sets, period comparison and
drill-down domains, under the same record rules and field security as every other read. Documents (PDF) are HTML
templates rendered by Playwright; exports and scheduled reports run as Shutro jobs.

## 2. Problem

Managers need pivots over millions of rows in seconds, comparisons with last period, drill-down to the records,
formatted exports and scheduled mailings — all without seeing data their roles hide.

## 3. How Odoo does it, and its weaknesses

`read_group` (lazy, one level at a time) feeds pivot and graph views; QWeb templates rendered to PDF by
wkhtmltopdf; spreadsheets in Enterprise; exports via `export_data`.

- **One level per request:** expanding a pivot issues a `read_group` per header; totals are recomputed client-side.
- **No grouping sets:** subtotals and grand totals are separate queries; large pivots are slow.
- **Monetary sums across currencies** unless grouped by currency.
- **wkhtmltopdf** is unmaintained, with poor CSS support; report layouts are XML.
- **Exports** bypass some field restrictions and load everything into memory.

## 4. Options

| | A. Shutro aggregate + GROUPING SETS (one query per pivot) | B. Separate OLAP store (ClickHouse, cube) | C. Client-side pivot over raw rows |
| --- | --- | --- | --- |
| Security | Shutro rules/field groups in SQL | Must be re-implemented and synced | Rows leave the server |
| Freshness | Live | Replication lag | Live |
| Scale | Millions with indexes and partitions | Billions | Thousands |
| Ops cost | None | High | None |

## 5. Recommendation: A (with B as a later optional backend for very large tenants)

- **Report query** (`POST /api/v1/{model}/report`): rows and columns group-bys, measures, the search-layer domain,
  `comparison: { period: 'previous' | 'yoy', field: 'dateOrder' }`, and the set of expanded headers. The server
  issues **one** `GROUP BY GROUPING SETS (…)` statement for every visible level and total (`ROLLUP` for hierarchies,
  `CUBE` when asked), returning a tree with totals. This needs a Shutro amendment: `aggregate({ groupingSets })`
  returning the grouping level per row (`GROUPING()`), keeping per-currency Money semantics.
- **Drill-down**: every cell carries the domain that produced it (`{ partner: 7, 'dateOrder:month': '2026-09' }` →
  a domain on stored fields), so "open records" is a search with that domain.
- **Views** (`packages/reporting`, renderers in `apps/web`): pivot (expand/collapse, sorting, heatmap), chart
  (ECharts), calendar, gantt/timeline, map (MapLibre), hierarchy (Shutro `childOf`), cohort, spreadsheet (formulas over
  report queries), dashboards (saved queries + layout). All share the search layer (RFC 0004).
- **History**: `asOf` (Shutro `env.asOf`) answers "as reported at period close" for models with history.
- **Exports**: CSV and XLSX streamed from keyset-paginated queries (formats from field kinds: Money with currency,
  dates in the user's tz), PDF via the document renderer; `export` permission required (RFC 0003), field security
  applied, export events audited.
- **Documents**: templates are React/HTML components rendered server-side and printed with Playwright (CSS paged
  media); a drag-and-drop designer edits a layout JSON (blocks bound to fields, tables bound to x2many) that compiles to
  the same template format.
- **Scheduled reports**: `env.enqueue('report.send', …, { runAt, key })` from a schedule record; the job renders as
  the schedule owner (their rules) and sends through the notification system (RFC 0006).
- **Budgets** (to align with CLAUDE.md once available): pivot over 1M order lines with 3 row levels and 12 month
  columns in under 1 s on indexed data; first CSV row of a 1M-row export in under 500 ms.

## 6. Purchase with approvals

"Spend by supplier and month, this year vs last year, approved orders only", expanded two levels: one grouping-sets
query; clicking the Dhaka/September cell opens the 37 orders behind it; "Approval lead time by approver" is a cohort
of `approval.request` (requested → decided); the PDF purchase order prints the approval trail; the finance director
receives the monthly spend pivot as XLSX every 1st at 08:00.

## 7. Open questions

- Materialized aggregates for dashboards (refreshed by jobs) vs always-live queries: proposed live first, opt-in
  materialization per dashboard.
