# RFC 0004: View definitions & shared search layer

- **Status:** Accepted (2026-10-18), implemented in `@kosh/views`, `@kosh/search`, `@kosh/server`, `@kosh/ui` (docs/ui.md)
- **Depends on:** 0001, 0002, 0003

## 1. Summary

Views (list, form, kanban, and the reporting views of RFC 0005) are **typed data** declared in module manifests,
checked against the model's Shutro metadata, extended by other modules through named anchors, and rendered by
pluggable renderers. One **search layer** (filters, group-by, favorites, saved and shared views) produces a Shutro
domain and grouping that every view uses, so a filter means the same in a list, a kanban and a pivot.

## 2. Problem

Hundreds of screens must stay consistent with models that change, be extended by other modules, be personalized
by users, and never let the UI show or accept what the server forbids.

## 3. How Odoo does it, and its weaknesses

XML `arch` per view type (`<tree>`, `<form>`, `<kanban>`, `<search>`), inheritance by XPath with priorities,
`attrs`/`invisible` expressions in Python-like strings, search views with `<filter domain="…">`, favorites in
`ir.filters`.

- **Untyped:** a renamed field breaks views at runtime; XPath against another module's arch is brittle and order
  depends on priorities and module load.
- **Logic in strings:** `invisible="state != 'draft'"` is evaluated client-side in a mini-language.
- **Kanban templates** are QWeb in XML; custom widgets need OWL code and asset bundles.
- **Search domains** are Python-literal strings, hard to validate.

## 4. Options

| | A. Typed view objects in TS + JSON at runtime | B. JSX views (React components only) | C. XML/JSON arch like Odoo |
| --- | --- | --- | --- |
| Checked against models | Yes (generated Shutro view) | Yes | No |
| Extensible by other modules without forking | Yes (anchors) | Hard (component overrides) | Yes (XPath, brittle) |
| Personalization stored as data | Yes | No | Yes |
| Custom rendering | Renderer registry + component slots | Native | Widgets |

## 5. Recommendation: A, with React escape hatches

```ts
views: {
  'purchase.order.list': list('purchase.order', {
    fields: ['name', 'partner', 'dateOrder', { field: 'amountTotal', sum: true }, { field: 'state', widget: 'badge' }],
    defaultOrder: ['dateOrder desc'],
    inlineEdit: ['partner'],
  }),
  'purchase.order.form': form('purchase.order', {
    header: { transitions: ['submit', 'approve', 'cancel'], statusbar: 'state' },
    sheet: [
      group('main', ['partner', 'dateOrder', 'currency']),
      notebook([page('lines', [lines('lines', { fields: ['product', 'quantity', 'priceUnit', 'subtotal'] })])]),
    ],
    readonlyWhen: { state: { notIn: ['draft'] } },   // a Shutro domain, evaluated on the server and the client
    chatter: true,
  }),
  'purchase.order.kanban': kanban('purchase.order', { groupBy: 'state', card: { title: 'name', subtitle: 'partner', footer: ['amountTotal'] } }),
},
search: {
  'purchase.order': {
    fields: ['name', 'partner', 'product'],
    filters: { toApprove: { label: 'To approve', domain: { state: 'to_approve' } }, mine: { domain: { createdBy: { $env: 'uid' } } } },
    groupBy: ['partner', 'state', 'dateOrder:month'],
  },
},
```

- **Typed builders** (`list`, `form`, `kanban`, …) from `@kosh/modules-sdk`, typed against the module's generated
  Shutro view: unknown fields, wrong kinds for a widget, unknown transitions are compile errors. The build emits JSON
  definitions served at `/api/v1/views/{id}` filtered for the user (fields they may not read are removed; buttons
  they may not use are dropped) — RFC 0003.
- **Conditions are Shutro domains** (`readonlyWhen`, `visibleWhen`), evaluated by a shared evaluator in the client and
  re-checked by the server on write (state guards, field security), never trusted from the client.
- **Extension by anchors**: every group, page, field and button has an id; other modules apply typed operations
  (`insertAfter`, `insertBefore`, `replace`, `remove`, `setAttrs`) recorded with their origin; `kosh inspect view`
  prints the result and the chain.
- **Escape hatches**: a view node, a field widget or a whole view may be a registered React component
  (`component: 'purchase.ApprovalPanel'`), receiving typed props (record, field, client).
- **Search layer** (`packages/search`): facets compile to a Shutro domain + group-by + order; the server validates it
  (paths, operators, field security). Favorites, saved and shared views are records (`kosh.saved_view`: owner,
  shared with roles/users, model, view type, domain, grouping, columns), governed by Shutro rules.

## 6. Purchase with approvals

The approvals module extends `purchase.order.form` with `insertAfter: 'main'` → the approval panel (a React
component showing levels, approvers and decisions); its search adds the filter "Waiting for my approval" with the
domain `{ 'approvalRequests.any': { approver: { $env: 'uid' }, state: 'pending' } }`. A buyer saves "My big orders"
(`amountTotal > 100 000`, grouped by partner) and shares it with the procurement role.

## 7. Open questions

- Client-side evaluation of domains with relation paths needs the related values loaded; proposed: such conditions
  are server-evaluated and shipped as booleans with the record.

## Alignment with CLAUDE.md

- View schemas and builders live in `packages/views`, the search layer in `packages/search`, renderers in
  `packages/ui`; `defineView` / `defineMenu` / `defineAction` are exported by `packages/modules-sdk`.

## Implementation notes (2026-10-18)

- Builders take the Shutro model handle (`list(PurchaseOrder, ...)`): field keys are compile-time checked; transitions,
  relation paths, line columns and group-by fields are checked when the server starts. A model given by name is
  checked at startup only.
- `defineView` / `defineAction` are the `list` / `form` / `kanban` / `action` / `search` builders of `@kosh/views`
  (the package with the view schemas); manifests take them in `views`, `actions`, `search` and `viewExtensions`.
- Extension operations: `insertAfter`, `insertBefore`, `append`, `replace`, `remove`, `setAttrs`; origins and the
  chain are recorded by `resolveView()` (the `kosh inspect view` command comes with the CLI work).
- Client-side conditions decide only what needs the record's own values (open question 7): relation paths are
  undecided, so `readonlyWhen` does not lock and `visibleWhen` does not hide on them; the server re-checks writes.
- Saved views are `kosh.saved_view` (in `base`), private or shared with everyone who can read the model; sharing
  with specific roles needs a `$env` groups placeholder in Shutro record rules (later).
- A name-search endpoint (`/models/:model/names`) serves many2one pickers and display names.
