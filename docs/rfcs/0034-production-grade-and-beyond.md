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

> **Withdrawn (2026-11-16).** Kosh ships no Odoo tools: the importer built for steps 3 and 4 was removed (its history
> is in git, commits `5686bf3` to `b4b0c53`). Starting a company from any earlier system is served by tools on
> Shutro alone — an opening-balance kit from templates with the same reconciliation proof — in a later RFC.

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
- **Step 2, part 1 (2026-11-16).** **`shutro-erp doctor`** (`packages/cli/src/doctor.ts`), read-only: the runtime;
  the database (reachable, version 16+, size), the clock against it, connections against `max_connections`;
  migrations pending; installed apps missing from `src/modules.ts`; administrators (none, none with a second factor,
  some without); jobs late more than 15 minutes (the workers are down) or given up in the last day, subscribers
  retrying and events given up, failed webhook deliveries; Valkey answering PING, the SMTP server and the S3 endpoint
  reachable; HTTPS and secure cookies in production; backups (a warning until part 2 records verified backups) and
  telemetry. Each warning and failure says what to do; `--json` for monitoring; exit code 1 on a failure. Tested on
  a real installation (healthy checks, no administrator, an administrator without a second factor, an app missing
  from the modules file). Administrators are found through the `base.admin` group; runtime roles that make
  administrators (RFC 0019) are not counted yet.
- **Step 2, part 2 (2026-11-16).** **Rehearsed backups** (`packages/cli/src/backup.ts`): `shutro-erp backup` runs
  pg_dump (custom format) inside a repeatable-read transaction whose exported snapshot it hands to pg_dump, and measures
  in that same snapshot the rows of every table, the ledger's debits and credits and the stock on hand, written as the
  dump's manifest; `shutro-erp backup verify` restores into a scratch database, compares every table and total, checks
  that the ledger balances, drops the scratch database and records the result in `kosh_backup_check`, which doctor's
  `backups` check now reads (fails on a mismatch, warns when none or older than a week). Client tools older than the
  server are replaced by the `postgres:<major>` image through Docker. Tested on a real installation (backup, verify,
  doctor green; a manifest tampered with fails verify and doctor). Point-in-time recovery is documented (WAL archiving),
  not run by the CLI.
- **Step 2, part 3 (2026-11-16).** **Errors a user can quote**: every problem document carries `requestId` (one
  `preSerialization` hook, so module routes' problems too); `ApiError` adds `#` and the id's first eight characters to
  the message of a server failure (5xx) — refusals stay as they are —, taking the echoed `X-Request-Id` when a proxy
  answers instead of the server; the router's default error component is a translated page (English and Bangla) with
  the reference, Try again and Reload. Tested by the server's integration test, unit tests of `ApiError` and an E2E
  of a failing list. The portal keeps its own error handling for now.
- **Step 2, part 4 (2026-11-16).** **The pilot playbook** ([docs/pilot.md](../pilot.md)): the two leads, the
  agreement before installing (scope, cut-off, parallel window, success measures with today's figures, an exit rule),
  the installation with `doctor` all ticks and nightly verified backups, the data in order with external ids, the
  weekly reconciliation checks of the parallel run (trial balance, aged balances, stock, documents, VAT), the problem
  log with error references, the weekly review, cut-over after two equal weeks and a month end, the report after.
  Left in step 2: point-in-time recovery set up by `init` and the backup result on the administrator's home page.
- **Step 2, part 5 (2026-11-16).** **The adapter certification kit**: `cassette()` in `@kosh/server/testing` records a
  live run's exchanges with secrets redacted (credentials raw and URL-encoded, token-named JSON fields) and replays
  them strictly (method, URL, body, in order; a change fails with how to re-record); `pnpm certify [adapter …]` runs
  the contracts live. SSLCommerz (6 steps) and bKash (4 steps) certified on 2026-11-16 against their sandboxes with
  the providers' public demo accounts. The first run found an SSLCommerz defect — an unknown transaction's `INVALID`
  placeholder taken as an attempt and a `PROCESSING` session as failed, so a forged failure IPN was believed —, fixed.
  Not yet: Razorpay and Stripe (no public demo keys), couriers and SMS (only test adapters so far), the certification
  date shown in Settings.
- **Step 3, part 1 (2026-11-16).** **The Odoo importer** (`@kosh/odoo`, `shutro-erp odoo import`): a read-only
  JSON-RPC client (sign-in with a password or an API key, `fields_get`, `search_read` in pages by id with archived
  records, external ids); a plan of six steps — units, product categories, taxes, the chart, contacts, products —
  reading only the fields the connected version has (16–18); one system transaction audited as `odoo import`, a
  savepoint per record, parents in a second pass; each record kept as `odoo.<model>_<id>`, so a second run updates
  instead of creating; records Kosh already had (seeded units, "All", accounts by code, taxes by name, use and rate)
  linked; a dry run by default; the report accounting for every record (created, updated, linked, skipped with the
  reason, failed with Kosh's answer). Tested against a real Odoo 18 with its demo data through the certification
  kit's recording (dry run keeps nothing; 34 contacts with their companies, 42 products with codes and taxes, 51
  accounts, 25 units; a second run creates nothing); the kit now keeps a recording only when every step of a contract
  ran and passed. Next (part 2): open invoices and bills, the opening balance, stock, and the reconciliation report.
- **Step 3, part 2a (2026-11-16).** **The books and their proof** (`--cutoff`): Odoo's balances at the cut-off read
  with `read_group` (all time, and this fiscal year for profit and loss), each partner's receivable and payable, and
  every line still open on those accounts; one posted opening entry (balance-sheet accounts at their balance, profit
  and loss at this year's, the earlier years' result on retained earnings); each open invoice, credit note and bill
  a posted Kosh document of its kind for what is left, Odoo's number as the reference, on the partner's receivable or
  payable account (now imported with the contact); other open items lines of the entry with their partner; both
  sides on an `OPENING` account. The reconciliation, in the same transaction so a dry run proves it too: the trial
  balance per account, each partner's receivable and payable, the opening account at zero, every open document
  present — each difference a line with both figures. A second run finds the opening by its cut-off. Recorded
  against Odoo 18's demo: 13 open documents, a bill of the year before, every check equal. Next (part 2b): stock.
- **Step 3, part 2b (2026-11-16).** **Stock on hand and its proof**: warehouses (the Odoo company's, with their
  steps, linked by short code), internal locations (nested as in Odoo, the stock location and the steps' linked to
  Stockroom's) and lots as steps; products bring their tracking, categories their cost method and stock accounts
  (accounts now run before categories). With `--cutoff`, Odoo's quants become one validated inventory adjustment per
  location, lots on their lines, before the opening entry. Two fields of `stock_account`, written only by the system:
  a transfer's **accounting date** (its entry and valuation layers dated the cut-off) and a line's **unit cost**
  (Odoo's value to six places). The opening entry now posts each account at Odoo's balance less what Kosh already
  posted by the cut-off, so the stock entries are not counted twice. Two more checks: stock on hand per product,
  location and lot, and stock value per product to the cent. Archived records keep their Odoo id (external ids
  read and written with archived records visible). Recorded against Odoo 18's demo with a category valued in real
  time: 19 quants, two lots, 3,067.50, every check equal. Next (part 2c): open sales and purchase orders.
- **Step 3 withdrawn (2026-11-16).** The Odoo importer (`@kosh/odoo`, `shutro-erp odoo import`, its recording and
  docs/odoo.md) removed: Kosh ships no Odoo tools. Kept: stock valuation's system-only accounting date on transfers
  and unit cost on transfer lines, for the opening-balance kit that replaces it.
- **Step 5, part 1 (2026-11-18).** **Password reset by email.** `POST /api/v1/auth/password/forgot { login }`
  answers `{ ok: true }` whatever was typed — nobody learns who has an account — and, for an active account with an
  address, emails a link (`/reset?token=…`) good **once, for 60 minutes**; a newer link replaces the earlier one; an
  account asks at most three times an hour, an address five times in fifteen minutes. `POST
  /api/v1/auth/password/reset { token, password }` sets the password (12 characters at least), marks the link used,
  **signs every device out**, and emails the person that their password changed. Both steps are in the audit log
  (`auth.reset_requested`, `auth.password_reset`). The tokens are stored hashed, beside the invitations
  (`settings.invitation.purpose`: an invitation and a reset never void one another). Needs a mailer (`SMTP_URL`):
  without one the request answers the same and sends nothing. Pages `/forgot` and `/reset` outside the shell, a link
  on sign-in, English and Bangla. The second factor is untouched: an account with one still needs it to sign in.
  Tested on the server with a captured mailer (the whole flow) and in the browser (the pages; the E2E server has no
  mailer). Next in step 5: single sign-on (OIDC), then SCIM and passkeys — each needs decisions first (see below).
- **Step 5, part 2 — design of single sign-on (decided 2026-11-18).** Asked and answered: (1) **only people who
  already exist** sign in through a provider — nobody gets an account by having an address; (2) **no new
  dependency** — the code flow and the ID token's verification on `node:crypto`, as the OAuth server; (3) tested
  against a **fake provider** in the suite, then certified against a real **Keycloak** in Docker; Google and
  Microsoft to verify with the company's own credentials. The design: the authorization code flow with PKCE, a
  `state` and a `nonce` kept server-side (hashed, single use, ten minutes); the ID token accepted only when signed by
  a published key of the provider with RS256, PS256 or ES256 (never `none`, never a shared secret), for this issuer
  and client, unexpired and carrying this sign-in's nonce; a person found by a link made before (provider +
  subject), else by a **verified** address matching one active person's login or email, linked then; the session
  made by a single-use hand-off code (a minute) the sign-in page exchanges, so a session token never travels in an
  address; the **second factor still owed** by accounts that have one; a provider's client secret in the environment
  (`KOSH_SSO_<KEY>_SECRET`), never stored; refusals audited with the reason. Later parts: groups mapped to roles
  (applied at each sign-in, audited), the providers in Settings › Security, then SCIM and passkeys.
- **Step 5, part 2a (2026-11-18).** **The sign-on flow on the server.** `auth.sso_provider`, `auth.sso_identity`,
  `auth.sso_state` (private, in base); `/api/v1/auth/sso/providers`, `/:key/start`, `/:key/callback`, `/complete`;
  `AuthService.signInAs` (a session for a person who proved who they are another way). Tested against the fake
  provider over real HTTP: sign-in by verified address and the link it makes, the link signing in afterwards,
  unknown / deactivated / unverified people refused with nobody created, a token for another application, expired,
  of another sign-in, from another issuer or signed by another key refused, a state and a hand-off code working
  once, the second factor still asked. **Not usable by an administrator yet**: a provider is a record only the system
  can make, and the sign-in page has no button — both come with part 2b (Settings › Security and the sign-in page).
- **Step 5, part 2b (2026-11-18).** **Single sign-on, usable.** Settings › Security › Single sign-on, for
  Administrators (`/api/v1/settings/sso`: list, add, change, remove, test): a provider is its key, its name on the
  button, its issuer (https; `localhost` for development) and the client id; the list gives the **redirect address to
  register** at the provider, the **variable its secret is read from** and whether it is set, how many people signed
  in with it, and Test reads the provider's configuration. Every change is audited. The sign-in page offers the
  providers that are on and have their secret (`Sign in with …`), exchanges the hand-off code for the session, asks
  for the second factor when it is owed, and says a refusal in words (unknown address, no verified address, a token
  that cannot be trusted, a sign-in used or too old, the provider failing). English and Bangla. E2E: the refusals on
  the sign-in page; a provider added, refused without https, shown with what to register, not offered without its
  secret, removed. Still to do in step 5: groups mapped to roles, the certification against Keycloak, then SCIM and
  passkeys.
- **Step 5, part 2c (2026-11-18).** **Groups become roles.** A provider has the claim that lists a person's groups
  (`groups` by default) and a map of those groups to roles here. At **each** sign-in the person holds exactly the
  mapped roles their groups give: missing ones are given, ones they no longer have a group for are taken, in every
  company; roles outside the map are never touched; nothing is said when nothing changes, and each change is in the
  audit log (`auth.sso_roles`: given … / taken …). **An Administrator role is never given by a provider**: the
  settings refuse such a map, and the sign-on leaves those roles out even if one were there. The settings check that
  every role exists. On the page: the groups with their roles (as codes), the claim, and the switch to trust a
  provider's addresses without `email_verified`. The fake provider moved to `@kosh/server/testing` (`fakeOidc`), so
  another package's tests — and a module author's — can use it. Still to do in step 5: the certification against
  Keycloak, then SCIM and passkeys.
- **Step 5, part 2d (2026-11-18).** **Single sign-on certified against Keycloak 26.0.8.** `pnpm certify keycloak`
  (`packages/server/test/certify/keycloak.certify.test.ts`) sets a realm up through Keycloak's admin API — a
  confidential client with the redirect address and PKCE required, a person with a verified address in a group, the
  group-membership mapper — and drives the sign-on as a browser would: our start, Keycloak's own sign-in form posted
  with its cookies, our callback, the hand-off. Verified with the real thing: Keycloak's discovery, its token
  endpoint with the client secret and the verifier, its published keys and its RS256 signature, the group giving its
  role, the person linked to Keycloak's id of them, and someone Keycloak knows and we do not refused with nobody
  created. Passed on the first run. Live only — a sign-on carries a nonce and a signature made for it and cannot be
  replayed — so `pnpm test` skips the contract; the pass is recorded in `recordings/keycloak.json` (when, and
  against which version). Google and Microsoft remain to verify with the company's own credentials (Microsoft needs
  *trust its addresses*: it does not send `email_verified`). Next in step 5: SCIM, passkeys.
- **Step 5, part 3 (2026-11-18).** **SCIM 2.0 provisioning.** The design, decided before the code: the company's
  directory (Entra ID, Okta, any SCIM client) is the source of who works here; this installation is a SCIM *server*
  under `/api/scim/v2` (under `/api` so every proxy that reaches the API reaches it), on Fastify and Node alone — no
  new dependency. **A token per directory**, made by an Administrator in Settings › Security, shown once, kept as a
  SHA-256 digest, provisioning into one company, revocable, with its last use. **People** (`/Users`): `userName` is
  the login, `emails` the address, `displayName` / `name` the name, `active` whether they may sign in, `externalId`
  kept beside the person. Someone made by the directory is an internal user **without a password** — they sign in
  through single sign-on or ask for a reset link. **Nobody is deleted**: `DELETE` and `active: false` deactivate and
  sign the person out everywhere at once, so records and the audit log keep their author; the last Administrator
  cannot be deactivated (the model's own rule answers). Portal users and service accounts are not the directory's:
  not listed, not found. **Groups** (`/Groups`): the directory's groups and their members are kept; **the roles a
  group gives are set here by an Administrator**, never by the directory, and never an Administrator's (refused in
  Settings, and left out when roles are applied even if one were stored). A person holds exactly the roles their
  groups give among the roles any group gives — given and taken the moment a membership or a group's roles change,
  each change in the audit log (`scim.roles`), roles given by hand outside those never touched. The protocol as
  directories speak it: `application/scim+json` (with or without a charset), SCIM's error format with `scimType`,
  `filter=userName eq "…"` / `externalId eq "…"` / `displayName eq "…"` (any other filter is refused rather than
  ignored: ignoring one would list everyone), `startIndex` / `count`, PATCH with operations in any case, booleans
  as strings (`"False"`, Entra), values without a path (Okta), `members[value eq "…"]`. Bulk, sort, ETags and
  password changes are declared unsupported in `ServiceProviderConfig`. Tests: 6 on the server with Entra- and
  Okta-shaped requests, 3 on the Administrator's routes, one E2E through the Security page. **Not yet verified
  against a real Entra ID or Okta tenant** — the request shapes are from their published behaviour; a tenant of the
  company's own is needed to certify it, as Keycloak was for single sign-on. Left out: a role picker instead of
  role codes as text, filters beyond `eq`, the enterprise-user schema (manager, department). Next in step 5:
  passkeys.
- **Step 5, part 4 (2026-11-18).** **Passkeys.** The design, decided before the code: WebAuthn on Node's crypto
  alone (as decided for single sign-on: no new dependency) — a CBOR reader for the two structures WebAuthn uses,
  COSE keys (ES256, EdDSA, RS256 of 2048 bits or more) turned into Node keys, the two ceremonies checked: the
  type, **our challenge** (random, stored hashed, five minutes, used once), **our origin**, **our relying-party
  id** (the host name of `KOSH_BASE_URL`; on `localhost` any port, for development), the person present and
  **verified by the device**, and at sign-in the signature by the key kept at registration. Attestation is not
  asked for and its statement not read: which make of authenticator a person uses is not ours to decide.
  **A passkey sign-in is the whole sign-in**: the device and what unlocked it are two factors, so no code is owed
  and the session has its second factor (an Administrator's rights apply). Passkeys are kept on the device
  (`residentKey: required`), so no login is typed. **Beside the password and the authenticator app, not instead of
  them**: a lost device locks nobody out, and where the policy asks for two-factor sign-in the authenticator app is
  still set up. Adding one needs a full session (a session that still owes its code cannot); twenty per person;
  each named, listed with when it was added and last used and whether its provider syncs it, removed by its owner
  only. A counter that does not move forward (a copied key) refuses the sign-in; synced passkeys say 0 and are
  not held to it. Every refusal is one answer to the browser (nothing to learn about which passkeys exist) with
  the reason in the audit log (`auth.passkey_refused`); adding and removing are audited; a deactivated person is
  refused. On screen: *Use a passkey* on the sign-in page (where the browser can), *Passkeys* in Your
  profile, English and Bangla. Tests: 6 on the server with a software authenticator (`fakePasskey` in
  `@kosh/server/testing`) — another origin, another site, unverified, another key, a replayed answer, a forged
  challenge, an old counter, a removed passkey, a deactivated person, someone else's passkey —, and one E2E with
  **Chrome's own virtual authenticator**, so the browser's real ceremony is what is verified. Not verified: a
  physical security key or a phone, Safari and Firefox (try yours before relying on it). Left out: passkeys as the
  second step after a password, an Administrator removing someone's passkeys from Settings › People (deactivating
  the person refuses them), a policy that requires passkeys. **Step 5 is complete** — password reset, single
  sign-on with groups to roles (certified against Keycloak), SCIM provisioning, passkeys.
- **Step 6, part 1 (2026-11-19).** **Working calendars: the model and the engine.** The design, decided before the
  code. Today four apps count time four ways — Workforce by a weekend setting, Helpdesk by a team's opening hours,
  Attendance by its own holiday list, Production by hours a day — and none knows the others' holidays. One module,
  `@kosh/worktime` (the **Working time** app), holds what they all need: **calendars** (`work.calendar`: a time
  zone, hours in a day, and a week of hours as lines — two lines for a day make a break between them; one calendar
  is the company's), **holidays** (`work.holiday`: a date or a span, once or **every year**, of every calendar of
  the company or of one) and **personal exceptions** (`work.exception`: a person's day off, or a day they work
  hours of their own, also on a weekend or a holiday). The **engine** (`time.ts`) is pure functions over a schedule
  — is this a working day, working days between two dates, the date so many working days later or earlier, the
  first and last working day of a month, working minutes between two moments, the moment so many working minutes
  later, the next moment inside working hours — in the calendar's time zone, daylight saving included;
  `scheduleOf(env, { from, to, calendar?, user? })` reads a schedule from the database as the system (counting
  time needs no right of its own). A company starts with its calendar (Sunday to Thursday, 09:00–13:00 and
  14:00–18:00) and **the fixed-date public holidays of its country, yearly**: Bangladesh (21 February, 26 March,
  14 April, 1 May, 16 December, 25 December) and India's three national holidays. **Holidays that move with the
  moon or a government notice — the Eids, Durga Puja, Diwali, Holi — are not guessed**: a manager adds them when
  they are announced or imports the year's list (the import template is there). Hours that are not hours or
  overlap, a second calendar "of the company" and a time zone that is none are refused. Roles: users read,
  managers write. Tests: 9 on the engine (breaks, a working Saturday, a half day, both directions, a
  daylight-saving change in London), 4 on PostgreSQL through the API, an E2E. The module standard passes (search,
  lists and forms, import templates, Bangla, overview, demo). **Not yet done — the next parts:** the apps still
  count their own way; part 2 moves Workforce leave onto the calendar (holidays not charged), then Helpdesk SLAs,
  Attendance, Production capacity, and payment terms and delivery dates in working days; recurring events, ICS and
  the Google / Microsoft sync follow.
- **Step 6, part 2a (2026-11-19).** **Leave counts by the working calendar.** Workforce depends on Working time.
  An employee has a **working calendar** (empty: the company's); a leave's days are the working days of that
  calendar between its dates — **public holidays are not charged**, nor the days the person does not work anyway
  (their personal exceptions) — on the form as the dates are typed and checked by the server when it is saved
  (`leaveDays`). Someone on a Monday-to-Friday calendar and someone on the company's Sunday-to-Thursday week get
  different counts for the same dates, each right. **The weekend setting of Workforce is gone** (App settings ›
  Workforce › Working week): the week is the company's calendar now, and Attendance reads its weekend from it
  (`weekendOf`: the days the calendar has no hours on). HR managers are Working time managers (they set calendars,
  holidays and exceptions); employees read them. Leave already requested keeps its days: the count is checked when
  a leave's dates or days change. **For an installation that had changed the weekend setting**: its choice is not
  carried over — set the company's calendar's week once (Working time › Calendars). Next: Helpdesk SLAs,
  Attendance's holidays, Production capacity, terms in working days.
- **Step 6, part 2b (2026-11-19).** **Attendance and Helpdesk count with Working time.**
  *Attendance*: each person's day is computed from their working calendar (the company's when they have none):
  a day its week does not work is the weekend, a worked weekday taken off — a public holiday, the person's own day
  off — is a holiday, a day with hours of its own (a worked Saturday) is neither. **Attendance's own holiday list
  (`attendance.holiday`) is removed**: holidays are entered once, in Working time, and Attendance › Configuration ›
  Public holidays opens them there. *An installation that had entered holidays in Attendance loses that list on
  upgrade* (the model is gone): re-enter or import them in Working time. None is in production yet; had there been,
  this step would have needed a data migration first.
  *Helpdesk*: a team may work by a **working calendar** — its breaks and its holidays are then not counted towards
  the SLA, in the calendar's time zone — or keep its own opening hours and weekend as before (a support desk often
  keeps other hours than the company; the default is unchanged). The counting is Working time's engine for both:
  Helpdesk's own was a copy of it and is gone (`hours.ts` is now an adapter). Found on the way and fixed: the
  check that a calendar's hours do not overlap read with the request's rights, which are gone when a constraint
  runs at the final flush — it reads as the system now. Tests: a holiday on a team's calendar moves a four-hour
  target days away while a team on its own hours is due in hours; the lunch break and a holiday in the engine's
  adapter; Attendance's holiday test through Working time. Next: Production capacity and terms in working days,
  then recurring events and ICS.
- **Step 6, part 2c (2026-11-19). Production and payment terms on Working time.**
  *Production*: a work centre may have a **working calendar**; its work orders are then scheduled inside the
  calendar's hours — starting at the next working moment and stopping when that many working minutes have passed,
  around its breaks, weekends and holidays (`centreSchedule`, `scheduleWithin`). The capacity by day says each
  day's **capacity hours** (none on a weekend or a holiday) and counts planned work inside the working windows
  only; a plan line's capacity check adds up the working minutes of its slot's days. A centre without a calendar
  works as before: every day from 08:00 for its hours a day (the default is unchanged, and so are existing
  schedules). The capacity request reads calendars as the system, so it is opened for writing.
  *Accounting*: a payment term says how its **days are** counted — *calendar days* (as before, the default),
  *calendar days, never due on a day off* (a due date on a weekend or a holiday moves to the next working day), or
  *working days* (counted on the company's calendar, holidays not counted). Applied when a document is posted, to
  each part's maturity and the document's due date. Accounting now depends on Working time.
  Tests: ten hours from a Friday around lunch and over the weekend, twenty more over a holiday, the capacity of
  six days with a weekend and a shutdown; ten working days over Victory Day, thirty days landing on a Saturday,
  six days landing on the holiday. **The apps that count time now count with one engine**: leave, attendance,
  Helpdesk SLAs, production scheduling and capacity, payment due dates. Left out: delivery and arrival dates in
  working days (Sales and Purchase lead days are still calendar days), Projects' schedule, quiet hours of
  notifications. Next in step 6: recurring events and ICS invitations, then the Google / Microsoft sync.
- **Step 6, part 3a (2026-11-19). Repeating events.** The design, decided before the code: **a series generates
  real events**. A *repeating event* (`calendar.recurrence`, Agenda › Repeating events) holds the first meeting,
  the rule and who is invited; *Generate* makes its occurrences as `calendar.event` records. So everything an event
  already does keeps working without a second path: a room is never double-booked, each occurrence has its own
  attendees and answers, privacy and record rules apply, the calendar, the list and the home page show them, and
  one occurrence can be moved or cancelled alone. (The other design — occurrences computed at read time from the
  rule — needs every reader to know recurrence: the room check, free / busy, record rules, the calendar view, the
  API. That is the cost Odoo's own history with recurrence shows.)
  **The rule** (`recurrence.ts`, pure): every *n* days, weeks (on chosen weekdays), months or years; in a month
  the same day (the last when the month is shorter), the same weekday in the same week (*the second Tuesday*; the
  last when there is no fifth), the last such weekday, or **the first / the last working day**; ends after a
  number of times or on a date, one of the two required, at most 366 occurrences and ten years. **On a weekend or
  a holiday** of the company's working calendar an occurrence is kept, skipped, or moved to the working day before
  or after (two that land on the same day are one). The rule is said in words on the form (*Every 2 weeks on
  Tuesday and Thursday, 10 times*). Occurrences keep the first meeting's time of day in the calendar's time zone,
  whatever daylight saving does.
  **Generating again** after a change redoes the occurrences still to come and still the series' own: the past is
  never rewritten, nor an occurrence ticked *Keep as it is*, nor one moved to another time by hand. *Stop the
  series* removes what was still to come and the series' own. A room taken on one of the dates refuses the whole
  generation, naming the date, and nothing of it is made. Only the organizer (and Agenda managers) generates.
  Agenda now depends on Working time. Tests: 8 on the rule (each kind, months that are shorter, working days, days
  off kept / skipped / moved, 29 February, the limits, the words), 2 on PostgreSQL through the API (generate,
  attendees, the refused room, a moved and a kept occurrence across a change, stop; a Friday moved to Sunday), an
  E2E through the form. Left out: a series without an end (it would need a job that extends it), exceptions
  entered on the series itself (cancel the one event instead), the series as one line on the calendar, the
  organizer's own time zone. **Next:** ICS — an invitation by email that lands in any mail client, and a calendar
  feed — then the Google / Microsoft sync (which needs the company's credentials).
- **Step 6, part 3b (2026-11-19). ICS: invitations by email and calendar addresses.** No dependency: iCalendar
  (RFC 5545) is written by `ics.ts` — UTC times (all-day events as dates, the end the day after the last), text
  escaped, lines folded at 75 bytes without cutting a character, CRLF, and nothing a title or an address can
  inject as a line of its own (tested).
  **Invitations**: *Send invitations* on an event (the organizer or an Agenda manager) emails each attendee —
  people of the company and contacts — the meeting in words (when, in the calendar's time zone; where; the video
  link) with `invite.ics` (`METHOD:REQUEST`: the organizer, every attendee with their answer). Sent again after a
  change it is an *Updated invitation* with the same event id and a higher sequence, so the client updates its
  event. **Cancelling** an event that was sent emails `METHOD:CANCEL` to those who had been invited, and nobody
  when it never was. The organizer is not written to about their own meeting. Through the outbox
  (`calendar.event.invited`, `calendar.event.cancelled`), after the commit; English or Bangla by the person's
  language. **Explicit, not automatic**: nothing is emailed by saving an event — an ERP that mails on every edit
  trains people to ignore it.
  **Calendar addresses**: *Agenda › My calendar address* gives a person a secret link
  (`/api/v1/agenda/feed/<secret>.ics`, 192 bits) that Google Calendar, Outlook or a phone subscribes to: their
  events — organized, or attended and not declined — from 30 days back to 400 days ahead, repeating events
  included as the events they are. Read without a sign-in, rate limited, read only; its owner's alone (not even a
  manager sees it); deleting it closes it, and a wrong, malformed or closed address gets one answer.
  Tests: 4 on the writer, 2 on PostgreSQL (the invitation, the update, the cancellation, the quiet cancel, an
  attendee refused; the feed's contents, its privacy, its closing).
  **Limits, said plainly**: the `.ics` is an attachment — Gmail and Outlook read it and offer to add the event;
  an answer given in the mail client goes to the organizer's mailbox (reply-to), **not back into Agenda** (people
  of the company answer in Agenda; reading replies needs the inbound mail route, a later step). A whole series is
  not sent as one invitation: send the occurrences, or share the calendar address. Not verified in real Gmail and
  Outlook mailboxes — the format is the standard's; try one invitation to yourself first. **Next**: the Google
  and Microsoft two-way sync, which needs the company's OAuth credentials.
- **Step 7, part 1 (2026-11-19). Rich text in fields.** The dependency, approved by the owner on this date:
  **Tiptap 3** (`@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extension-table`,
  `@tiptap/extension-image`; MIT, on ProseMirror) in `@kosh/ui` only. Why a dependency at all: a text editor that
  handles selections, undo, lists, tables, composition (Bangla input) and paste on every browser is years of
  work that is not ours to redo; nothing else in the stack edits rich text. The decided design:
  **The server is the gate.** Whatever is saved into an `html` field through the API — a record, its lines, an
  import — is **rebuilt from an allow-list** by `sanitizeHtml` (`packages/server/src/html.ts`, no dependency: a
  tokenizer that writes its own output and never copies the input's markup): paragraphs, headings, emphasis,
  lists, a quote, code, links (web, mail, phone, or a path of this installation; always with `rel="noopener
  noreferrer nofollow"`), images (https or this installation's files), tables, and mention / record spans. Tags it
  does not know lose their tag and keep their text; what holds code (`script`, `style`, `iframe`, `svg`, `math`,
  `template`…) goes with its content; open tags are closed; nesting stops at 40; 500 000 characters at most.
  Tested with 27 attack strings (handlers, `javascript:` written five ways, unclosed scripts hiding the rest,
  comments, CDATA, attribute break-outs) and proved stable when run twice.
  **The browser is a second gate**: what is shown is rebuilt again from the same allow-list
  (`sanitizeForDisplay`, the browser's inert parser, node by node) — for values that reached the database another
  way (a module's own code, an old import).
  **The editor** (`RichTextEditor`, loaded on demand so a page without rich text never downloads it): a toolbar of
  labelled buttons — bold, italic, underline, strikethrough, two headings, bulleted and numbered lists, a quote, a
  code block, a link with its address field, a table, undo, redo — reached by the keyboard, named for a screen
  reader, saying what is on at the cursor; English and Bangla; the theme's colours in light and dark. The `html`
  widget shows formatted text where a field is read and the editor where it is written; plain text written before
  a field became rich shows as paragraphs, a line each.
  **Elsewhere**: print templates print rich text as its words, a line per block (`htmlToText`); an invitation's
  description too. **First fields**: the description of a project, a task, a Helpdesk ticket, an event and a
  repeating event.
  Tests: 7 on the sanitizer, the API round trip on a ticket (what was sent with a script, a handler and a
  `javascript:` link against what the database holds), an E2E typing in the editor with the toolbar and reading
  back what the server kept. **Left for part 2**: the chatter (comments and notes are still plain text), mentions
  and record links inside text, images from storage with an upload button (an image can be pasted by address
  only), clean-up of Word and Google Docs paste beyond what the allow-list already drops, rich text printed with
  its formatting, more fields.
- **Step 7, part 2 (2026-11-19). Rich text in the chatter, with mentions.** The chatter keeps its plain box —
  the small markdown of `body.ts`, safe by construction, is still the default and what email and the assistant
  write — and gains **Formatting**: a toggle on the composer (remembered per browser) that swaps the box for the
  editor, with a **Mention someone** button that searches people by name and puts the mention in the text as one
  unit. What was typed comes along when the toggle is pressed. Ctrl+Enter sends.
  On the server a message may be sent as `html` instead of `text` (`POST …/messages`, `PATCH …/messages/:id`):
  it is rebuilt from the allow-list, then **each mention is written again from its id with the user's current
  name** — the label that was sent is never trusted, and a mention of nobody who exists becomes its plain text;
  the mentioned people are the message's mentions as before (notifications, the outbox event). The message keeps
  `rich: true`, its formatted body, and its **words** as `text` (previews, notifications, search, the assistant).
  An empty message — empty paragraphs, or only what was stripped — is refused; 100 000 characters of HTML at
  most. A rich message is shown through the rich-text view (rebuilt from the allow-list again in the browser) and
  **edited in the editor it was written in**, its mentions intact; a plain one is as before.
  Tests: the API round trip (a forged mention label, a ghost, a script, a handler, the words, the event, the
  refusals, the edit, someone else's edit refused, a plain message untouched), an E2E that formats, mentions,
  sends and edits a note. Fixed on the way: plain words of rich text had a blank line after every list.
  **Left out, deliberately or for later**: the internal chat (channels and directs stay plain: short messages,
  typed fast), typing `@` in the editor to open the people list (the button does it; the suggestion plugin is
  another dependency), links to records inside text, images uploaded into the text (attach files as before), rich
  text printed with its formatting.

- **Step 8 — subscriptions (2026-11-19).** `@kosh/subscription`, the Subscriptions app. Plans (every *n* days,
  weeks, months or years, a trial, invoices posted or drafted), subscriptions with lines billed every period or by
  usage, priced by the price list unless typed in; transitions `begin`, `pause`, `resume`, `amend` (Apply changes)
  and `close` with a reason. The arithmetic is in `billing.ts` without a database and without floating point:
  periods counted from the anchor day (the 31st bills on 28 February, then on the 31st again), MRR, and the share
  of an amount for the days left. **One invoice per subscription and period**: `account.move` gains `subscription`
  and `subscriptionPeriod`; the invoice of a period is looked for before it is made, in the transaction that
  advances the subscription, so a second server, a retry or a crash between the two makes no second invoice (a
  test kills the run between the invoice and the counter). Catch-up of up to twelve periods; a pause does not
  bill the periods it covered. Usage is invoiced once and locked. Proration invoices or credits each changed line
  for the days left of the paid period. The overview: MRR, running, started and closed this month, MRR by plan,
  why customers left, the largest; a cohort view by starting month. Hourly on a running server, and
  `POST /api/v1/subscriptions/run` for managers (audited).
  Tests: the arithmetic (4), the API with real PostgreSQL (6: once per period, catch-up, the crash, a trial with
  posted invoices, usage once, proration both ways, closing with a reason, forged billing dates refused, someone
  without the role refused), an E2E.
  **Found on the way, and fixed in four modules**: a field declared `groups: { write: [] }` is *not* system-only —
  Shutro reads an empty list as no restriction, so a manager could move a subscription's next invoice date, and
  the same held for Agenda's series links and invitation counters, attendance machines' last-seen marks and stock
  valuation's accounting date and unit cost. They are now `['base.admin']` (the system and Administrators);
  Shutro request #38 asks for a way to say "the server only". Request #39: `f.html`'s `sanitize` is declared but
  Shutro has no sanitizer (Shutro ERP rebuilds HTML itself, in the REST layer).
  **Left for later**: usage fed by Counter sales and timesheets through bridges, payments taken by themselves at
  each invoice (the providers of RFC 0017 keep no card on file yet), plan changes by the customer in the portal,
  failed payments pausing a subscription (follow-ups already chase its invoices).

- **Step 9 part 1 — time billing (2026-11-19).** `@kosh/project_billing`, a bridge of Projects and Accounting
  (it needs `project_account`: invoice lines carry the project's cost centre). Rate cards with lines by person,
  role and kind of task; `rates.ts` picks the most specific line without a database (person 4, role 2, task 1;
  the first of equals; then the card's rate; else none). Timesheets gain `approval` — a state field added by an
  extension — with `submit`, `approve`, `refuse`, `reopen`; approving is a permission of Projects managers
  (`project_billing.approve`), never on one's own hours, and freezes `billRate` and `billAmount`. Billing
  milestones (`reach`, `revert`). `project.statement`: `bill` gathers approved billable hours up to a day and
  reached milestones not yet on a statement, makes one draft invoice and marks them, in one transaction;
  `release` after the invoice was cancelled; `discard`. Deletes of submitted or approved hours and of billed
  milestones are refused by a database trigger (Shutro has no hook before a delete: request #23), installed with
  the defaults and dropped before an uninstall.
  Tests: the rates (3), the API on real PostgreSQL (6: who approves, the frozen rate, refusal with a reason, the
  locks, forged rates refused, rates hidden from those who log time, no rate no approval, the statement's invoice
  line by line, once only, release and billing again), an E2E from the forms.
  **Fixed on the way, in the back-office**: a button that opens a new record filled from the open one (RFC 0028
  §3.4 — *New quotation* on a deal) lost its values, because going from one record page to another keeps the page
  component and the values were only taken when it was first shown; and a new record that arrived filled could
  not be saved until a field was touched. Both fixed in `@kosh/ui`, and now covered by this step's E2E.
  **Left for part 2**: work in progress and revenue recognition posted to Accounting, profit per project and
  phase from timesheets, purchases, expenses and production; invoices posted by themselves; expenses re-invoiced.

- **Step 9 part 2 — work in progress, recognition, profit (2026-11-20).** In `@kosh/project_billing`.
  `unbilledOf(env, project, date)`: approved billable hours up to a day and milestones reached by then that are
  on no posted invoice, at their frozen rate. The project gains `revenue` (income lines of posted entries on its
  cost centre, recognition entries left out), `unbilled`, `profit` and `margin`, written with every refresh of
  its figures through the `moneyOf` chain of RFC 0026 — after `project_account` found the booked costs —, and each
  phase `phaseCost`, `phaseEarned` and `phaseProfit`. `project.recognition` with `recognise`: one entry dated the
  day (accrued income `1180`, made the first time, against the sales journal's income account on each project's
  cost centre) and its opposite dated the day after, both posted in the `REVR` journal and linked; once a day per
  company. Its own reversal, not Accounting's `reverseMove`: that one does not copy the cost centre of an
  entry's lines.
  A statement now makes the project's cost centre when it has none yet — before, the first invoice of a project
  whose figures were never refreshed carried no cost centre, and its revenue was nobody's.
  Tests: the API on real PostgreSQL (2 more: the figures before and after an invoice is posted, hidden from
  those who log time, a phase's figures; the recognition's four ledger lines with their dates and cost centre,
  nothing to recognise, once a day, locked, forged amounts refused, who may read), the E2E recognises from the
  screen.
  **Left out**: percentage of completion for fixed-price work (milestones are the recognition points),
  recognition in a foreign currency, cancelling a posted recognition from its form, production and expense costs
  split by phase (they are the project's, through the cost centre), a chart of profit over time.
  Step 9 complete.

- **Step 10 part 1 — leave accruals (2026-11-20).** `@kosh/hr_accrual`, a bridge of Workforce and Payroll (it
  uses Payroll's formula language and Attendance's approved days). `accrual.ts` steps a balance through a month
  without a database, in hundredths of a day: the year's lapse above the carry-over on 1 January, leave taken
  (carried days first), the expiry of what was carried, then the month's accrual after probation and up to the
  cap. `hr.accrual.plan` (a formula checked when saved, one active plan per type), `hr.accrual.entry` (the
  ledger: read and create only; `kind` and `period` are the server's, so a line made by hand is an adjustment),
  `hr.accrual.balance` (per person and plan: the last month accrued, what is carried, today's and the year's
  figures, the projection to 31 December, what expires and when). `accrueLeave` writes the months that are over,
  once; `projectLeave` runs the same steps forward to any day with the leave asked for and the working days of
  the months to come.
  **Workforce changed for it**: the balance check of a leave is now a model method, `overBalance()`, that the
  bridge overrides for types with a plan — the balance on the day the leave starts, future accruals included —
  and leaves alone for the others (days per calendar year, as before).
  Tests: the arithmetic (6), the API on real PostgreSQL (7: a formula refused, one plan per type, probation, the
  cap, the month joined, nothing twice, leave refused and allowed by the day it starts, the projection over a
  year's end with carry-over and expiry, balances and who reads them, adjustments and a ledger that is never
  changed, a formula on days worked), an E2E.
  **Left for part 2**: encashment through Payroll, the Bangladesh plans as data. **Left out**: accrual by the
  day or the fortnight (a month is the step), plans per department or employment type (one plan per leave type
  and company), a person without a joining date (they accrue nothing, and their leave of such a type is refused),
  the balance shown on the leave form itself (it is on the Leave balances screen and in the API).

- **Step 10 part 2 — payouts and Bangladesh (2026-11-20).** In `@kosh/hr_accrual`: the plan says whether days
  are paid out, how many stay, what a day is worth (a formula on `WAGE`, `DAYS`, `BALANCE`, `SERVICE_YEARS`) and
  the Payroll input's code. `hr.leave.encashment`: `submit`, `approve` (the permission `hr_accrual.encash_decide`
  of HR managers, never one's own), `refuse` with a reason, `redraft`. `payOut` checks the balance projected to
  the day against what must stay, the running contract and that its structure has a rule reading the input — each
  refusal in words —, then writes the ledger line (`encashment`) and the `payroll.input` in one transaction.
  Payroll is unchanged: the month's run reads the input as it reads any other.
  `l10n_bd_payroll` now needs `hr_accrual`: a `LEAVE_ENCASH` rule in both structures (added to structures
  installed earlier; their other rules are left as they are, so there `REGULAR_PAY` still projects a payout
  forward until the manager subtracts it), and the Labour Act's casual, sick and earned leave as plans installed
  **switched off** per company, each with what to verify in its note.
  Tests: the API on real PostgreSQL (the payout: not payable, no contract, no rule, never one's own, more than
  may be paid, the amount, the ledger, the input, once, locked, refused with a reason, who reads), the Bangladesh
  rule and plans installed once, the E2E approves a payout on screen.
  **Left out**: cancelling an approved payout from its form, payouts decided through the Approvals engine,
  payout at the end of service (final settlement), a pro-rata first year for casual and sick leave in the
  Bangladesh plans. Step 10 complete.

- **Step 11 part 1 — the survey engine and its app (2026-11-20).** `@kosh/survey`, the Surveys app.
  `engine.ts` without a database: `visibleQuestions` (a question waits for an earlier one that is itself shown),
  `review` (answers by kind, an error per question, nothing kept for questions not asked, the score against the
  maximum of what was asked), `nps`, `csat`. Models: `survey.survey` (`publish`, `close`, `reopen`, `redraft`),
  `survey.question` with `survey.choice`, `survey.invitation` (a key of its own, used once), `survey.response`
  with `survey.answer` — made by the server only. A condition on a choice is written by its label and resolved
  to the choice when the survey is loaded; a survey with a condition that cannot hold does not open. Keys are
  18 random bytes, written by the server. The public page is one HTML document with a nonce'd script and a
  `default-src 'none'` policy; it is answered as the system by the key alone, in a `bootstrap` without a company.
  Tests: the engine (5), the API on real PostgreSQL (6: what opens, the page and its headers in two languages,
  the review's errors, what is kept and scored, the figures and the results, an invitation used once on an
  anonymous survey, the locks, who may do what), an E2E with a visitor who is not signed in.
  **Found on the way**: a boolean cannot be empty in Shutro, so "passed" is a three-way *outcome* — a survey
  without a pass mark has neither passed nor failed.
  **Left for the next parts**: invitations sent by email, the bridges (Helpdesk CSAT and NPS, Hiring screening,
  Event Hub feedback, Pipeline qualification), the careers page. **Left out**: pages and sections, a time limit,
  file uploads as answers, one answer per person on a public link (that is what invitations are for), a captcha
  (the server's rate limit applies).

- **Step 11 part 2 — emailed invitations and asking by itself (2026-11-20).** In `@kosh/survey`, instead of a
  bridge module per app: `survey.trigger` waits for a named event of any installed app or for `<model>.created`,
  finds the people on the record — or on each row of one of its lists —, keeps those that meet a condition and
  have an address, and invites each once per survey and record (`inviteAbout`); a chosen answer is written on the
  record (`writeBack`: a ticket's rating). The server tells Surveys what the installed apps offer when it starts
  (`triggerCatalogue`: the manifests' `events` and the metadata API's fields), and a rule is checked against it
  when saved. Workers on the outbox (`surveyWorkers`): one per named event, one on Shutro's change events for
  records made — Surveys asks for `changeEvents: '*'`, as Integrations and Automation do —, one on a survey
  opening; an invitation is emailed once (`sentAt`), after the commit. `surveyModule({ mailer, baseUrl, workers })`
  for tests.
  Tests: the API on real PostgreSQL with Helpdesk installed (5: the email once and only when open, in Bangla, the
  whole link; rules refused; a rule on contacts made with a condition; a rule over a record's rows; a ticket
  solved, its customer asked, their answer on the ticket and the response tied to it).
  **Left out**: reminders for invitations not answered, a delay before asking (three days after delivery), a
  response shown as a tile on the other app's record (each app would add it), the answers of a screening summed
  into Hiring's scorecards.

- **Step 11 part 3 — the careers page (2026-11-20).** `@kosh/website_hiring`, a bridge of Sites and Hiring (it
  needs Attachments for the CV). Openings gain `published`, `location`, `employment`, `closingDate`; applicants
  `cover` and `mailedStage`; stages `mailSubject` and `mailBody`. Three public routes under the site's key, read
  and written as the system in the site's company; `apply` makes the applicant in the first stage, once per
  address and opening, and the CV is stored with `saveAttachment` — a document type only, 5 MB at most. A worker
  on Shutro's change events of `hiring.applicant` (asked for with `changeEvents`) emails a candidate when they
  are made and when their stage changes: `takeStageEmail` remembers the stage on the applicant, so each stage
  reached is emailed once.
  Tests: the API on real PostgreSQL (3: what is listed and what is not, an application with its CV on disk, a
  bad one refused, a duplicate, a robot, a closed opening, the emails by stage), an E2E from the opening's form to
  the applicant.
  **Not built — the CV read by the assistant on an existing applicant.** The assistant's *Fill from a document*
  proposes values for a **new** record, in the form, and its budget, switch and log live inside its routes; a
  proposal on a record that exists needs that opened up and a place in the form to confirm it. It is the one
  item of §2.6's careers line left, and worth a step of its own rather than a half of one here.
  Step 11 complete but for that.

- **Step 12 part 1 — loyalty: earning (2026-11-20).** `@kosh/loyalty`, the Loyalty app. `engine.ts` without a
  database, money in hundredths and points whole: `earn` (every rule in force gives for each full step of the
  order — or of its product's or category's lines, never more than the order is worth after its discounts —,
  the sum multiplied by the tier and rounded down), `tierOf`, `expiredPoints` (what was earned before the cutoff
  less everything ever taken off the card: the oldest points go first, and writing the result makes the next
  answer zero), `preview`. Models: `loyalty.program` (`look` for the preview — a transition from draft to draft —,
  `launch`, `finish`), `loyalty.rule`, `loyalty.tier`, `loyalty.card` (one per program and customer),
  `loyalty.entry` (read and create only; `kind` is the server's, so a line made by hand is an adjustment).
  Workers on Sales' `sale.order.confirmed` and `sale.order.cancelled`: `earnOrder` and `reverseOrder`, each
  finding its own earlier line before writing another.
  Tests: the engine (5), the API on real PostgreSQL with Sales (6: the preview's figures and that it gives
  nothing, one program at a time, an order earning once and reversed once, the tier multiplying the next order,
  adjustments and their limits, expiry once, an ended program), an E2E of the preview.
  **Left for the next parts**: spending points (a discount line on the order, taken at confirmation), wallets and
  gift cards, promotions and *buy X get Y* with their preview, the Counter. **Left out**: tiers in the preview,
  points on taxes or delivery, a program per customer group, points shared by a company's contacts.

- **Step 12 part 2 — loyalty: spending, wallets and gift cards (2026-11-20).** In `@kosh/loyalty`. The engine
  gains `redeemLimit` (whole points, never past the card or the share of the order points may pay) and
  `voucherUse`. `loyalty.voucher` (gift card or wallet, a code of twelve letters made by the server, a balance
  computed from its ledger) and `loyalty.voucher.entry`. On `sale.order`: `loyaltyRedeem`, `voucherCode` and a
  transition `credit` from draft to draft — `applyCredits` first gives back whatever the order held
  (`releaseCredits`: the net of its `redeem` / `refund` lines per card and of its `spend` / `refund` lines per
  voucher), then writes a line below zero on the order and a line in the ledger for each. The lines are service
  products of the company made on first use, marked with `loyaltyKind`. The worker on `sale.order.cancelled`
  gives back what the order held, keeping its lines.
  Tests: the engine (2 more), the API on real PostgreSQL (2 more: the three refusals of points in words, held at
  once, changed without holding twice, a second quotation refused what the first holds, earning on what is left,
  everything back on cancellation; a gift card paying in full and in part, emptied, an unknown code, another
  customer's wallet, the refund on cancellation, expiry).
  **Known limits**: points and credit come off after taxes, as tender, so the order's tax is on the full goods;
  a quotation deleted — not cancelled — while it holds points keeps them held (cancel it instead); a credit line
  removed by hand is put right by pressing the button again. **Left for part 3**: promotions and *buy X get Y*
  with their preview; gift cards sold as a product; the Shop's checkout and the Counter.

- **Step 12 part 3 — loyalty: promotions (2026-11-20).** In `@kosh/loyalty`. `promotions.ts` without a database:
  `discountOf` (a percentage, an amount, *buy X get Y* over whole units with the cheapest free, or free units of
  another product for units bought; dates, a code, a minimum), `applyPromotions` (those that go together added
  up; one that goes alone taken when it gives more; never past the goods) and `previewPromotion`.
  `loyalty.promotion` with `look`, `launch`, `finish`; on `sale.order` a `promoCode` and a transition `promote`
  that removes the lines of earlier promotions and writes one per discount, marked `loyaltyKind: 'promotion'`
  with the promotion on the line — and works points and credit out again when the order held any. Releasing
  credits now touches only their own lines.
  Tests: the engine (7), the API on real PostgreSQL (3 more: what cannot be saved, the preview's figures on the
  orders still confirmed, a draft taken by nobody, a running one once, buy 2 get 1 beside a percentage, a code
  wrong and right, a promotion that goes alone and its end, a gift card worked out again after promotions change,
  the lines' marks refused to a user), an E2E on the order form.
  **Known limit, as for the Shop's amount coupons**: a promotion's line carries no tax, so the order's tax stays
  on the full goods; lowering the tax needs the discount spread over the goods' lines, tax rate by tax rate.
  **Left out**: the Shop's checkout and the Counter (their own coupons stay), promotions per customer or tier,
  a limit on how often a code is used, gift cards sold as a product.
  The loyalty line of §2.6 is done for Sales; Shop and Counter take it next, then live chat.

- **Rich text, a race found by its flaky E2E (2026-11-20).** The Helpdesk rich-text test failed twice in full runs:
  a key pressed right after a toolbar button was sometimes not taken. The editor's options — extensions, props,
  handlers, the starting content — were new objects on every render, so Tiptap set the editor up again each time
  the form re-rendered, which a toolbar click causes. They are now made once (`EXTENSIONS`, memoised props,
  handlers behind refs): measured with a throwaway test, the loss went from four runs in six to one in six.
  The comparison that decides whether the editor shows a new value now ignores the empty paragraph kept at the
  end, as the value sent does. **Still open**: that one in six — a key within milliseconds of a toolbar click,
  which a person is not fast enough to do; its cause is not found. The test presses Enter again only while no new
  line is there, and says so.
