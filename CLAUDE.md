# Kosh — Project Instructions for Claude Code

## Mission

Kosh is a modern ERP framework for business software, designed to be more
robust, faster, more flexible and easier to use than Odoo. It is built on the
**Shutro ORM**, which is integrated by default.

For every decision ask: **"Does this help people build or use business software
better than Odoo?"** If not, leave it out.

## Shutro integration (mandatory)

- Kosh depends on Shutro as a package: `npm i shutro` (if the published name
  differs, e.g. `@shutro/core`, use that — keep the import path in ONE place:
  `packages/server/src/orm.ts`).
- During development, Shutro may be linked locally (`pnpm link` or a workspace path).
- **Kosh never reimplements ORM features.** Models, fields, recordsets,
  computed fields, record rules, audit, sequences, multi-company and migrations
  come from Shutro. If Kosh needs something Shutro lacks, write it down in
  `docs/shutro-requests.md` and ask before working around it.
- Kosh reads Shutro's **metadata API** to auto-generate REST endpoints,
  OpenAPI docs, views, forms, filters, exports and permission screens.

## Tech stack (do not change without an approved RFC)

**Backend**

- TypeScript strict, ESM, Node.js LTS, no `any`
- HTTP: Fastify (plugin per Kosh module)
- API: REST + auto-generated OpenAPI + generated typed client (GraphQL later, optional)
- Auth: Kosh-native on Shutro (decided 2026-10-18 instead of Better Auth: one user store, audited, record rules apply):
  sessions, TOTP 2FA and recovery codes now; OAuth/SSO and passkeys built on the same models later
- Jobs & scheduler: Shutro's transactional jobs and outbox subscribers (decided 2026-10-25 with RFC 0006 instead of pg-boss: a job's database work commits exactly once, in the job's own transaction, as the enqueuing user); a scheduler on top later. BullMQ only if an RFC justifies Redis queues
- Cache, rate limiting, pub/sub: Valkey/Redis
- Real-time: WebSocket gateway + PostgreSQL LISTEN/NOTIFY + Redis pub/sub for multi-node
- Files: S3-compatible storage (S3, MinIO)
- PDF: HTML templates rendered with Playwright
- Email templates: React Email or MJML
- Observability: Pino logs + OpenTelemetry traces/metrics

**Frontend**

- React + TypeScript + Vite (back-office SPA)
- TanStack Router, TanStack Query, TanStack Table + TanStack Virtual, TanStack Form
- UI: shadcn/ui + Radix UI + Tailwind CSS (owned components, light/dark themes, RTL-ready)
- Charts: Apache ECharts · Maps: MapLibre · Drag & drop: dnd-kit
- i18n: i18next (English, Bangla and any other language)
- PWA first; React Native (Expo) later. The customer and vendor portal is a Vite + React app on the same design
  system (`apps/portal`, RFC 0015, decided 2026-10-27); the public website later in Next.js.

**Tooling**

- pnpm workspaces + Turborepo, Biome, Vitest, Playwright (E2E), Testcontainers,
  Changesets, GitHub Actions, Docker

## Core principles

1. **Modular monolith** — strict module boundaries; split services only when load proves it.
2. **Metadata-driven** — define a model once, get API, views, filters, exports and permissions.
3. **Customizable without forking** — every view, action and screen can be extended or replaced by another module or a custom React component.
4. **Secure by default** — default-deny permissions, enforced on the server, never only in the UI.
5. **Fast by design** — stateless servers, heavy work in background jobs, performance budgets in CI.
6. **Explicit over magic** — every extension is traceable to the module that made it.

## Package layout

```
packages/
  server/        # Fastify app, module loader, REST/OpenAPI generator, auth, env per request
  modules-sdk/   # defineModule, defineView, defineMenu, defineAction, defineReport, defineNotification
  permissions/   # roles, groups, ACL, field security, action permissions, approval rules (uses Shutro rules)
  views/         # view schemas: list, kanban, form, pivot, chart, calendar, gantt, map, hierarchy, cohort, spreadsheet, dashboard
  search/        # shared search/filter/group-by/favorites/saved-views layer
  reporting/     # pivot engine (GROUPING SETS/ROLLUP/CUBE), comparisons, scheduled reports, PDF designer, Excel export
  messaging/     # chatter, followers, activities, internal chat, channels
  notify/        # omnichannel notifications: in-app, web push, email, SMS, WhatsApp, Telegram; provider adapters
  mail/          # outbound + inbound email, templates
  jobs/          # job queue, scheduler, retries
  realtime/      # WebSocket gateway
  storage/       # attachments on S3-compatible storage
  ui/            # React app shell, design system, view renderers
  cli/           # kosh new | dev | module:create | migrate | build
  settings/      # the Settings app: App manager (install / disable / enable apps)
modules/         # the business apps, all Kosh code (never in Shutro): contacts, product, sales, purchase;
                 # accounting and projects next. Typed model views in src/.kosh/ (pnpm generate:models)
apps/
  web/           # back-office SPA
  demo/          # demo ERP: base, contacts, product, purchase, inventory, sales
  portal/        # the customer and vendor portal (RFC 0015)
docs/
  rfcs/
```

## Module system

A Kosh module is a folder with a manifest. Illustrative (refine via RFC):

```ts
export default defineModule({
  name: "purchase",
  version: "1.0.0",
  depends: ["base", "contacts", "product", "inventory"],
  models: [PurchaseOrder, PurchaseOrderLine], // Shutro models
  extends: [ProductPurchaseExtension], // Shutro extendModel
  views: [
    purchaseOrderList,
    purchaseOrderForm,
    purchaseOrderKanban,
    purchasePivot,
  ],
  menus: [purchaseMenu],
  actions: [confirmOrder, approveOrder],
  permissions: purchaseGroups, // groups, ACL, record rules, field security
  approvals: [
    {
      model: "purchase.order",
      when: (o) => o.amountTotal.gt(100000),
      approver: "purchase.manager",
    },
  ],
  reports: [purchaseOrderPdf],
  notifications: [orderApprovedNotification],
  jobs: [remindLatePurchases],
  i18n: { en: enMessages, bn: bnMessages },
});
```

## Permission system (custom role-based, configurable from the UI)

### Everything is permission-based

- **Every module/app is access-controlled.** Installing a module does NOT give
  anyone access. A user sees and uses an app (its menus, views, APIs, reports,
  notifications, chat channels) only if one of their roles grants access to it.
- Each module manifest MUST declare its access levels (e.g. `purchase.user`,
  `purchase.manager`); a module without permission declarations fails to load.
- Every API route, view, menu, action, report, export, job trigger and
  WebSocket event is checked on the server — no unprotected endpoints.

### Administrator (superuser)

- Users with the **Administrator** role need no permissions: they have full
  access to all apps, models, fields, records, actions and settings automatically.
- Implemented as a single explicit bypass using Shutro's superuser mode
  (`env.isSuperuser`) — never by granting admin every individual permission.
- Safeguards that still apply to administrators:
  - every action is recorded in the audit log (bypass ≠ invisible)
  - 2FA is mandatory for administrator accounts
  - the system must always keep at least one active administrator
  - data integrity (constraints, required fields, state transitions,
    accounting rules) still applies — the bypass skips permission checks only
- Optional later: a separate "Company Administrator" role with full access
  limited to their own companies.

### Permission features

- Roles/groups with inheritance; users can have many roles per company
- Model permissions: create, read, update, delete, export, import
- Field permissions: hidden / read-only per role
- Record rules (own, team, department, company, custom condition) — enforced by Shutro
- Action permissions: confirm, approve, cancel, post, etc.
- Menu & view visibility from the same permissions
- Amount/condition-based approval rules with multi-level approvers
- Admin UI to create and edit roles without code; audit log of permission changes
- Permission check API for UI hints, but **server is always the authority**

## View & reporting system

- One shared search layer (filters, group-by, favorites, saved & shared views) across all view types; switching views keeps filters
- View types: list, kanban, form, pivot, chart, calendar, gantt/timeline, map, hierarchy, cohort, spreadsheet, dashboard
- Views defined in TypeScript/JSON (never XML), inherited/extended by other modules
- Server-side pivot with GROUPING SETS / ROLLUP / CUBE; drill-down from any cell or chart point to records
- Period comparisons (vs last period, last year, budget)
- Export: Excel (formatted), CSV, PDF; scheduled reports by email
- Drag-and-drop PDF report designer
- Large data: virtualization, server pagination, materialized views, read replicas

## Communication hub

- Chatter on every record: comments, internal notes, @mentions, attachments, followers, change log (from Shutro audit), scheduled activities
- Internal chat: channels, DMs, threads, reactions, read receipts, typing, record cards
- Notifications: in-app, web push, mobile push, email, SMS, WhatsApp, Telegram
- Per-user, per-event, per-channel preferences; digests; delivery status tracking
- Provider adapters (SMS/email/WhatsApp) — switch providers without changing module code; fallback channels
- Inbound email routed into the right record's chatter
- Pipeline: transactional outbox → job queue → channel adapter, with retries and logs
- Later: voice/video via WebRTC (e.g. LiveKit)

## Robustness & performance

- Stateless app servers, horizontal scaling, graceful shutdown, health checks
- Idempotency keys on critical actions (confirm, post, pay)
- Rate limiting, circuit breakers for external providers
- Caching: metadata, permissions, HTTP, dashboard queries
- Performance budgets in CI (e.g. 10k-row list view < 300 ms API time)
- Backups with PostgreSQL point-in-time recovery documented

## Security

- Default deny; server-side enforcement on every endpoint
- CSRF protection, secure cookies, CSP headers, input validation on every route
- Audit log for logins, permission changes, exports and sensitive actions
- Secrets via environment/secret manager, never in code
- Dependency scanning, lockfiles, minimal dependencies

## Coding rules

- No business logic in React components; UI calls the API, the server decides
- Every API route generated or validated from schemas; OpenAPI always up to date
- Money is always Shutro `Decimal`; never JS `number`
- All UI text through i18n; all components accessible (keyboard, screen reader)
- Every UI component works in light and dark mode
- Justify every new dependency

## Workflow rules for Claude Code

1. **Design before code**: write `docs/rfcs/NNNN-name.md` for each subsystem and wait for approval.
2. Plan first, then implement in small steps; stop for review at the end of each step.
3. Run `pnpm typecheck`, `pnpm lint`, `pnpm test` (and E2E where relevant) before declaring done.
4. Small Conventional Commits.
5. Ask when requirements are ambiguous or conflict with these principles.
6. Update roadmap checkboxes when work is completed.

## Definition of done

- Typed end to end (server → OpenAPI → client → UI), no `any`
- Unit + integration tests (real PostgreSQL), E2E for user-facing flows
- Permission tests proving forbidden users are blocked at the server
- Works in English and Bangla, light and dark mode, desktop and mobile widths
- Documented with an example

## Roadmap

### Phase 0 — Design

- [x] RFC 0001 Module system & manifest
- [x] RFC 0002 Shutro integration & metadata → API generation
- [x] RFC 0003 Permission system
- [x] RFC 0004 View definitions & shared search layer
- [x] RFC 0005 Reporting engine
- [x] RFC 0006 Communication & notification architecture (jobs decided 2026-10-25; parts 6–7 accepted and implemented 2026-10-26)
- [x] RFC 0007 Frontend architecture & design system
- [x] RFC 0008 Default business apps (Settings, Accounting, Sales, Purchase, Projects) & App manager (install / disable / uninstall)
- [x] RFC 0010 Modern back-office: Phase A built (palette, shortcuts, toasts with Undo, pager, bulk actions, export, home page, PWA); Phase B done (live updates, notifications, offline, spreadsheet-grade lists, SMS/WhatsApp); C split into RFCs of its own
- [x] RFC 0011 Automation builder: the engine on the audit trail and outbox, the actions (incl. signed webhooks), date and schedule triggers, the run log, the rule editor with the condition builder, dry run and run-now (docs/automation.md); Studio ships rules in modules (RFC 0012); rules on any field through Shutro's change events (step 4, 2026-10-27)
- [x] RFC 0012 Kosh Studio: accepted; steps 1–5 done (the spec, the deterministic generator, `kosh studio build`; the App manager's upgrade, `kosh apps upgrade`, the Apps page's Upgrade; the Studio API with review, apply in write mode and patches in propose mode; Studio mode in the back-office: Add field in form sections, Add column on lists, new models with a menu in the Studio app, the review with the diff and the SQL; approval policies and automation rules in Studio modules, "Move into module" for rules of the Automation app; proposals as GitHub pull requests or GitLab merge requests; docs/studio.md)
- [x] RFC 0013 AI assistant: natural-language search ("Ask"), summaries and draft replies in the chatter (streamed), new records filled from a pasted text, a PDF or an image, with their lines ("Fill from a document"); as the user, proposals only, off per company, logged, budgeted (`@kosh/assistant`, docs/assistant.md)
- [x] RFC 0014 Data import: the import screen on every list (CSV / XLSX, mapping, check with every error on its row, updates by key and external id, lines, skip errors with the rejected rows, undo for 7 days, background runs with progress and a notification, saved mappings, module templates and sample workbooks; `@kosh/import`, docs/import.md)
- [x] RFC 0015 Customer and vendor portal: portal users of a contact with invitations, the server's internal-only guard, documents declared in manifests (record rule checked at start), the portal API with signatures, `sale_portal` / `account_portal` / `purchase_portal` / `project_portal`, email announcements, `apps/portal` (docs/portal.md)
- [ ] RFC 0016 Country localizations: accepted; step 1 done (several taxes per line with SD before VAT, bank accounts and payment details on invoices and in the portal, fiscal year start, amounts in words, lakh / crore grouping); step 2 done (withholding at payment: VDS / TDS proposed and posted, certificates); step 3 done (the `localization` declaration and its installer, `l10n_bd` with the chart, taxes, VDS / TDS, BIN / TIN, `kosh init --country`); step 4 done (Mushak 6.3 / 6.7 / 6.6 documents, the 6.1 / 6.2 registers and the 9.1 summary on screen, XLSX and PDF; docs/localizations.md); step 5 (India) parts 1–2 done (tax components split by place of supply, reverse charge, debit notes; `l10n_in` with GST, cess, GSTIN / PAN, HSN / SAC, TDS and the tax invoice; GSTR-1 with the portal JSON and GSTR-3B on screen, XLSX and PDF; e-invoicing and e-way bills behind a provider adapter, with the fake provider); next a real IRP adapter (with sandbox credentials) and the QR image

- [x] RFC 0017 Integrations platform: accepted (API keys and service accounts, OAuth 2.0 apps, outbound and inbound webhooks, online payments); step 1 done (API keys with scopes, service accounts, API keys in the user menu); step 2 done (outbound webhooks: the Integrations app, signed deliveries with retries, a log and replay; docs/integrations.md); step 3 done (inbound webhooks: endpoints declared by modules, switched on per company, verified, handled once per event id in a job, a log and replay); step 4 part 1 done (online payments: `payment` providers and transactions, Pay now in the portal, callbacks through inbound webhooks, the payment registered and reconciled once; the test provider); SSLCommerz, bKash, Razorpay and Stripe adapters done (SSLCommerz's IPNs confirmed with its validation API; bKash executed on the return; Razorpay's and Stripe's signed webhooks; all to verify on their real sandboxes); step 5 done (OAuth 2.0 apps: authorization code with PKCE, rotating refresh tokens with reuse detection, revocation, discovery, the consent page, Integrations › OAuth apps, Connected apps); RFC 0017 complete
- [x] RFC 0018 Workspace back-office: accepted (left sidebar, document-style record pages with a right rail, saved views as tabs, Today home, refreshed visual language); defects fixed on the way (lines on saved records, "Total Total", badge tones); step 1 done (tokens, the company's brand colour as the accent with Settings › Company, density, the status chip, the date field); step 2 done (the sidebar with apps and their sections, collapsible with Ctrl+B, a drawer on phones, the page bar); step 3 done (record pages: key facts, cards, read-first fields, the right rail with summary, details and timeline); step 4 done (saved views as tabs, the floating selection bar, records in a new tab, named empty states; the Today home with approvals, activities and mentions, recent records and saved views); RFC 0018 complete
- [x] RFC 0019 Settings: accepted (sections with search, people with invitations and roles per company, roles & permissions with a preview, companies and switching, security, your profile with sessions); step 1 done (the Settings overview with search, your profile with two-factor and signed-in devices, the company switcher and palette commands); step 2 done (People: invitations by email and link, roles per app and company, deactivation, two-factor reset, activity; People managers); step 3 done (Roles & permissions: roles in full, rights per model with code rights locked, permissions, record rules, the preview of who gains and loses what; "What can they do?"; Shutro's `securityAdmin.describe()`); step 4 part 1 done (Companies: the company's details from every installed app, the Companies page with switching and new companies set up by the apps' defaults); step 4 part 2 done (Security: two-factor for administrators or everyone, enforced by the server with a set-up page, the session lifetime, signed-in devices across people, the audit log filtered and exported); RFC 0019 complete
- [ ] RFC 0020 App settings: accepted (each app's settings declared in its manifest, one page per app, history, copy between companies, export / import, numbering through Shutro request #31); step 1 done (the declaration checked at start, company fields and installation values, the API with editors and audit, Settings › App settings with Changed / Reset; Sales, Purchase and Accounting sections; docs/modules.md); next history, copy and export (step 2)
- [ ] RFC 0021 Business apps, part 2: accepted (Stockroom, Production, Agenda, Workforce, Trade Finance, Sites, Hiring, Asset Care, Event Hub, Focus, Pipeline, Counter — names of their own, each further than Odoo's); Focus step 1 done (to-dos and shared lists with checklists, privacy by record rules, board / list / calendar, on the home page); Agenda step 1 done (events with attendees and answers, rooms never double-booked, private events as busy, free / busy, the default length setting, today's meetings on the home page); Pipeline step 1 done (deals on a board, stage rules, won by stage and lost with a reason, duplicates, the weighted forecast); Workforce step 1 done (employees and the org chart, contracts, leave by working days with the balance, no overlap and decisions never by the requester; personal data for HR only); Hiring step 1 done (openings with a headcount, applicants on a board, independent scorecards, hire in one step into Workforce, the filled opening closed); Stockroom step 1 done (warehouses and locations, transfers with one status, reservations that say what they are for, exact units, never below zero); Stockroom step 2 part 1 done (`sale_stock` and `purchase_stock`: each confirmed order's delivery or receipt, once, delivered / received on the order); part 2 done (done quantities, partial validation with backorders that stay with their orders); part 3 done (counts listed with what is expected, scanned from a phone, applied by managers through adjustment transfers); part 4 done (lots and serial numbers: tracked per product, listed on receipts, first expiry first out, each lot's history; step 2 complete); step 3 part 1 done (`stock_account`: average cost or FIFO, each transfer posted at once, the value equal to the Inventory account); part 2 done (`purchase_stock_account`: receipts at the order's price, bills clearing Goods received not billed, price differences); Stockroom complete; Production step 1 done (bills of materials with versions and effective dates, work centres, orders showing what is short and the cost roll-up before they start, made through Stockroom); step 2 part 1 done (`mrp_account`: made at what it consumed plus its operations, Work in progress cleared); part 2 done (by-products with their share of the cost, scrap with reasons through Stockroom); part 3 done (work orders scheduled forward at the work centres, the Gantt, capacity by day); Production complete; Asset Care step 1 done (equipment with meters and warranty, preventive plans by time or meter with checklists, breakdowns and downtime, reliability); next Asset Care step 2 or Trade Finance

### Phase 1 — Server foundation

- [x] Monorepo, CI, Docker dev environment (PostgreSQL, Valkey, MinIO, Mailpit) (S3 storage via SeaweedFS: MinIO's free images are no longer published)
- [x] Fastify server, module loader, request environment for Shutro
- [x] Auth (sessions, 2FA), users, companies
- [x] Auto-generated REST + OpenAPI + typed client (`kosh generate client`; checked in CI)

### Phase 2 — Permissions

- [x] Roles, ACL, field security, action permissions, approvals, admin UI APIs (`@kosh/permissions`, docs/permissions.md)

### Phase 3 — UI foundation

- [x] App shell, design system, menus, i18n, themes (docs/ui.md)
- [x] Shared search layer; list, form, kanban views (Playwright E2E)

### Phase 4 — Reporting

- [x] Pivot, chart, calendar, gantt, map, hierarchy, cohort, dashboard (+ spreadsheet; docs/reporting.md)
- [x] Exports, scheduled reports, PDF designer

### Phase 5 — Communication

- [x] Chatter, activities, real-time gateway (`@kosh/realtime`: live lists, forms and presence; docs/ui.md)
- [x] Notifications + provider adapters (email, SMS, WhatsApp, push): in-app inbox, bell, email, web push, and SMS / WhatsApp through Twilio (opt-in per user and kind; a `Messenger` adapter for other providers; a Twilio account to run it) — `@kosh/notify`, `@kosh/mail`; fallback channels, daily digests and quiet hours with the settings dialog (RFC 0006 part 8, 2026-10-27)
- [x] Internal chat (RFC 0006 part 6: channels / groups / directs, threads, reactions, the Chat app and its dock) and inbound email (part 7: signed reply addresses, the webhook for Postmark / Mailgun / raw, the IMAP poller, catch-all aliases, bounces, the quarantine page), 2026-10-26

### Phase 6 — Proof

- [x] App manager step 1: installed set, `kosh apps` install / disable / enable in one transaction (RFC 0008, docs/modules.md)
- [x] App manager step 2: apps API, hot reload across nodes (app host), Settings app with the Apps page
- [x] Business apps, part 1 (modules/): Contacts, Products (units, VAT), Sales, Purchase with approvals (RFC 0008 §8 steps 3–4)
- [x] Business apps, part 2: Accounting (RFC 0009 steps 1–4: the ledger core, invoices / bills / credit notes with taxes and approvals, the `sale_account` and `purchase_account` bridges, payments and reconciliation with exchange differences, the reports, year closing and the accounting screens), Projects (projects, tasks on a kanban of stages, timesheets) and `sale_project` (tasks and projects from a confirmed order, through the outbox)
- [x] `kosh init` default set (Contacts, Products, Sales, Purchase, Accounting with their bridges; RFC 0008 step 7) and the business apps' E2E catalogue (`apps/web/e2e-apps`)
- [x] Demo data (RFC 0008 §5.8): `hooks.demo` seeders in every business app and bridge, `installDemo`, `kosh init --demo`, `pnpm demo` (apps/demo); Inventory stays out of version 1
- [x] Performance benchmarks vs Odoo-like workloads (`pnpm bench`: `apps/demo/bench` measures the App manager targets of RFC 0008 §5.7 and the order list, search, form, confirm, invoice post, trial balance and aging budgets on 10k orders and 1k invoices; `packages/reporting/bench` the 1M-row pivot, export and list pages)
