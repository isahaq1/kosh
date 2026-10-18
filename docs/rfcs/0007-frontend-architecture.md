# RFC 0007: Frontend architecture & design system

- **Status:** Accepted (2026-10-18), implemented in `@kosh/ui` and `apps/web` (docs/ui.md)
- **Depends on:** 0001, 0002, 0004, 0005, 0006

## 1. Summary

One React + Vite single-page app (`apps/web`) composed at build time from the installed modules' frontend
contributions, with TanStack Router (typed routes from menus and actions) and TanStack Query (server state over the
generated typed client), a design system (`packages/ui`) on shadcn/ui + Radix + Tailwind with light/dark themes and
RTL, i18next (English and Bangla first), and a view-renderer registry that renders RFC 0004/0005 view definitions.

## 2. Problem

The client must render metadata-driven views fast (large lists, live updates), stay accessible and localized, look
consistent across modules from different authors, and let modules add custom screens without forking the app.

## 3. How Odoo does it, and its weaknesses

OWL (Odoo's own framework), XML QWeb templates, asset bundles concatenated per module, a client-side registry of
fields/views/actions, Bootstrap-based styles.

- **Proprietary framework:** small ecosystem, few developers, limited tooling and type safety.
- **Assets assembled at runtime** per database; debugging and caching are painful.
- **Patching by `patch()`** on prototypes is hard to trace.
- **RTL and dark mode** are partial; accessibility varies by widget.

## 4. Options

| | A. Build-time composition of module packages | B. Runtime module federation per database | C. Server-rendered (HTMX-style) |
| --- | --- | --- | --- |
| Type safety across modules | Full | Partial (remote boundaries) | Low |
| Different module sets per tenant | One build per distribution; inactive modules hidden by permissions/installation | Native | Native |
| Performance / caching | Best (one bundle graph, code splitting per app) | Good | Good |
| Complexity | Low | High | Medium, weak for rich views |

## 5. Recommendation: A (B evaluated later for marketplace modules)

- Each module may ship `web/` entry code: view renderers, field widgets, custom components, routes, translations.
  The build collects the contributions of the distribution's modules into a registry; installed state and
  permissions decide what is visible per database and user (RFC 0001, 0003). Apps are code-split.
- **Design system** (`packages/ui`): tokens (color, spacing, radius, typography) with light/dark themes, logical CSS
  properties for RTL, shadcn/ui components on Radix primitives (focus management, keyboard, ARIA), data-dense ERP
  components (virtualized grid, numeric inputs for Money and Decimal strings, date ranges, many2one autocomplete).
- **Data**: the generated typed client (RFC 0002) through TanStack Query; optimistic updates only where the server
  can reject cleanly (compare-and-set → refetch on `412`); realtime invalidation from the WebSocket gateway (RFC 0006).
- **Routing**: TanStack Router with typed routes generated from menus/actions (`/purchase/orders/:id`); deep links
  carry search-layer state (filters, grouping) in the URL.
- **Views**: renderers for list (virtualized, inline edit, grouping, totals), form, kanban (drag-and-drop with
  transitions), and RFC 0005 views; each renderer consumes view JSON plus user metadata; custom React components
  replace nodes or whole views (RFC 0004).
- **i18n**: i18next namespaces per module, ICU messages, `bn_BD` with Bengali digits optional, number/date/currency
  formatting via `Intl` from the user's lang and tz; module translations shipped with the module.
- **Quality**: Playwright E2E per module (generated smoke tests per action), axe accessibility checks, visual
  regression for the design system, performance budgets (first interaction, list of 10k rows scrolling at 60 fps).

## 6. Purchase with approvals

The Purchase app appears for users with a purchase access level; the order form renders the RFC 0004 definition with
the approvals module's panel (a React component) after the main group; approvers get a kanban by approval state with
drag-and-drop calling the `approve` transition; Bangla users see labels, numbers and dates localized, with the layout
unchanged (Bangla is left-to-right; RTL support is verified with Arabic for future markets).

## 7. Open questions

- Offline/mobile: a PWA with background sync over the batch endpoint (RFC 0002 §8), or native apps later.

## Alignment with CLAUDE.md

- The app shell, design system and view renderers live in `packages/ui`; `apps/web` composes them with the modules.
- Stack additions from CLAUDE.md: TanStack Table + Virtual + Form, dnd-kit for drag and drop, PWA first.

## Implementation notes (2026-10-18)

- Built: the shell (launcher, menus, company, language, theme), TanStack Router routes from apps / menus / actions
  with the search state in the URL, TanStack Query over the API, the design system (Tailwind v4 tokens, light /
  dark, logical properties for RTL, Radix primitives), i18next (English, Bangla, Arabic), and the list (TanStack
  Table + Virtual), form and kanban (dnd-kit) renderers with a registry for views, widgets and components.
- The renderers use a dynamic API client (`createKoshApi`), since their models are known only at runtime; business
  code uses the generated typed client. Both speak the same REST API and sessions.
- TanStack Form is not used: the metadata-driven form keeps its own small state (changes, onchange, compare-and-set,
  x2many commands); TanStack Form fits hand-written screens and can be added with them.
- Module web contributions are package entries (`@kosh/permissions/web`) registered by the app at build time.
- Not yet: code splitting per app, the 10k-row scrolling budget in CI (with the RFC 0005 benchmarks), PWA, visual
  regression for the design system.
