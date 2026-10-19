# RFC 0008: Default business apps & the App manager (install, disable, uninstall)

- **Status:** Draft (2026-10-19)
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

## 7. Shutro requests

These are recorded in `docs/shutro-requests.md`; Kosh will not work around them without asking.

- Plan a migration for a **removal**: drop only what the removed modules own, including columns their
  `extendModel`s added.
- Report **ownership metadata**: which module created each table and column.
- **Unload** a module's data records by external id (the reverse of `loadData`).
- Build a registry for a subset of loaded modules quickly, for a cached rebuild per installed set.

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

## 9. Open questions

1. Should Inventory be part of the default set now (deliveries and receipts with Sales and Purchase), or stay a
   later app as proposed?
2. Which charts of accounts should ship first: a generic one plus Bangladesh, as proposed?
3. Is Disable the right default for uninstall, with Remove data as the explicit second choice?
4. How long should uninstall snapshots be kept (proposed: 30 days)?
5. Should hot reload be on by default, or behind `KOSH_HOT_APPS=1` until it has proven itself?

## Alignment with CLAUDE.md

- **Default deny:** installing grants nothing, and access is chosen per role in the plan.
- **Server authority:** every app operation is checked and audited on the server.
- **Shutro owns the data layer:** migrations, data loading and unloading, and registries all come from Shutro, and
  the gaps are listed in §7.
- **Explicit over magic:** bridges are proposed and shown, never silent.
- **Modular monolith:** apps are modules in one process, and the registry is per database.
