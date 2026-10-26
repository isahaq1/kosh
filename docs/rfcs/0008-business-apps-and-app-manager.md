# RFC 0008: Default business apps & the App manager (install, disable, uninstall)

- **Status:** Accepted (2026-10-19); steps 1–4 implemented (`kosh apps`; the app host, the Settings app and the
  Apps page; Contacts, Products, Sales and Purchase; see Implementation notes)
- **Depends on:** 0001 (modules, per-database installation), 0002 (generated API), 0003 (permissions), 0004/0005
  (views, reporting), 0006 (chatter), 0007 (frontend)
- **Followed by:** RFC 0009 Accounting (ledger design), written before Accounting is built

## 1. Summary

A fresh Kosh installation comes up as a usable ERP and not just a framework. Five apps are installed by default:
**Settings, Accounting, Sales, Purchase and Projects**, together with the modules they need (contacts, products,
units of measure) and the framework apps (permissions, reporting, messaging). Administrators install, **disable**
and uninstall apps afterwards from **Settings → Apps** or from `kosh apps`. Every change is a reviewed plan that is
applied in a single PostgreSQL transaction, so it either succeeds completely or leaves nothing behind. Every server
picks up the new set without a restart.

## 2. Problem

- Today the module set is fixed in `src/modules.ts`. Adding an app means editing code, running `kosh migrate` and
  restarting. A business user cannot do it.
- `kosh init` installs only the framework apps (permissions, reporting, messaging), so a new installation has no
  business apps to use.
- RFC 0001 §5 designed the per-database installed set (`kosh_module`), but it has not been built yet.

## 3. How Odoo does it, and its weaknesses

Odoo's Apps menu installs modules at runtime (`ir_module_module`, `button_immediate_install`), and `auto_install`
silently adds bridge modules. In practice this has several weaknesses:

- **Half-installed modules:** an install that fails part-way leaves tables, records and the `to install` state
  behind, and the fix needs `-u` or SQL by hand.
- **Slow:** each install reloads the whole registry and can take minutes on a real database. Other workers keep the
  old registry until they are signalled.
- **Uninstall is unreliable and one-way:** columns, records and translations linger, there is no preview of what is
  lost, and no "turn it off for now" option.
- **Hidden magic:** `auto_install` bridges appear without being asked for.
- **Access is broad:** installing an app often grants its user group to everyone in `base.group_user`.

## 4. Options

| | A. Installed set in the database, hot reload (recommended) | B. Edit `src/modules.ts`, restart | C. Separate services per app |
| - | - | - | - |
| Business user can do it | Yes (UI) | No (developer) | Yes |
| Atomic | Yes (one transaction) | Per migration file | No (distributed) |
| Fits a modular monolith | Yes | Yes | No (CLAUDE.md principle 1) |
| Multi-tenant (different sets per database) | Yes | No | Partly |

## 5. Recommendation: A

### 5.1 The default apps

`kosh init` (and `npm create kosh-erp`) selects these apps by default. Every app can be deselected
(`--apps`, or `--minimal` for base + Settings only).

| App | Icon | Category | Version 1 scope | Depends on |
| --- | --- | --- | --- | --- |
| **Settings** (always installed, cannot be uninstalled) | ⚙️ | Administration | Apps (this RFC), users and roles (the RFC 0003 admin UI), companies, currencies, sequences, general settings (language, time zone, formats), audit log | base, permissions |
| **Accounting** | 📒 | Finance | Chart of accounts (generic and Bangladesh templates), journals, taxes (including VAT), double-entry journal entries in `Decimal`, customer invoices, vendor bills, credit notes, payments, reconciliation, lock dates, and reports (trial balance, general ledger, P&L, balance sheet, aged receivables/payables). Detailed in **RFC 0009**. | contacts, product, reporting, messaging |
| **Sales** | 🛒 | Sales | Customers, quotations → sales orders, price lists, discounts, quotation PDF, invoicing from orders (through a bridge when Accounting is installed), sales analysis pivot | contacts, product, messaging |
| **Purchase** | 🧾 | Purchasing | RFQs → purchase orders, amount-based approvals (RFC 0003), vendor price lists, bills from orders (through a bridge with Accounting), purchase analysis | contacts, product, permissions, messaging |
| **Projects** | 📋 | Services | Projects, tasks (kanban stages, assignees, deadlines, sub-tasks, tags), milestones, timesheets, gantt and calendar, project dashboard | contacts, messaging |
| *contacts, product, uom* | 👥 📦 📏 | Shared | Partners and addresses; products, categories, units of measure | base |

Inventory is **not** in the default set. In version 1, Sales and Purchase work without stock moves, and an
`inventory` app plus the `sale_stock` / `purchase_stock` bridges come later (RFC 0001 §6).

**Bridges are explicit.** A bridge module declares `bridge: [sales, accounting]`. When every app it bridges is
installed, the install plan **proposes** the bridge as a pre-checked line that the administrator can uncheck. It is
never added silently, and `kosh apps` lists bridges with the apps they connect.

Default bridges: `sale_account` (invoice from order), `purchase_account` (bill from order), `sale_project`
(project or task from an order line), `project_account` (billable timesheets, later).

### 5.2 Catalogue and installed set

- **Catalogue:** the modules this installation *can* install: the business apps shipped in `kosh-erp` (code-split:
  `kosh-erp/sales`, …), the project's own modules, and installed npm module packages. `src/modules.ts` exports
  `catalogue`. The old `modules` export keeps working: on first start it is read as "catalogue = installed set".
- **Installed set:** the `kosh_module` table (RFC 0001 §5), with these columns:
  - `name`, `version`
  - `state`: `installed` | `disabled` | `to_remove`
  - `reason`: `selected` | `dependency` | `bridge`
  - `installed_at`, `installed_by`
- The server builds each database's registry from catalogue ∩ installed set and caches it by the set's hash.
- The back-office bundles every catalogue app's web code as separate chunks (RFC 0007), so the server's menus and
  permissions decide what each database shows.
- **Settings** includes `kosh-module.json` metadata for every catalogue app (name, icon, category, summary,
  depends, access levels), so the Apps page renders without loading module code.

### 5.3 Installing

1. **Plan** (no changes are made):
   - the modules to add, including dependencies and proposed bridges, shown as a tree;
   - the schema statements (Shutro `planMigration` for the new set, against the live database);
   - the data records to load;
   - the access levels the apps add.
2. **Choose access:** the plan dialog asks which roles get which access level, for example "Sales / User → Sales
   team". Installing grants nothing by default (CLAUDE.md), and Administrators already have full access through the
   bypass.
3. **Apply** in **one transaction**, under `pg_advisory_xact_lock` for this database so only one app operation runs
   at a time. PostgreSQL DDL is transactional, so any failure rolls back everything. The steps are:
   - apply the migration;
   - load the data (Shutro `loadData`, by external id);
   - run each module's `postInstall` (in `shutro.bootstrap`, audited);
   - write the role grants and the `kosh_module` rows;
   - store the applied SQL in `kosh_migration_log`, so it is reviewable and `kosh migrate export` writes it to
     `migrations/`.
4. **Publish:** `NOTIFY kosh_modules` once the transaction commits. Every server node rebuilds that database's
   registry, and requests already in flight finish on the old one. Clients get a realtime event and refresh their
   menus.

The work runs as a background job (pg-boss). The UI shows each step's progress over the realtime gateway, and the
CLI shows the same steps with spinners and progress bars.

### 5.4 Disabling and uninstalling

The uninstall dialog offers two choices, and the safe one is selected by default:

- **Disable** (default, reversible, instant): `state = disabled`. The app's menus, routes, views, actions, jobs,
  notifications and access are removed from the registry, but its tables and data stay. **Enable** brings everything
  back in seconds. Odoo has no equivalent of this.
- **Remove data** (destructive, guarded), in this order:
  1. The plan lists the dependent apps that go with it, every table and column to drop, and the number of records
     in each. Bridges are removed automatically and listed.
  2. Each module's `preUninstall` may refuse. For example, Accounting refuses while posted entries exist inside the
     legal retention period and offers Disable instead.
  3. The administrator types the app's name and gives a fresh 2FA code (step-up).
  4. A **snapshot** is taken: the affected tables are dumped to file storage (S3 or the storage folder) and kept for
     30 days (configurable). Reinstalling within that time offers to restore it.
  5. One transaction then:
     - runs the destructive migration (Shutro refuses drops unless they are allowed);
     - removes the module's data records by external id;
     - removes its groups and role grants;
     - deletes the `kosh_module` row;
     - writes the audit entry.
  6. `NOTIFY` follows, as in §5.3.
- `base` and **Settings** cannot be uninstalled. The server refuses any change that would leave no active
  administrator.

### 5.5 Interfaces

**CLI** (the same terminal UI as `kosh init`: icons, spinners, plan trees, progress bars):

```
kosh apps                              # catalogue: icon, name, state, version, category
kosh apps install sales projects       # shows the plan, asks, applies    (--plan only shows, --yes skips the question)
kosh apps disable projects             # and: kosh apps enable projects
kosh apps uninstall projects --remove-data
kosh apps upgrade [name…]              # newer catalogue versions: reviewed migrations + data migrations
```

**API** (generated into OpenAPI and the typed client):

- `GET /api/v1/apps`: the catalogue, with state and what the caller may do.
- `POST /api/v1/apps/plan`: takes `{ install?, disable?, enable?, uninstall? }` and returns the plan.
- `POST /api/v1/apps/apply`: takes the plan's hash and an `Idempotency-Key`, and returns a job id.
- `GET /api/v1/apps/jobs/:id`: the job's progress, also pushed over WebSocket.

**UI: Settings → Apps:**

- A grid of app cards, each with its icon, name, one-line summary, category, version and state badge (Installed,
  Disabled, Available, Update).
- Search, category filters and an "Installed" toggle.
- **Install** opens the plan dialog (dependency tree, bridge checkboxes, what gets created, access per role). Once
  confirmed, a step-by-step progress dialog follows.
- **Uninstall** opens a dialog that defaults to Disable, with the impact counts for Remove data.
- Every screen works in English and Bangla, light and dark mode, with the keyboard and a screen reader.

### 5.6 Permissions and safety

- Only Administrators, or holders of the `settings.apps` access level, can plan or apply app changes. This is
  checked on the server for every route.
- Every plan and every applied change is audited (who, what, the SQL hash, and the snapshot id).
- Remove data needs a step-up 2FA code. App routes are rate-limited, and only one app operation runs per database
  at a time.
- Installs and uninstalls never change other modules' data except through the declared bridges and the cascade
  shown in the plan.

### 5.7 Performance targets (CI benchmarks)

| Operation | Target |
| --- | --- |
| Plan, any app | < 500 ms |
| Install Sales on a fresh database | < 5 s |
| Disable or enable an app | < 1 s |
| Registry rebuild on other nodes | < 1 s after `NOTIFY` |

## 6. Purchase with approvals

From a fresh installation, an administrator opens Settings → Apps; Purchase is already installed. They grant
"Purchase / Manager" to the Finance role in the role screen (RFC 0003), and the default approval policy (RFC 0003
§5.3) is already in place with editable thresholds. Later they disable Projects. Its menus disappear for everyone
within a second, its tasks stay in the database, and enabling it again restores everything.

## 7. Built in Kosh, on Shutro's public APIs

App management is framework code: it lives in Kosh (`@kosh/modules-sdk`, `@kosh/server`), not in Shutro (decided
2026-10-19). Kosh builds what uninstall needs from what Shutro already offers:

- **Removal plan:** Shutro's `planMigration` against the registry of the set *without* the removed modules (disabled
  ones kept); its destructive operations are exactly what those modules own, including the columns their
  `extendModel`s added.
- **Ownership:** read from each module's `models` and `extensions` and from `registry.describe()` (field origins).
- **Unloading data:** the module's records found through Shutro's external-id table and deleted through the ORM.
- **Registries per set:** `buildKoshRegistry` for each installed set, cached by the set's hash (step 2).
- **One transaction:** Shutro runs on a `Driver` pinned to the app change's transaction; its own transactions become
  savepoints.

## 8. Delivery plan (each step reviewed before the next)

1. Build the `kosh_module` table, the catalogue and the plan/apply engine, with `kosh apps` for the existing
   framework apps. Tests run on real PostgreSQL, including rollback on failure.
2. Add the API, the hot registry reload across nodes (`NOTIFY`), and the **Settings** app with the Apps page, plus
   E2E tests and permission tests (forbidden users are blocked).
3. Add contacts, product and uom.
4. Add **Sales** and **Purchase** (Purchase with its approval policy).
5. Write **RFC 0009 Accounting**, then build **Accounting** and the `sale_account` / `purchase_account` bridges.
6. Add **Projects** and `sale_project`.
7. Switch `kosh init` to the default set in §5.1 and update the docs and benchmarks.

## Implementation notes (2026-10-25): bridges

`defineModule({ bridge: [sales, accounting] })` declares a bridge; `planApps` proposes it (reason `bridge`) as
soon as every module it connects is installed or part of the change, and `AppChange.withoutBridges` leaves one
out. The first two are `sale_account` and `purchase_account` (RFC 0009 step 2). The Settings page and `kosh apps`
show the reason; a pre-checked line to uncheck in the UI is still to come.

## Implementation notes (2026-10-26): step 7 — the default set and the business apps' E2E catalogue

- **`kosh init`** offers every app but the bridges (`SELECTABLE_APPS`), all selected by default: Contacts,
  Products, Sales, Purchase and Accounting with the framework apps; the bridges of the chosen apps
  (`bridgesFor`) come along without being asked for. Projects joins the default set when it is built.
- **The business apps' E2E catalogue** (`apps/web/e2e-apps/server.ts`, Playwright project `apps`, its own API
  and preview ports): a real installation of Sales, Purchase and Accounting with the bridges proposed by the
  planner, the Bangladesh chart, partners, a product, a confirmed sales order and a posted customer invoice,
  seeded through the API as users would. `apps/web/e2e-apps/accounting.spec.ts` invoices an order from its form,
  registers a payment on an invoice from its form and sees it paid, reads the aged balances and the trial
  balance, sets a lock date on the settings page and matches open items on the reconciliation page. The fixture
  catalogue (`e2e/`) keeps its own partner model, so the two projects run on separate servers.
- The back-office (`apps/web`) registers the accounting screens (`@kosh/accounting/web`), as the starter does.

## 9. Decisions (2026-10-19)

1. Inventory stays out of the default set; it comes later as its own app with the `sale_stock` / `purchase_stock`
   bridges.
2. Charts of accounts: a generic one plus Bangladesh first.
3. Uninstall defaults to Disable; Remove data is the explicit second choice.
4. Uninstall snapshots are kept 30 days (configurable).
5. Hot reload is decided with step 2, after measuring it.

## Alignment with CLAUDE.md

- **Default deny:** installing grants nothing, and access is chosen per role in the plan.
- **Server authority:** every app operation is checked and audited on the server.
- **Shutro stays the data layer:** migrations, data loading and registries come from Shutro's public APIs. App
  management itself is Kosh code (§7), so nothing ORM-level is reimplemented.
- **Explicit over magic:** bridges are proposed and shown, never silent.
- **Modular monolith:** apps are modules in one process, and the registry is per database.

## Implementation notes (2026-10-19): step 1

- `@kosh/modules-sdk` `planApps` is the pure planner. It takes the catalogue, the installed set and a change
  (install, enable or disable), and resolves dependencies (dependencies first) and disable cascades (dependents
  first). It refuses unknown apps, protected apps (`base`), enabling apps that are not installed, and contradictory
  changes.
- `@kosh/server` `apps.ts` is the engine:
  - The `kosh_module` table holds the installed set and `kosh_app_log` holds the applied changes with their SQL and
    digest. Both are listed in `FRAMEWORK_TABLES`, so migrations ignore them.
  - `prepareApps` refuses pending migration files, a database that does not match its modules yet, destructive
    statements, and disabling a module whose `NOT NULL` columns without a database default would stay behind.
  - `applyApps` runs the migration file, the data, the `postInstall` hooks, the installed set and the log in one
    transaction under an advisory lock. It refuses a plan made before another change. If anything fails, it rolls
    back and deletes the migration file.
- **The schema set and the served set:** a disabled module's tables and columns stay in the schema, so `kosh migrate`
  plans with installed and disabled modules, while servers serve only installed ones (`installedModules`). The
  starter's `server.ts` uses `installedModules`.
- **Projects from before the App manager:** without `kosh_module`, servers and `kosh migrate` treat the module list as
  the installed set, as before. The first `kosh apps` change adopts the modules Shutro has migrated
  (`shutro_module`), so modules added to the list since then are available, not installed. `kosh init` now records
  the installed set itself.
- **CLI:**
  - `kosh apps` lists the catalogue with state marks (● installed, ◌ disabled, ○ available).
  - `kosh apps install`, `enable` and `disable` show the plan, ask, then apply it with spinners.
  - `--plan` only shows the plan, and `--yes` applies without asking.
  - `kosh apps uninstall` (Remove data) comes in a later step.
  - After a change, the API is restarted; hot reload comes in step 2.
- **Tests:**
  - `packages/modules-sdk/test/apps.test.ts` covers the planner.
  - `packages/server/test/apps.integration.test.ts` runs on real PostgreSQL. It covers dependencies, data and hooks;
    full rollback; disable and enable keeping data; the required-column refusal; and a stale plan.
  - `packages/cli/test/apps.integration.test.ts` covers adoption, plan, install, disable with migrate, enable,
    "no", unknown apps and protected apps.

## Implementation notes (2026-10-19): step 2

- **Progress:** `apply` runs inside the request (installs take seconds), and the page shows it as busy. Progress
  over WebSocket waits for the realtime gateway (RFC 0006).
- **Idempotency:** `apply` re-plans and compares the `planId` from `/plan`. A changed set, schema or replay gets
  409 and changes nothing, so no separate idempotency key is needed. The plan's digest covers the current set, the
  change and the SQL.
- **Hot reload (decision 5):** on by default, measured in tests. The app host (`createAppHost`, `@kosh/server`) owns
  the listener. On `NOTIFY kosh_apps` or a local change, it builds a server for the new set (Fastify via
  `serverFactory`), sends new requests to it, and closes the old one when its requests finish (30 s at most). A failed
  rebuild keeps serving the current set and logs the error. The starter's `server.ts` and the e2e server use it.
- **Audit:** `applyApps` writes `apps.change` in the change's own transaction (actor: the user, or none for the CLI).
- **Migration files on servers:** `kosh_app_log` keeps each file byte for byte. `restoreAppMigrations` (run by
  `prepareApps` and `kosh migrate`) writes back files a server did not keep, so numbering and checksums hold.
- **Defaults:** approval policies, document templates and activity types are now each app's `hooks.defaults`. They
  are idempotent and run after every seed and install, so web installs get them as CLI installs do.
- **Client actions** (`{ type: 'client', page }` and `registry.registerPage`) carry the Apps page. They are a general
  framework feature for screens that are not one model's views.
- **`@kosh/settings`:**
  - the Settings app, with the access level `settings.apps` ("App manager");
  - the API `/api/v1/settings/apps`, `/plan` and `/apply`, under `settings` because `/api/v1/apps` is the launcher;
  - the Apps page, in English and Bangla.
- **`kosh init`:** writes the full catalogue (every framework app plus Settings) to `src/modules.ts`, and installs
  base, Settings and the chosen apps.
- **Tests:**
  - `packages/server/test/host.integration.test.ts`: a change on another server is served without a restart, and a
    request running during the switch finishes.
  - `packages/settings/test/apps-api.integration.test.ts`: forbidden users get 401/403 on every route; plan, stale
    plan, apply, audit, replay; protected apps; the client action in the menu.
  - `apps/web/e2e/apps.spec.ts`: install from the page, use the app, disable it; axe in light and dark; Bangla;
    users without access.
  - The e2e server now installs its modules through the App manager.

## Implementation notes (2026-10-19): steps 3 and 4

- **Where apps live:** `modules/<app>/` in Kosh, one package each (`@kosh/contacts`, `@kosh/product`,
  `@kosh/sales`, `@kosh/purchase`), bundled into `kosh-erp`. Shutro is the ORM only. Its former apps, app
  installer and web client were removed from the Shutro repository on 2026-10-19 at the owner's request (Shutro
  commits `5286564`…`f5440fc`; Shutro RFCs 0019 and 0020 withdrawn).
- **Typed model views:** `scripts/generate-models.ts` runs Shutro's generator through `@kosh/server/orm`
  (`loadCodegen`). It writes `src/.kosh/{schema.d.ts,bindings.ts}` with imports pointing at `@kosh/server/orm`, and
  refers to other modules by package name. `pnpm lint` checks the views are current.
- **Design source:** the model designs follow the earlier Shutro sample apps, reworked for Kosh. Each app has its
  own groups and access levels (default deny), rather than `base.user` access. Kosh adds:
  - discount on sales lines;
  - units on lines;
  - Bangladesh VAT presets;
  - currency from the partner, else the company;
  - Purchase approvals (RFC 0003) with a "To approve" menu for managers.
- **Engine fixes found by these apps:**
  - The install transaction's pinned driver no longer reports a pool size, so standard sequences number records
    inside the install.
  - A malformed onchange body now gets 400 instead of 500.
- **`kosh init`:** offers Contacts, Products, Sales and Purchase, all selected by default with the framework apps.
- **Tests:** `modules/sales/test` and `modules/purchase/test` run on real PostgreSQL through the HTTP API. They
  cover install with dependencies and seed data, totals, guards, numbering, onchanges, approvals end to end,
  record rules, and refusals for users without access.
- **Not yet:** end-to-end browser tests for Sales and Purchase. The e2e fixture defines its own `res.partner` and
  `purchase.order`, so these apps need their own e2e catalogue first. Accounting (RFC 0009 first) and Projects
  come next.
