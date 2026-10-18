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
- Auth: Better Auth (sessions, 2FA, OAuth/SSO, passkeys) or a justified alternative
- Jobs & scheduler: pg-boss (PostgreSQL) — BullMQ only if an RFC justifies Redis queues
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
- PWA first; React Native (Expo) later. Public portal/website later in Next.js.

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
apps/
  web/           # back-office SPA
  demo/          # demo ERP: base, contacts, product, purchase, inventory, sales
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
- [ ] RFC 0003 Permission system
- [ ] RFC 0004 View definitions & shared search layer
- [ ] RFC 0005 Reporting engine
- [ ] RFC 0006 Communication & notification architecture
- [ ] RFC 0007 Frontend architecture & design system

### Phase 1 — Server foundation

- [ ] Monorepo, CI, Docker dev environment (PostgreSQL, Valkey, MinIO, Mailpit)
- [ ] Fastify server, module loader, request environment for Shutro
- [ ] Auth (sessions, 2FA), users, companies
- [ ] Auto-generated REST + OpenAPI + typed client

### Phase 2 — Permissions

- [ ] Roles, ACL, field security, action permissions, approvals, admin UI APIs

### Phase 3 — UI foundation

- [ ] App shell, design system, menus, i18n, themes
- [ ] Shared search layer; list, form, kanban views

### Phase 4 — Reporting

- [ ] Pivot, chart, calendar, gantt, map, hierarchy, cohort, dashboard
- [ ] Exports, scheduled reports, PDF designer

### Phase 5 — Communication

- [ ] Chatter, activities, real-time gateway
- [ ] Notifications + provider adapters (email, SMS, WhatsApp, push)
- [ ] Internal chat; inbound email

### Phase 6 — Proof

- [ ] Demo modules: base, contacts, product, purchase (with approvals), inventory, sales
- [ ] Performance benchmarks vs Odoo-like workloads
