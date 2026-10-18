# RFC 0001: Module system & manifest

- **Status:** Accepted
- **Depends on:** Shutro RFC 0002 (modules & extension), 0014 (security), 0017 (module data)

## 1. Summary

A Kosh module is **one typed TypeScript manifest** that wraps a Shutro module: Shutro owns the data layer (models,
extensions, groups, permissions, sequences, data records); the Kosh manifest adds what an ERP application needs on
top (apps and menus, views, actions, server routes, reports, notifications, settings, translations, assets,
lifecycle hooks). Modules are npm packages, installed per database, and checked as a whole at startup.

## 2. Problem

An ERP is assembled from modules (contacts, product, purchase, inventory, approvals) that each contribute models
*and* UI, workflows, reports and permissions, and that extend each other. The module system must:

- order modules by dependency and fail fast on missing or circular dependencies;
- let a module extend another's models, views, menus and workflows explicitly and traceably;
- install, upgrade and uninstall per database (tenants have different module sets);
- make a broken module fail in CI, not in production at install time;
- give each app its own access levels (RFC 0003): installing grants nothing.

## 3. How Odoo does it, and its weaknesses

Odoo: a Python package with `__manifest__.py` (`depends`, `data` XML/CSV files, `assets`, `application`,
`auto_install`, `installable`), Python models registered by import side effects, XML views/menus/actions with
`inherit_id` + XPath, installation state in `ir_module_module`, upgrades via `-u module`.

- **Untyped and late:** the manifest is a dict; data files reference XML ids by string; a typo in an XPath or a
  `ref()` surfaces during install or upgrade, often half-way through, on a customer database.
- **Hidden order:** Python MRO and XPath priority decide what wins when several modules extend the same view or
  method; nothing shows the chain.
- **Global mutation:** importing a module mutates the registry; tests and multi-tenant processes share state.
- **Assets and views outside the type system:** XML views know nothing about field types; a renamed field breaks
  views at runtime.
- **Uninstall is unreliable:** data and columns linger; there is no reviewed migration plan.
- **No version contracts:** `depends` has no version ranges; upgrades of a dependency silently change behaviour.

## 4. Options

| | A. Typed manifest wrapping a Shutro module | B. Manifest file (JSON/YAML) + code by convention | C. Folder discovery (Odoo-like) |
| --- | --- | --- | --- |
| Type checking | Full: views, menus, actions, routes typed against the module's generated Shutro view | Schema-validated only; references are strings | None until runtime |
| Single source for `depends` | Yes (one object) | Two (file + Shutro module) | Implicit |
| Tooling / IDE | Go-to-definition, rename, refactor | Weak | Weak |
| Readable by non-TS tools (marketplace, installer) | Through a build step that emits `kosh-module.json` | Native | Native |
| Cost | Manifest is code: must be side-effect free | Duplication, drift | Magic, hard to debug |

## 5. Recommendation: A

```ts
// modules/purchase/manifest.ts
import { defineModule } from '@kosh/modules-sdk';
import { purchaseShutro } from './models/module.ts'; // the Shutro module (models, groups, permissions, data)
import { approvals } from '@kosh/approvals';
import { contacts } from '@kosh/contacts';
import { product } from '@kosh/product';

export const purchase = defineModule({
  shutro: purchaseShutro,                 // depends, models, groups, permissions, sequences, data come from here
  version: '1.2.0',
  kosh: '^1.0.0',                         // compatible framework range, checked at startup
  depends: [contacts, product, approvals], // Kosh modules; must cover the Shutro module's depends
  app: { code: 'purchase', label: 'Purchase', icon: 'shopping-cart', sequence: 30 },
  accessLevels: {                         // RFC 0003: installing grants nothing; these are what admins assign
    user: { label: 'User', groups: ['purchase.user'] },
    approver: { label: 'Approver', groups: ['purchase.approver'], implies: ['user'] },
    manager: { label: 'Manager', groups: ['purchase.manager'], implies: ['approver'] },
  },
  menus: [
    { id: 'purchase.root', label: 'Purchase', app: 'purchase' },
    { id: 'purchase.orders', parent: 'purchase.root', label: 'Requests for quotation', action: 'purchase.action_orders' },
    { id: 'purchase.to_approve', parent: 'purchase.root', label: 'To approve', action: 'purchase.action_to_approve',
      visibleTo: ['purchase.approver'] },
  ],
  actions: { /* window actions: model + views + default filters (RFC 0004) */ },
  views: { /* list / form / kanban / pivot definitions, typed against purchase.order (RFC 0004) */ },
  routes: { /* extra server endpoints beyond the generated ones (RFC 0002) */ },
  reports: { /* RFC 0005 */ },
  notifications: { 'purchase.approval_requested': { /* RFC 0006 */ } },
  settings: { approvalThreshold: { type: 'money', default: { amount: '50000', currency: 'base.currency_bdt' } } },
  i18n: { bn_BD: () => import('./i18n/bn_BD.json') },
  hooks: {
    async postInstall(env) { /* e.g. default approval policy per company */ },
    async preUninstall(env) { /* refuse if open approvals exist */ },
  },
});
```

**Decisions**

1. **One manifest object, typed.** `defineModule` from `@kosh/modules-sdk` validates its input and returns a frozen
   descriptor. Views, actions and menus are typed against the module's generated Shutro view (field names, kinds,
   transitions), so renaming a field is a compile error in every view that uses it.
2. **Shutro stays the data authority.** Models, model extensions, groups, permissions, sequences and data records
   live in the Shutro module; Kosh never duplicates them. Kosh `depends` must include a Kosh module for every Shutro
   dependency (checked).
3. **Explicit extension points.** A module extends another module's views, menus, actions and settings through
   `extends: { 'purchase.order.form': { insertAfter: 'partner', fields: ['incoterm'] } }`-style operations on named
   anchors, not XPath. Every extension is recorded with its origin (`kosh inspect view purchase.order.form` shows the
   chain, like Shutro's method layers).
4. **Build-time checks (CI) and startup checks:** dependency graph, version ranges (`kosh`, and `depends` with ranges
   when given), duplicate ids (menus, actions, views, routes, notification types), unknown references (a menu's
   action, a view's fields, an access level's groups), and Shutro's own registry checks (data refs, rules).
   `kosh check` runs them without a database.
5. **Per-database installation.** The installed set lives in the database (`kosh_module`: name, version, state,
   installed_at). A process serves several databases; each gets a registry built for its installed set (cached by
   the set's hash). Installing = `shutro migrate plan/apply` for the new set + data load + `postInstall`; upgrading =
   reviewed migration files + Shutro data-migration hooks; uninstalling = `preUninstall` guard, then a **reviewed**
   destructive migration (Shutro refuses destructive statements unless allowed).
6. **Packaging.** Modules are npm packages (`@kosh/purchase`, or private ones). The build emits `kosh-module.json`
   (name, version, depends, app, access levels, menus) for installers and the app store, so non-TS tooling never
   executes module code.
7. **Lifecycle hooks** run in Shutro system scopes (`shutro.bootstrap`) with a reason, inside the install
   transaction, and are audited.

## 6. Purchase with approvals

- `@kosh/approvals` provides a generic `approval.request` model, approval policies (conditions → levels → approver
  roles), the approval panel view and notifications. It knows nothing about purchase.
- `@kosh/purchase` depends on it, declares `purchase.order` with a state machine
  (`draft → to_approve → approved → ordered → done`, `cancel`), and an approval policy:

```ts
data: [
  record('approval.policy', 'po_policy', {
    model: 'purchase.order',
    levels: { create: [
      { name: 'Department head', when: { amountTotal: { gt: '50000' } }, approverRole: ref('res.groups', 'purchase.approver') },
      { name: 'Finance director', when: { amountTotal: { gt: '500000' } }, approverRole: ref('res.groups', 'account.manager') },
    ] },
  }, { noupdate: true }),            // companies tune thresholds without the next upgrade overwriting them
],
```

- `@kosh/purchase_stock` (depends on purchase + inventory) extends `purchase.order` with receipts and the
  `confirm` override (Shutro `extendModel`), extends the form view at the `lines` anchor with a "Receipts" smart
  button, and adds a menu under Inventory. `kosh inspect` shows: `purchase.order.confirm: purchase → purchase_stock`.

## 7. Open questions

- Version ranges in `depends` (`{ module: contacts, version: '^2' }`) now, or only the `kosh` range at first?
- Do we allow runtime-installed modules without a process restart (hot registry rebuild per database)? Proposed:
  yes per database, behind a feature flag, since registries are already per installed set.
- Marketplace signing of module packages (out of scope for 1.0).
