# RFC 0005: Reporting engine

- **Status:** Accepted (2026-10-18), implemented in `@kosh/reporting` (docs/reporting.md, docs/benchmarks.md)
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

## Alignment with CLAUDE.md

- Budgets: CLAUDE.md sets "10k-row list view < 300 ms API time" as the example; the reporting budgets above are
  proposed additions to the CLAUDE.md budget list, for approval.
- The `GROUPING SETS` support needed from Shutro's `aggregate()` is recorded in `docs/shutro-requests.md`.

## Implementation notes (2026-10-19)

- Shutro gained `aggregate({ groupingSets | rollup | cube })` with `$groups` per row (`8a79c43`), `env.releaseCache()`
  for streamed exports (`06f63c7`), and a fix for binary values in batch writes (`0b8e5ba`).
- The report query issues one statement per pivot (two with a comparison): the leaf grouping in SQL, subtotals and
  totals rolled up on the server with exact arithmetic. Shutro's `groupingSets` gives the same result in one
  statement, but PostgreSQL keeps one hash table per set and cannot parallelize them: on 1M rows the eight sets of a
  3 × 1 pivot cost ~1.2 s against 0.49 s end to end for the leaf grouping plus a 36 000-cell rollup (`pnpm bench`). Headers
  carry drill-down domains, so "open the records" is a search, in list views, charts, cohorts and dashboard cards
  alike.
- XLSX is written by Kosh (`node:zlib`), not a library: typed cells, money and date formats, frozen headers.
- Documents: layouts (JSON blocks) compiled to HTML with CSS paged media and printed by Playwright's Chromium; the
  designer edits the same JSON with a live preview; manifests ship default templates. Attachments (storing the PDF
  on the record's chatter) come with RFC 0006.
- Scheduled reports run on Shutro jobs behind a one-method `JobQueue` interface (the pg-boss decision of RFC 0006
  stays open); outputs are `report.output` records; delivery adapters are the hook for RFC 0006's channels.
- Materialized aggregates for dashboards (open question 7) are not built: dashboards are live queries, cached per
  query by the client for 15 s.
- Budgets measured by `pnpm bench` (1M rows, CI on `main`): see docs/benchmarks.md.
