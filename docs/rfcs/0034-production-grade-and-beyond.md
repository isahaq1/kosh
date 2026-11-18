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
