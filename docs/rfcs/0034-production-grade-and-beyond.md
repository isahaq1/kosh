# RFC 0034 — Production-grade, and past Odoo where it counts

- Status: **Accepted** (2026-11-16)
- Builds on: every RFC so far; replaces the "proposed order" of `docs/odoo-gaps/README.md`
- Why now: Kosh is deeper than Odoo in places (see the comparison of 2026-11-16) but unproven. Adding modules will
  not close the gap that matters most, which is trust. This RFC makes Kosh **provably reliable first**, then makes
  the move from Odoo **safe and verifiable**, then closes the gaps every app hits — each one designed to go past
  what Odoo offers, not to copy it.

## 1. The rule for this phase

Every item must do one of three things better than Odoo can show today:

1. **Prove** — the claim is checked by a machine, not asserted (a restore that is rehearsed, a migration whose
   books balance, an adapter tested against the real provider).
2. **Remove a reason not to switch** — what keeps a company on Odoo or spreadsheets.
3. **Do in the core what Odoo leaves to Enterprise or to third parties** — and do it as data, not code.

## 2. What changes, and how it goes past Odoo

### 2.1 Reliability that is measured (first: cheap, and everything else stands on it)

| Today | After |
|---|---|
| One database for every E2E file; specs that pass alone and fail in a full run; integration files timing out under load | **A database per test worker**, cloned from a migrated template in under a second (`CREATE DATABASE … TEMPLATE`), so files cannot see each other's data and run in parallel |
| Fixed waits and order-dependent specs | Waits on state only (the record, the URL, the network), never on time; a spec that depends on another fails the linter |
| A flaky test is rerun by hand | **Quarantine with a ledger**: a test that fails then passes on rerun is reported by name and counted; three strikes and it blocks the build until fixed |
| The full gate runs when someone runs it | **CI on every push**: typecheck, lint, the unit and integration suite, the E2E sweep of every menu; the full E2E nightly; performance budgets (the 10k-row list under 300 ms) fail the build |

*Past Odoo:* Odoo's own runbot is internal; a company running it cannot see whether its modules pass. Kosh ships
the gate with the product: `shutro-erp check` runs the same suite against an installation's own modules.

### 2.2 Production readiness built in

- **`shutro-erp doctor`** — one command that checks a running installation and says what to fix: database version
  and settings, migrations applied, backups recent and restorable, storage reachable, mail and SMS configured,
  certificates, clock skew, slow queries, queue backlog, failing webhooks.
- **Backups that are rehearsed, not hoped for** — point-in-time recovery set up by `shutro-erp init`, and
  `shutro-erp backup verify` restoring the latest backup into a scratch database and checking it (row counts, the
  trial balance, stock values) — on a schedule, with the result on the admin's home page.
- **An adapter certification kit** — each payment, courier, SMS and e-invoicing adapter has a contract suite run
  against the provider's real sandbox (credentials from the environment), recording the exchanges; CI replays the
  recordings so a provider's change is caught without hitting it. An adapter is marked *certified* with the date of
  its last sandbox run, shown in Settings.
- **Observability on by default** — OpenTelemetry traces and metrics, structured logs with the request id shown in
  every error the user sees ("quote this id"), and a health page per installation.
- **The pilot playbook** — what a first real company needs: the checklist, the data to load, the parallel-run
  plan with the importer (2.3), the success measures (orders and invoices processed, time per task, errors), and a
  weekly review. Kosh runs it with one company before any claim of being better than Odoo is made.

*Past Odoo:* Odoo.sh offers hosted backups; an on-premise Odoo has no doctor, no rehearsed restore and no
certification of its connectors.

### 2.3 Leave Odoo safely: migrate, run in parallel, prove, cut over

1. **Connect** to a live Odoo (its JSON-RPC API with a read-only user) or to a database dump. No module needs to be
   installed in Odoo.
2. **Map** automatically: Odoo's models and fields are matched to Kosh's from both sides' metadata (partners,
   products and variants, taxes, chart of accounts, journals, open invoices and bills with their payments, stock by
   location and lot, open orders, employees, projects); what does not match is listed for a person to map once, and
   the mapping is saved.
3. **Dry run** into a scratch company with a **reconciliation report**: the trial balance before equals after, open
   receivables and payables per partner match, stock quantity and value per product and location match, every
   record has its Odoo id kept. Any difference is a line in the report with the records behind it.
4. **Run in parallel**: an incremental sync keeps Kosh up to date with Odoo for as long as the company wants
   (new and changed records since the last run), so people can work in Kosh while Odoo stays the book of record.
5. **Cut over** on a date: the last sync, the final reconciliation, Odoo read-only. Rollback is possible until the
   first posting in Kosh.

Spreadsheets get the same report through the existing import (RFC 0014). *Past Odoo:* Odoo offers its own data
import per list; it has no verified migration from another system, no parallel run and no reconciliation proof.

### 2.4 Platform gaps every app hits

- **Rich text** for `html` fields and the chatter: headings, lists, tables, images from storage, `@mentions` and
  links to records that open in the peek panel, paste from Word and Google Docs cleaned, output sanitised on the
  server. *(One new dependency — an editor on ProseMirror — justified in the step's notes; nothing else in the stack
  edits rich text.)*
- **Accounts and sign-in**: password reset by email with a single-use, short-lived link, rate limited and audited;
  **single sign-on** with OpenID Connect (Google, Microsoft, Keycloak, any OIDC provider) mapping groups to roles;
  **SCIM provisioning** so people and their roles follow the company directory; **passkeys** beside TOTP. *Past
  Odoo:* SCIM and passkeys are not in Odoo; OIDC is a community add-on.
- **Working calendars, one model for everything that counts time**: weekdays, hours, breaks, public holidays per
  country and company (Bangladesh and India shipped), and per-person exceptions. Used by leave (holidays not
  charged), Helpdesk SLAs, Attendance, Production capacity, payment terms in working days and delivery dates.
- **Recurring events** (RRULE: every second Tuesday, the last working day of the month — through the calendars)
  with **ICS invitations** that land in any mail client, and **two-way Google and Microsoft calendar sync**.

### 2.5 The money gaps, as data

- **Subscriptions and recurring invoices**: plans with periods, prices from price lists, trials, proration on
  upgrade and downgrade, pause and resume, usage-based lines fed by any model (Counter sales, timesheets, a meter);
  failed payments through the existing follow-ups (RFC 0029); **MRR, churn and cohort retention** on the overview,
  computed by the pivot engine. *Past Odoo:* subscriptions are Enterprise-only there.
- **Timesheet billing and project profit**: rate cards by person, role and task type; billable hours approved
  before invoicing; fixed-price milestones beside time and materials; **work in progress and revenue recognition**
  posted to Accounting; profit per project and per phase from timesheets, purchases, expenses and production
  (RFCs 0026, 0031). *Past Odoo:* project profitability without revenue recognition.
- **Leave accruals as rules**, in the same safe formula language as Payroll (RFC 0024): accrue per month or per
  day worked, caps, carry-over and expiry, probation, encashment paid through Payroll (the Bangladesh rules
  included), balances projected to any date. *Past Odoo:* accrual plans exist, but not as formulas and not wired to
  local payroll.

### 2.6 Customer-facing, each on one shared engine

- **Careers page** on Sites from Hiring's openings, an application form with the CV parsed by the assistant
  (RFC 0013, as a proposal the recruiter confirms), and candidate emails at each stage.
- **Surveys and forms** — one engine: questions, logic, scoring, anonymous or named. Used by Hiring (screening),
  Event Hub (feedback), Helpdesk (the rating becomes CSAT and NPS), Pipeline (qualification).
- **Loyalty** — one engine for Shop, Counter and Sales: points, tiers, wallets, gift cards, promotions and "buy X get
  Y", each rule previewed on past orders before it goes live (what it would have cost last month).
- **Live chat** on Sites routing into Helpdesk or Pipeline by rules, with the assistant answering from published
  pages and handing over to a person, and the conversation kept on the ticket or the deal.

## 3. What this RFC needs from you

- **A pilot company** (2.2) — a real one, with a person who will use Kosh daily for a month.
- **Sandbox credentials** for SSLCommerz, bKash, Razorpay, Stripe, India's IRP, and the couriers you use (2.2) —
  kept in the environment, never in the repository.
- **An Odoo instance or dump** to migrate from in testing (2.3) — a copy, never production.
- **Approval of the rich-text editor dependency** (2.4).

## 4. Steps

1. **Reliability**: a database per worker, state-only waits, the quarantine ledger, CI on every push with the
   sweep, nightly full E2E, performance budgets in CI.
2. **Readiness**: `shutro-erp doctor`, rehearsed backups with `backup verify`, observability by default, the
   adapter certification kit (run on sandboxes as credentials arrive), the pilot playbook.
3. **The Odoo importer**: connect, map, dry run with the reconciliation report (partners, products, taxes, chart,
   open invoices and bills, stock).
4. **Parallel run and cut-over**: incremental sync, the final reconciliation, rollback until the first posting.
5. **Accounts and sign-in**: password reset, OIDC, SCIM, passkeys.
6. **Working calendars and recurring events**, ICS, Google and Microsoft sync.
7. **Rich text** in fields and the chatter.
8. **Subscriptions and recurring invoices**, with MRR and churn.
9. **Timesheet billing, revenue recognition and project profit.**
10. **Leave accruals as rules**, encashment through Payroll.
11. **Surveys** (first, as Hiring, Events and Helpdesk use them), then the **careers page**.
12. **Loyalty**, then **live chat**.

Each step: an RFC section of its own where it needs one, typed end to end, unit and integration tests on real
PostgreSQL, an E2E for the flow, permission tests, English and Bangla, light and dark, desktop and phone, docs.

## 5. Open questions

1. Is the order right — reliability and readiness before any new feature? (Proposed: yes; a month at most.)
2. Which company runs the pilot, and from which system — Odoo, spreadsheets or something else? It decides whether
   step 3 or the spreadsheet path comes first.
3. Two-way calendar sync needs Google and Microsoft app registrations under your organisation. Proceed with ICS
   only until then?

## Implementation notes

- **Step 1, part 1 (2026-11-16).** Integration tests: **one PostgreSQL server per run** (Vitest global setup
  `packages/server/test/support/postgres.global.ts`, fsync off, 400 connections; or `KOSH_TEST_DATABASE_URL`) and
  **a database per test file** (`testDatabase()` in the new `@kosh/server/testing` entry point, dropped with
  `WITH (FORCE)`), replacing 111 containers. Measured on the development machine: before, 11 and then 10 files
  failed per full run with `CONNECT_TIMEOUT`; an instrumented run showed the cause is **CPU starvation of the test
  workers**, not the database (at most 26 connections open, CPU at 90–100 %). After: 174 / 174 files and 857 / 857
  tests passed with none retried. **The flaky ledger** (`scripts/flaky-reporter.ts`, `retry: 1`): tests passing
  only on retry are named and counted in `.flaky-ledger.json`, kept between CI runs by the cache; three strikes fail
  the run (checked with a probe test: strikes 1, 2, then a failed run). Two test races fixed (the IMAP poller
  polling before the mailbox had the mail; the Studio upgrade test's timeout). CI runs the full `pnpm lint`
  (model views and the module standard too); the benchmarks' budgets already fail the main branch's build. E2E
  servers are never reused (`reuseExistingServer: false`), so a leftover server from an interrupted run stops the
  next one with a clear error instead of sharing its database. Not done in this part: E2E with a database per
  worker (the two E2E projects run one worker each against their own server), state-only waits enforced by a lint
  rule, `shutro-erp check` for a company's own modules.
- **Step 1, part 2 (2026-11-16).** **`shutro-erp check`**: the module standard extracted into a function
  (`packages/cli/src/standard.ts`, the repository's lint giving a line-for-line identical report before and after)
  and run on a company's own modules (`src/modules/*/index.ts`, from `module create` or Studio), with the installed
  set only to resolve dependencies; T1 (Bangla) and A1 (overview, demo data) reported, failing with `--strict`;
  fixtures and tests for a passing and a failing project. The RFC's wording "runs the same suite" is narrowed on
  purpose: Kosh's own tests do not ship in the package, so a company runs the standard with `check` and its own
  tests with `shutro-erp/testing` (published from `@kosh/server/testing`). **No fixed waits in E2E specs**,
  enforced by `pnpm lint` (none existed; a probe spec is refused). **Not done, on purpose: E2E with a database per
  worker.** The flakes it was meant to cure came from leftover servers (now refused) and the spec of a form saved
  before its defaults (fixed in RFC 0033 step 1); running E2E in parallel needs a seeded server per worker, minutes
  of start-up each, for a run of 11–20 minutes today. It is worth doing when the suite's length hurts, not before.
  Not checked yet: whether a module freshly scaffolded by `module create` passes `check` (its index imports
  `shutro-erp/…`, which resolves only in a real project).

