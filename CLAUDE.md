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
- [ ] RFC 0020 App settings: accepted (each app's settings declared in its manifest, one page per app, history, copy between companies, export / import, numbering through Shutro request #31); step 1 done (the declaration checked at start, company fields and installation values, the API with editors and audit, Settings › App settings with Changed / Reset; Sales, Purchase and Accounting sections; docs/modules.md); step 2 done (history per setting from the audit log, copy to another company and export / import as JSON, each previewed and audited; Contacts and Projects sections enforced by constraints); next Numbering (step 3, Shutro request #31)
- [x] RFC 0022 App depth and polish: accepted 2026-10-31 (platform pieces every app inherits, then one pass per app); step 1 part 3.1 done (related records as stat tiles on record pages: `k.stats`, tiles appended by other modules, computed as the user, a click opens the filtered list; on contacts, sales and purchase orders); part 3.2 done (app overviews declared in the manifest — KPIs with their change, charts, pivots, top records —, installed as a keyed dashboard, the app's first menu; Sales first); part 3.3 done (widgets: email / phone / url links, progress, percentage, rating and priority as stars, colour, days left, tags, image and avatar as attachments with browser-made 256 px thumbnails served by `?w=`; kanban cards with a cover, an avatar, a progress bar and a tinted edge; list row decorations by tone; contacts' photos and links, products' pictures, Pipeline's stars and tints); part 3.4 done (guidance: `GET …/:id/next` runs the transitions' guards read-only, the next-step banner with the button or what blocks it, field help from the model, section descriptions, the required-field checklist in the rail); part 3.5 done (columns resized by drag or keyboard and pinned, per user; lists printed as PDF; the Print menu of a record's templates on every form); step 1 complete; step 2 Contacts done (tags, the board with photos and tags, the map with coordinates, the overview); Products done (the overview; sold, bought and on hand tiles from Sales, Purchase and Stockroom); Sales and Purchase done (margins on lines and orders, calendars of expiring quotations and expected arrivals, the Purchase overview); Accounting done (the overview with receivable, payable and who owes most; invoices' due dates as days left, rows toned by payment, payments as tiles); Projects and Pipeline done (overviews, project tiles, the task board with avatars and stars, the projects timeline, the funnel and forecast, website submissions on deals); Workforce, Hiring and Stockroom done (overviews, tiles on employees and openings, boards with avatars and tints, ratings as stars, dates as days left, rows toned); Production, Asset Care, Trade Finance, Event Hub, Sites, Focus and Agenda done (overviews); step 2 complete; step 3 done (overview cards hidden per person, `requiredWhen` on field nodes); RFC 0022 complete
- [x] RFC 0024 Business apps, part 3: accepted 2026-11-01 (Spend, Attendance, Payroll with Bangladesh rules, Helpdesk, cost centres with fixed assets and budgets, replenishment and routes, Shop with couriers, Documents and Sign — each further than Odoo's); step 1 done (Spend: categories with policies enforced at submission, receipts, reports with approvals and a beyond-policy level, duplicates flagged, cash advances settled by reports; `expense_account`: reports booked and reimbursed, advances paid out and returned); step 2 done (Attendance: shifts and rosters, check-in by phone inside a geofence, kiosk by badge or PIN, ZKTeco / CSV import, days with lateness and overtime in steps, approved for Payroll); step 3 part 1 done (the Payroll engine: rules in a safe formula language, parameters and slab tables as data, runs with explained payslips, approved attendance, inputs, loans, year-to-date, corrections, bank and bKash / Nagad files; `payroll_account`); step 3 part 2 done (`l10n_bd_payroll`: standard and garments structures, overtime, festival bonuses, provident fund, income tax at source from the year's projection and slabs, all as data to verify; per-person values, the festival flag and running totals in the engine); step 4 done (Helpdesk: tickets from email with the sender as the customer, SLA policies in business hours with the clock paused while waiting and resumed on the customer's reply, assignment in turn or by load, merging, canned replies, a one-time rating link); step 5 part 1 done (cost centres on journal lines; `account_asset`: assets from posted bills or by hand, boards by straight line, declining balance or units, posted once each, disposal and sale with the gain or loss, revaluation and impairment, a tax book beside the accounting book); step 5 part 2 done (`account_budget`: lines by cost centre and account, actual and committed from purchase orders not billed, purchase orders beyond a warn line approved by an Accounting manager and beyond a block line refused; cost centres on purchase lines carried onto bills); step 6 part 1 done (reorder rules with the forecast explained in words, the Replenishment screen, ordered by transfer, request for quotation or production order, automatically or by hand, snoozed; purchase orders delivered to a warehouse); step 6 part 2 done (receipts and deliveries in one, two or three steps, putaway rules, make to order through the rules, dropship with its request for quotation and no stock); step 7 part 1 done (the Shop: published products in English and Bangla, delivery methods with fees by zone or weight, a cart by token priced by the server, checkout with cash on delivery within a limit or paid online — confirmed, invoiced and paid once —, a public API like Sites'); step 7 part 2a done (couriers behind adapters with the test courier, shipments drafted once per confirmed order, booked, tracked to delivery with the cash collected and followed by the customer's token; `website_sale_stock`: in stock / few left / out of stock, carts kept within stock); step 7 part 2b done (coupons — a percentage, an amount or free delivery, minimums, dates, use limits, once per customer —; one reminder for a cart left with an email, with a recovery code; search titles and the sitemap; product pictures served publicly); step 8 part 1 done (Documents: folders open or for their members, documents with tags and versions, one search with every record's files, share links with an expiry and a password, requests by email with an upload link, reminded once); step 8 part 2 done (Sign: templates with fields per role, signers in order or at once with links and one-time codes, signing on the page with a drawn signature, refusals, the PDF sealed with pdf-lib — values stamped, a certificate page, its hashes — stored in Documents and on the record); RFC 0024 complete
- [x] RFC 0025 Approvals, an app of its own: accepted 2026-11-04 (the engine and the app first, then deadlines, delegation and decisions from email, then generic requests); step 1 done (approvers by role, named people, the requester's manager or a person on the record, falling back to the role; quorum — any, all or a number — with each vote kept; send back for changes with rounds; reasons required; withdraw by the requester); step 2 done (the Approvals app: the inbox as cards with the record, the requester, the time waited and the steps, approving many at once, the keyboard, a header with the figures; my requests with withdraw; what I decided; the record's panel as steps in English and Bangla; policies on screen for Approvals managers); step 3 done (deadlines per level with a reminder at half and escalation to a role once late; Away: delegates deciding in their own name for the absent; each turn's approvers emailed a one-time link to a confirmation page that decides as them, audited with the address); step 4 done (generic requests: categories with the fields they ask for, each with its own policy scoped by a policy condition, deciders who read the request, outcomes through hooks — `approvals_purchase` makes requests for quotation —; the policy preview); RFC 0025 complete
- [x] RFC 0029 Accounting in depth: accepted 2026-11-07 (bank statements and reconciliation rules, sending documents, follow-ups, fiscal positions); step 1 done (statements from CSV, OFX, CAMT.053 or a bank feed, each line matched with an explained proposal or written off, the Reconcile bank page); step 2 done (reconciliation rules — match, write off or suggest — run on import and on demand, counted and audited, a dry run with the hit rate, every match undone); step 3 done (Send on invoices, quotations and purchase orders: email templates per language, the PDF on the chatter and in the email, sent once through the outbox; Email › Sent and Email templates; Send by email from a list's selection; invoices emailed by themselves when posted, per customer); step 4 done (payment follow-ups: levels by days overdue with email, SMS and WhatsApp, one reminder a day per customer with the portal links, noted on the invoices, pause with a promise, Send now, sales stopped at the final level; Accounting › Follow-ups); step 5 done (fiscal positions mapping taxes and accounts, chosen on the document, the contact or by country, state and tax number; accounts from the product, its category, the contact and the company; the When confirmed preview on drafts); RFC 0029 complete
- [ ] RFC 0030 Products in depth: accepted 2026-11-08 (vendor prices, returns, landed costs, variants); step 1 done (vendor prices with breaks, dates, lead days and the preferred vendor, purchase lines priced by them with why, buying rules choosing the cheapest vendor that arrives in time and saying so, vendor scorecards); step 2 part 1 done (returns of deliveries and receipts: partial, linked, with a reason, lots taken back, valued at the original cost, delivered and received quantities net of returns, Stockroom › Returns); part 2 done (returned quantities on order lines, Credit note for returns and Vendor refund for returns, credited once at the line's price); step 3 done (landed costs: split by quantity, weight, volume, value or equally, previewed, posted once — on hand to stock and the average cost, sold to cost of sales —, drafted from a vendor bill); next variants (step 4)
- [ ] RFC 0031 Production in depth: accepted 2026-11-08 (explain popovers, formulas and packaging BOMs, plans with forecast and capacity, schedules and two-stage production, overheads — any product, any unit); step 1 done (Developer mode for administrators and developers: every field label, list column, button, tile and page title explains itself in a dark popover — type, relation with its link, rules, computed from what, the module —, relations in and out of each model); next formulas and packaging BOMs (step 2)
- [ ] RFC 0032 Requests, Workforce for groups, Stockroom for depots, procurement: accepted 2026-11-08 (indents, pg_employee, the depot screens of inventory-bs23, the procurement chain of purchase-bs — requests, RFQs to many vendors, comparative statements); step 1 done (Requests: indents approved by the department head and product group approvers, issued by transfers to internal use, still owed per line, acknowledged); step 2 done (transfer indents: Stock Transfer Notes into each warehouse's transit, Stock Receive Notes for what was shipped, partial receipts, shortages written off with the reason); next Workforce (step 3)
- [x] RFC 0028 The commercial core: accepted 2026-11-07 (price lists, credit control, invoicing by what was delivered, deals to quotations, quotation templates); step 1 done (price lists with rules by product, category, quantity and dates, formulas and lists on lists, on customers, orders, the Shop and Counter, each line saying why; typed prices kept, under a permission); step 2 done (credit limits with warn, refuse or an approval through the Approvals engine; payment terms and invoice and delivery addresses on orders, carried to the invoice); step 3 part 1 done (invoice policies by ordered or delivered quantity, invoiced quantities per line, several invoices per order, down payments deducted on the next invoice); step 3 part 2 done (bills by received quantity, several bills per order, the ordered / received / billed check on each bill line); step 4 done (`sale_crm`: New quotation on a deal, the deal won when a quotation is confirmed and lost when every one is cancelled; form buttons that open a filled new record); step 5 part 1 done (quotation templates with lines and optional products, Fill from template, options added as lines once); step 5 part 2 done (customers add optional products in the portal before signing; portal documents may offer options); RFC 0028 complete
- [x] RFC 0027 Approvals matrix (beyond Paragon's `dynamic_approval`): accepted 2026-11-07; step 1 done (approvers by department head, department approvers and the record — Purchase by product category —, extra people on any level, refusing with the reason or skipping when nobody can decide, how the approvers were found, the log, deadlines from each level's turn; docs/approvals.md); step 2 done (backups who decide and are told, approvals already given counted once, reassignment by Approvals managers with a reason, waiting requests in step with their level and "Sync waiting requests"; Shutro 0.3.5 for many-to-many-only change events, request #35); step 3 done (segments of companies, policies by company, companies and segment, the companies covered in the preview); step 4 done (the Matrix page: cards per policy for my decisions and for others over a period, time per level and bottlenecks for managers); RFC 0027 complete
- [x] RFC 0026 Projects for programmes: accepted 2026-11-04 (structure, plans with approvals and a baseline, team and workload, money through Accounting and health, schedule and control — at least the `poultry_project` addon); step 1 done (project types, task categories and tags; the project's code, type, sponsor, owner, priority, risk, scope; programmes; phases and work packages; sub-tasks, several assignees, milestones and dependencies that block; progress computed from planned hours; the structure tree); step 2 done (plans with their case, approved by the sponsor and managers through the Approvals engine, started into a project with the baseline, days late against it, the baseline moved by managers only, the company may require a plan); step 3 done (teams with roles, allocation, hourly costs for managers only, over-allocation flagged before saving, the Workload heat map, labour cost from timesheets); step 4 done (budget lines; actual, committed and left in the budget; `project_account` with each project's cost centre and booked costs, `project_purchase` with committed orders; health from schedule, milestones and cost with thresholds and a manager's override with its reason; the overview by health); step 5 done (risks, issues, change requests approved and applied to the baseline, weekly status reports on the chatter; the schedule with the critical path, baselines and dependency arrows, waiting tasks moved after a slip, repeating tasks); RFC 0026 complete
- [x] RFC 0023 The module standard: accepted 2026-10-31 (one checked standard for every module — search specs, archive not delete, chatter on documents, lists and forms, print and import templates, named events, Bangla labels, Duplicate — enforced by `pnpm check:modules` in `pnpm lint` with waivers in the manifest); step 1 done (the checker; search specs, archivable masters, chatter on every document, lists and forms across the 41 modules); step 2 done (a print template for every document — P1 enforced —, and P2: shipped templates bind fields that exist, which found an empty Attendance register); step 3 done (an import template for every master and document — I1 enforced, records only the system makes waived —, and I2: every column a field the importer accepts); step 4 done (a named event for every document — E1 enforced, `emitting()` —, Duplicate on every record from the form and the API); step 5 done (metadata served in the request's language from module dictionaries, `pnpm i18n:extract`, Bangla for every module — T1 enforced); step 6 done (help on every state, selection and computed amount — M5 —, an overview and demo data for every app — A1 —; every rule enforced by `pnpm lint`); RFC 0023 complete
- [ ] RFC 0021 Business apps, part 2: accepted (Stockroom, Production, Agenda, Workforce, Trade Finance, Sites, Hiring, Asset Care, Event Hub, Focus, Pipeline, Counter — names of their own, each further than Odoo's); Focus step 1 done (to-dos and shared lists with checklists, privacy by record rules, board / list / calendar, on the home page); Agenda step 1 done (events with attendees and answers, rooms never double-booked, private events as busy, free / busy, the default length setting, today's meetings on the home page); Pipeline step 1 done (deals on a board, stage rules, won by stage and lost with a reason, duplicates, the weighted forecast); Workforce step 1 done (employees and the org chart, contracts, leave by working days with the balance, no overlap and decisions never by the requester; personal data for HR only); Hiring step 1 done (openings with a headcount, applicants on a board, independent scorecards, hire in one step into Workforce, the filled opening closed); Stockroom step 1 done (warehouses and locations, transfers with one status, reservations that say what they are for, exact units, never below zero); Stockroom step 2 part 1 done (`sale_stock` and `purchase_stock`: each confirmed order's delivery or receipt, once, delivered / received on the order); part 2 done (done quantities, partial validation with backorders that stay with their orders); part 3 done (counts listed with what is expected, scanned from a phone, applied by managers through adjustment transfers); part 4 done (lots and serial numbers: tracked per product, listed on receipts, first expiry first out, each lot's history; step 2 complete); step 3 part 1 done (`stock_account`: average cost or FIFO, each transfer posted at once, the value equal to the Inventory account); part 2 done (`purchase_stock_account`: receipts at the order's price, bills clearing Goods received not billed, price differences); Stockroom complete; Production step 1 done (bills of materials with versions and effective dates, work centres, orders showing what is short and the cost roll-up before they start, made through Stockroom); step 2 part 1 done (`mrp_account`: made at what it consumed plus its operations, Work in progress cleared); part 2 done (by-products with their share of the cost, scrap with reasons through Stockroom); part 3 done (work orders scheduled forward at the work centres, the Gantt, capacity by day); Production complete; Asset Care step 1 done (equipment with meters and warranty, preventive plans by time or meter with checklists, breakdowns and downtime, reliability); step 2 done (`maintenance_stock`: spare parts reserved and consumed, labour cost, the plans' calendar); Asset Care complete; Trade Finance step 1 done (import and export LCs with tolerance and usance, amendments applied once accepted, presentations with discrepancies and maturities, bank limits, alerts); step 2 done (`trade_finance_account`: margins posted and released, payments against payables and receivables, bank charges expensed); step 3 done (shipments against an LC, LCs from purchase and sales orders); Trade Finance complete; Event Hub step 1 done (events with sessions and tickets, seats per event and ticket, waiting lists in order, check-in once by code); step 2 done (tickets and badges with a QR — the `qr` block of document layouts —, check-in at the door by scanner, keyboard or camera); step 3 done (confirmation and thanks emails, once, in English or Bangla; `event_account`: paid places invoiced); Event Hub complete; Sites step 1 done (pages from blocks with a live preview, English and Bangla with translations, forms that create contacts with a honeypot, the public API without a sign-in, rate limited and cached); `website_crm` done (forms that create Pipeline deals); Counter step 1 done (shops, methods, sessions with counts, sales with split payments and the change accepted once per device reference, the register page, the receipt); Counter step 2 done (sales queued offline and replayed once, one posted entry per closed session, receipts by email and text, `pos_stock`: one delivery per session); Counter step 3 done (refunds with a reason, linked and netted in the books, cashiers in their own session and managers anywhere; typed quantities for weighed goods); Counter step 4 part 1 done (the shop decides its receipt; `l10n_bd_pos`: Mushak 6.3 receipts at the till with the BIN, each line's VAT and the amount in words); next providers at the counter (push / QR flow)

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
- [x] App manager step 3: uninstall with its data (RFC 0008 §5.4): the cascade and what is deleted with its rows, modules may refuse, the name typed back and an authenticator code, a 30-day snapshot, records, groups and role grants removed, in one transaction (Settings › Apps, `shutro-erp apps uninstall --remove-data`)
- [x] Business apps, part 1 (modules/): Contacts, Products (units, VAT), Sales, Purchase with approvals (RFC 0008 §8 steps 3–4)
- [x] Business apps, part 2: Accounting (RFC 0009 steps 1–4: the ledger core, invoices / bills / credit notes with taxes and approvals, the `sale_account` and `purchase_account` bridges, payments and reconciliation with exchange differences, the reports, year closing and the accounting screens), Projects (projects, tasks on a kanban of stages, timesheets) and `sale_project` (tasks and projects from a confirmed order, through the outbox)
- [x] `kosh init` default set (Contacts, Products, Sales, Purchase, Accounting with their bridges; RFC 0008 step 7) and the business apps' E2E catalogue (`apps/web/e2e-apps`)
- [x] Demo data (RFC 0008 §5.8): `hooks.demo` seeders in every business app and bridge, `installDemo`, `kosh init --demo`, `pnpm demo` (apps/demo); Inventory stays out of version 1
- [x] Performance benchmarks vs Odoo-like workloads (`pnpm bench`: `apps/demo/bench` measures the App manager targets of RFC 0008 §5.7 and the order list, search, form, confirm, invoice post, trial balance and aging budgets on 10k orders and 1k invoices; `packages/reporting/bench` the 1M-row pivot, export and list pages)
