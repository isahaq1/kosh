# Benchmarks

`pnpm bench` (`packages/reporting/bench`, CI job `bench` on `main`) seeds 1 000 000 orders (50 partners, 20 users,
3 states, dates across 2026) into PostgreSQL 18 in a Testcontainers container and measures **API time through the
real server** (Fastify `inject` for JSON routes, HTTP for the streamed export). Budgets are asserted; the run fails
when one is missed.

## 2026-10-19 — developer laptop (Windows 11, Docker Desktop / WSL2, PostgreSQL 18.6)

| Measure | Budget (CLAUDE.md / RFC 0005) | Result |
|---|---|---|
| Pivot over 1M rows: 3 row levels (partner × state × user) × 12 month columns, count and sum, one statement | < 1 000 ms | **492 ms** |
| CSV export of 1M rows: first bytes | < 500 ms | **31 ms** |
| CSV export of 1M rows: whole file (29.9 MB, 1M lines) | — | 7.5 s |
| List page of 1 000 rows with the total count over 1M | < 300 ms | **115 ms** |
| 10 000 rows as 10 pages: worst page | < 300 ms | **112 ms** |
| Seeding 1M rows (`INSERT … generate_series`) | — | 8.6 s |

For the record, the same pivot as `GROUPING SETS` (8 sets, one per level) measured 1.17 s as raw SQL with text
buckets, 1.21 s with date buckets, and 1.29 s through the ORM: PostgreSQL keeps one hash table per set and cannot
parallelize mixed grouping sets, which is why the report query aggregates the leaf grouping only and rolls the
levels up on the server (exact arithmetic; identical results).

Numbers vary with the machine; a CI runner is slower than a laptop. The point of the table is the order of
magnitude and that the budgets hold with headroom.
