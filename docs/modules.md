# Modules

A Kosh module is one typed manifest wrapping a Shutro module (RFC 0001). Shutro owns the data layer; the manifest
adds the app, access levels, menus, actions, views, hooks and translations.

```ts
import { defineModule } from '@kosh/modules-sdk';
import { contactsShutro } from './models/module.ts'; // Shutro defineModule: models, groups, permissions, data

export const contacts = defineModule({
  shutro: contactsShutro,                       // name and version come from here
  kosh: '^0.1.0',                               // framework versions this module runs on
  depends: [base],                              // must cover the Shutro module's depends
  app: { code: 'contacts', label: 'Contacts', icon: 'users' },
  accessLevels: {                               // required: installing a module grants nothing
    user: { label: 'User', groups: ['contacts.user'] },
    manager: { label: 'Manager', groups: ['contacts.manager'], implies: ['user'] },
  },
  actions: { 'contacts.action_partners': { /* RFC 0004 */ } },
  menus: [
    { id: 'contacts.root', label: 'Contacts', app: 'contacts' },
    { id: 'contacts.partners', parent: 'contacts.root', label: 'Contacts', action: 'contacts.action_partners' },
  ],
});
```

## What is checked

- `defineModule`: the Shutro module has a name; `kosh` is a version range; access levels exist, each grants at least
  one group, and implies only levels of the same module; menu and action ids are `<module>.<name>` and unique.
- `loadModules(roots, { koshVersion })`: collects dependencies, orders them (dependencies first, ties by name),
  refuses cycles and two different modules with one name, checks every module's `kosh` range, checks that Kosh
  dependencies cover the Shutro module's dependencies, that access levels grant only groups of the module or its
  dependencies, that menu parents and actions exist, and that menu and action ids are unique across modules.

Version ranges: `1.2.3`, `^1.2.0`, `~1.2.0`, `>=1.2.0 <2.0.0`, `*`.

## Installing, disabling and enabling apps (RFC 0008)

`src/modules.ts` lists the **catalogue**: the modules this installation can install. The database records which of
them are **installed**, **disabled** or still **available** (`kosh_module`). The app host serves the installed
ones, and switches to the new set without a restart whenever apps change, on this server or another:

```ts
const host = await createAppHost({ databaseUrl, catalogue: modules, migrationsDir: 'migrations' });
await startAppHost(host, { port: 3000 });
```

**Settings → Apps** in the back-office is the App manager. It shows each app as a card with its icon, state and
what it needs, with search and filters. Install, Enable and Disable show the server's plan first: what comes along,
what goes with it, and the database changes and their SQL. Only Administrators and holders of the
**Settings / App manager** access level can use it, and the server checks this on every request
(`/api/v1/settings/apps`, `/plan`, `/apply`). An apply re-plans and refuses a plan that is no longer current, so a
stale or repeated request changes nothing. `base` and Settings are always installed.

The same from the terminal:

```sh
npx kosh apps                       # ● installed  ◌ disabled  ○ available
npx kosh apps install sales         # the plan (sales and what it needs), then one transaction
npx kosh apps disable projects      # menus, API and access go; tables and data stay (dependents go too)
npx kosh apps enable projects       # back in seconds, with its data
npx kosh apps install sales --plan  # only show the plan
```

Every change is planned against the live database first: the modules (dependencies, cascades) and the schema
statements. It is then applied in **one PostgreSQL transaction**, which covers:

- the migration file, written to `migrations/`;
- the new modules' seed data, and every app's defaults (`hooks.defaults`);
- the new modules' `hooks.postInstall`;
- the installed set;
- an `apps.change` audit event.

If anything fails, nothing changes, not even the migration file. Each applied change is logged in `kosh_app_log`
with who made it, its SQL and the migration file itself. When a server did not keep the file (a recreated
container, for example), `kosh migrate` and the next app change write it back from the log, byte for byte. When the
change commits, `NOTIFY kosh_apps` tells every server to switch to the new set; requests already running finish on
the old one.

A module adds its defaults (data derived from the served modules, such as approval policies from their `approvals`)
with an idempotent hook. It runs after every seed and every app install:

```ts
hooks: { defaults: async (env, modules) => `${await installTemplates(env, modules)} document template(s) installed` },
```

The engine refuses a change in these cases:

- the database has pending migration files, or does not match its modules yet (run `kosh migrate` first);
- the change would drop or alter data;
- `base` or Settings would be disabled;
- disabling would leave behind a `NOT NULL` column without a database default that a served model still has (a
  required field with a function default or a compute, added by the disabled module's `extendModel`);
- another app change happened after this one was planned.

A disabled module's tables stay part of the schema, so `kosh migrate` plans with the installed and disabled modules
and never proposes dropping them. Removing an app together with its data comes in a later step.

Projects from before the App manager have no `kosh_module` yet. Until their first `kosh apps` change, servers and
`kosh migrate` keep treating `src/modules.ts` as the installed set. That first change records the modules that have
been migrated, and anything added to the list since then is shown as available.

## Business apps (`modules/`)

The business apps are Kosh code in `modules/`, one package each: `@kosh/contacts`, `@kosh/product`,
`@kosh/sales` and `@kosh/purchase`, with Accounting and Projects next. They ship in `kosh-erp` as
`kosh-erp/sales` and so on. Shutro is only the ORM: no app, module or generated app code lives in it. The framework
(`packages/`) never imports an app (`pnpm lint` checks this); only the CLI, which assembles installations, does.

An app has three parts:

- `src/module.ts` holds the data layer: Shutro models, groups, sequences and seed data, in one `defineModule`.
- `src/.kosh/` holds its **typed view**, generated and committed. `schema.d.ts` describes the models the app can
  see, and `bindings.ts` provides `defineModel`, `compute`, `check`, `onchange`, `records` and `record` typed against
  them, so computes and checks need no casts. Regenerate the view after changing models with `pnpm generate:models`.
  `pnpm lint` fails when a view is stale.
- `src/index.ts` is the Kosh manifest: the app (icon, category, summary), access levels, actions, menus, views,
  search, and approval policies.

```ts
// src/module.ts
import { contactsShutro } from '@kosh/contacts';
import { compute, defineModel, defineModule, f } from './.kosh/bindings.js';

export const SaleOrder = defineModel('sale.order', {
  fields: {
    amountTotal: f.monetary({
      currency: 'currency',
      store: true,
      ...compute('sale.order', 'amountTotal', ['lines.subtotal'], (orders) => {
        for (const o of orders) o.amountTotal = o.lines.sum('subtotal', o.currency); // Money, typed
      }),
    }),
  },
});
```

The views come from Shutro's own type generator, run through Kosh's single Shutro gateway (`loadCodegen` in
`@kosh/server/orm`). Their imports point at `@kosh/server/orm`, and other modules are referenced by package name.

**Default access is none.** Each app declares its own groups and access levels. A salesperson (`sales.user`) gets
read access to contacts and products through the groups it implies, and sees only their own orders (a record
rule). Managers see every order of their companies.

| App | Models | Workflow and rules |
| --- | --- | --- |
| Contacts | `res.partner` (companies and people, customers and vendors, addresses, tax ID) | email format check |
| Products | `product.product` (numbered P00001…), `product.category`, `uom.uom`, `account.tax` | Bangladesh VAT rates and units as editable seed data |
| Sales | `sale.order` (SO/2026/00001…), `sale.order.line` | quotation → sent → order → locked; lines required to confirm; discount and VAT per line; totals in the order's currency |
| Purchase | `purchase.order` (PO/2026/00001…), `purchase.order.line` | RFQ → submit → approvals (manager > 100,000, director > 1,000,000, editable) → order; the last approval confirms |
