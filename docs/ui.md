# Views and UI

Screens are data (RFC 0004): modules declare views, actions and searches in their manifests; the server checks them
against the models when it starts and serves them per user; `@kosh/ui` renders them (RFC 0007). Custom React code
plugs in by name where metadata is not enough.

## Declaring views

```ts
import { action, form, kanban, list, search } from '@kosh/views';

export const purchase = defineModule({
  // ...
  actions: { 'purchase.action_orders': action(PurchaseOrder, { label: 'Purchase orders', views: ['list', 'kanban', 'form'] }) },
  views: {
    'purchase.order.list': list(PurchaseOrder, {
      columns: ['name', 'vendor', { field: 'amountTotal', sum: true }, { field: 'state', widget: 'badge' }],
      defaultOrder: ['name asc'],
      inlineEdit: ['vendor'],
    }),
    'purchase.order.kanban': kanban(PurchaseOrder, { groupBy: 'state', card: { title: 'name', subtitle: 'vendor' } }),
    'purchase.order.form': form(PurchaseOrder, (f) => ({
      header: { statusbar: 'state', buttons: [f.button('submit', { primary: true, label: 'Submit' })] },
      sheet: [
        f.group('main', ['name', 'vendor', { field: 'amountTotal', widget: 'money' }]),
        f.notebook('tabs', [f.page('lines', 'Lines', [f.lines('lines', ['product', 'quantity', 'priceUnit'])])]),
      ],
      readonlyWhen: { state: { notIn: ['draft'] } },
    })),
  },
  search: {
    'purchase.order': search(PurchaseOrder, {
      fields: ['name', 'vendor.name'],
      filters: { toApprove: { label: 'To approve', domain: { state: 'submitted' } } },
      groupBy: ['state', 'vendor', 'dateOrder:month'],
    }),
  },
});
```

- Field keys are **compile-time checked** against the model handle (`list(PurchaseOrder, { columns: ['nmae'] })` is a
  type error). Transitions, relation paths, line columns, group-by fields and view ids are checked **when the server
  starts**: a broken view stops the server, it never breaks a screen.
- `readonlyWhen` / `visibleWhen` are Shutro domains. The browser evaluates the ones it can (the record's own values;
  `holds()` / `evaluate()` in `@kosh/views`); the server re-checks every write anyway.
- Every node has an id (fields: their key; groups, pages, buttons: the id given), the anchor for extensions.

## Extending another module's view

```ts
viewExtensions: [{
  view: 'purchase.order.form',
  operations: [
    { insertAfter: 'main', nodes: [{ kind: 'component', id: 'approval_panel', component: 'approvals.Panel' }] },
    { setAttrs: 'vendor', attrs: { label: 'Supplier' } },
    { remove: 'notes' },
  ],
}],
```

Operations: `insertAfter`, `insertBefore`, `append` (into a group or page), `replace`, `remove`, `setAttrs`. They
apply in module dependency order; an unknown anchor or a duplicate id fails at startup. `resolveView()` records the
module behind every node and the chain of modules that changed the view.

## What the server serves

`GET /api/v1/views/:id` (or `?model=&type=`) returns the view **for the user**: fields they may not read are
removed, field metadata says what they may not write, header buttons for transitions they may not run (model write
access, the transition's `requires` permission) are dropped. Also the field metadata (kinds, labels, options,
targets), the transitions with their source and target states, the allowed operations and the onchange fields.
`GET /api/v1/search/:model` merges every module's search definition and drops options on unreadable fields.
`GET /api/v1/models/:model/names?q=` / `?ids=` is the name search for many2one pickers and display names.

## Search

`@kosh/search` compiles a search state (text facets, filters, group-by, order, a custom domain) to one Shutro domain
and grouping, used by every view: values of one field OR, filters of the same `group` OR, everything else AND; the
action's `domain` always applies; LIKE wildcards typed by users are literal. The state round-trips through the URL
(`?q=`), so deep links, the back button and saved searches work. Favorites are `kosh.saved_view` records, private
or shared, governed by record rules.

## The app

```tsx
import { registerPermissionsWeb } from '@kosh/permissions/web';
import { createDefaultRegistry, createKoshApi, KoshApp } from '@kosh/ui';

const registry = createDefaultRegistry();
registerPermissionsWeb(registry); // each module's web contribution
createRoot(root).render(<KoshApp api={createKoshApi()} registry={registry} />);
```

- Routes: `/login`, `/` (apps), `/:app`, `/:app/a/:action` (list / kanban, `?view=` and `?q=`),
  `/:app/a/:action/:id` (form, `new`). Apps and menus come from the server, filtered per user.
- **Renderers are registered by name**: `registerView('list' | 'kanban' | 'form' | name, Component)`,
  `registerWidget(name or field kind, Component)`, `registerComponent('module.Name', Component)`. Registering an
  existing name throws unless `{ replace: true }`; a view with `component: 'x'` uses the renderer registered as `x`.
- Node components receive the record, the model, the served view, the API, the record `version` (refetch with it)
  and `reload()`.
- **Client actions** open a page instead of a model's views, for screens such as Settings → Apps. The action is
  `{ type: 'client', page: 'settings.Apps', label: 'Apps' }`, and the page is registered with
  `registry.registerPage('settings.Apps', Component)`. Pages receive the API and the action's label, and call their
  module's routes, which check access again. Menus show client actions like any other action.
- App icons: `AppIcon` maps a manifest's `app.icon` (Lucide names: `book`, `wallet`, `shopping-cart`, ...) to an
  icon, in the launcher and the App manager.
- The list virtualizes rows (TanStack Virtual), orders and pages on the server, shows totals for `sum` columns,
  groups one level (expandable), and edits `inlineEdit` columns with compare-and-set. The form runs onchange,
  saves with `If-Match` (a record changed by someone else asks for a reload instead of overwriting), edits lines
  as Shutro x2many commands. The kanban moves cards by drag-and-drop (pointer or keyboard): between state columns
  it runs the transition that leads there, otherwise it writes the field.

## Design system, themes, languages

- Tokens in `@kosh/ui/styles.css` (CSS variables mapped to Tailwind v4 utilities), light and dark themes (system
  default, remembered per browser), logical properties only (`ms`/`me`, `start`/`end`), so right-to-left needs no
  overrides. Components are owned code on Radix primitives (focus, keyboard, ARIA).
- i18next with the `kosh` namespace in English, Bangla and Arabic (Arabic verifies RTL); modules add namespaces
  with `addMessages()`. The language goes to the server as `Accept-Language`, so model labels come translated.
  Numbers, exact decimals (strings, never floats; South Asian grouping for Bangla, Bengali digits optional), dates
  and datetimes (user time zone) are formatted with `Intl`.

## Tests

`apps/web/e2e` (Playwright) runs against a real server (`e2e/server.ts`: PostgreSQL via Testcontainers, a contacts
and a purchase app, users with different roles): sign-in with 2FA, apps and menus per role, Bangla, RTL, themes,
list search / filters / group-by / sort / inline edit, form create / transitions per permission / read-only state,
kanban drag-and-drop, the approval flow through the extension-added panel, and axe accessibility checks (no
serious or critical violations) in both themes. Run `pnpm build && pnpm test:e2e`.

## Not yet

Code splitting per app (ECharts and MapLibre load on demand; the rest is one bundle), `kosh inspect view` on the
CLI. The chatter is `@kosh/messaging/web` (docs/messaging.md). Performance budgets: docs/benchmarks.md.
