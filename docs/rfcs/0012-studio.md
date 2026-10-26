# RFC 0012: Kosh Studio

- **Status:** Accepted 2026-10-26 with the proposed answers (the installation's `src/modules/`, patches first, the prefix, administrators); step 1 implemented (`@kosh/studio`, `kosh studio build`, `docs/studio.md`)
- **Depends on:** 0001 (manifests), 0002 (metadata), 0003 (permissions, approvals), 0004 (views and their
  extensions), 0008 (App manager, migrations), 0011 (automation rules); Shutro's `extendModel` and migration
  planner

## 1. Summary

Studio lets an administrator customize an installation **without writing code and without customizing the
database**: add fields to a model, add a model of their own, change a list, form or kanban, add a menu, an
approval policy, an automation rule. Every change is saved as **an ordinary Kosh module**: a `studio.json`
specification and the TypeScript generated from it (`extendModel`, `viewExtensions`, menus, `approvals`, rules),
in the installation's `src/modules/<name>/`. It is reviewed like code, versioned in git, installed and upgraded
through the App manager, migrated by Shutro's planner, and it survives upgrades of the apps it extends, because it
touches them only through the same extension points any module uses.

## 2. Problem

Every business needs a few fields, a column, a menu, a rule the product does not have. Today that needs a
developer writing a module (`kosh module create`): right for product behaviour, too slow for "add a GST number to
the contact form". In Odoo, Studio answers it, and the answer is the problem.

## 3. How Odoo does it, and its weaknesses

Odoo Studio writes `x_studio_*` fields, `ir.ui.view` inherit records with XPath, and automated actions **into the
database** of one installation:

- invisible to version control and code review; no staging → production path but an export of database records;
- XPath on another module's view breaks silently when that module's next version moves the node;
- tied to the paid edition; uninstalling Studio customizations leaves orphan columns;
- no test, no diff, no rollback but a database backup.

## 4. Options

- **A. Studio writes a module (spec + generated code) through the App manager.** Upgrade-safe, reviewable,
  testable, the same artefact a developer would write. Recommended.
- **B. Customizations as database records** (Odoo's way): instant but everything §3 lists. Rejected.
- **C. No Studio**: modules only. Leaves the "add one field" case to developers.

## 5. Recommendation: A

### 5.1 What Studio edits (version 1)

| Change | Generated as | Notes |
| --- | --- | --- |
| A field on an existing model | `extendModel(model, { fields })` | char, text, integer, decimal, monetary, date, datetime, boolean, selection, many2one, many2many; required, default, help, tracking (so automation can watch it), groups (field security) |
| A model of its own | `defineModel('x_<module>.<name>', …)` | fields as above, `recName`, archivable, company-scoped; access for the module's two groups; a list, a form, a search |
| A view change | `viewExtensions` with the operations RFC 0004 defines (`insertAfter`, `insertBefore`, `append`, `replace`, `remove`, `setAttrs`) on **node ids** | ids, not XPath: a moved node is still found; a removed one makes the extension fail at load with the module named |
| A menu and an action | `menus`, `actions` | under an existing app or the module's own |
| An approval policy | `approvals` | the RFC 0003 shape |
| An automation rule | `automationRules` (new in the manifest), installed as `automation.rule` records owned by the module | a rule made in the Automation app can be **moved into** a Studio module |
| Access | `accessLevels`: `<module>.user`, `<module>.manager` | required by CLAUDE.md, made for every Studio module |

Out of version 1: computed fields with code, Python-like expressions, report layouts (the PDF designer of
RFC 0005 already stores templates as records), changes to other modules' business logic.

### 5.2 The artefact

```
src/modules/<name>/
  studio.json        # the specification: the only file Studio reads and writes
  index.ts           # generated: the manifest (do not edit; regenerated from studio.json)
  models.ts          # generated: extendModel / defineModel
  .kosh/             # the typed view (pnpm generate:models), as for any module
  README.md          # generated: what the module changes, for reviewers
```

The generator is deterministic (same spec, same bytes) and lives in `@kosh/studio` (also `kosh studio build`),
so a developer can take over: delete `studio.json`, keep the TypeScript, and Studio stops managing the module.
Field and model names get the module's prefix (`x_` plus the module name) so they never collide with a future
version of the app they extend.

### 5.3 Two ways to apply

- **Development / single server** (`KOSH_STUDIO=write`): Studio writes the files into the project, plans the
  migration (Shutro's planner, as `kosh apps` does), shows the SQL and the diff, and on "Apply" installs or
  upgrades the module through the App manager; the app host reloads every node (RFC 0008 step 2). Seconds, no
  deploy.
- **Production** (`KOSH_STUDIO=propose`, the default): Studio produces a **change proposal**: the diff of the
  module folder, downloadable as a patch or pushed as a branch with a pull request when a git provider is
  configured (`KOSH_STUDIO_GIT_URL`, token in the secret store). The change reaches production through the
  normal pipeline (CI runs the module's generated tests; deploy; `kosh apps upgrade <name>`). Studio never writes
  code on a production server.

### 5.4 App manager: upgrade

The App manager installs, disables and enables; Studio needs **upgrade**: a module whose code version is newer
than the installed one gets a migration planned from the difference (new columns, new tables, dropped columns only
with an explicit "remove data" like uninstall), applied in one transaction with the installed set's version
bump, audited. `kosh apps upgrade <name>` and the Apps page's "Upgrade" use it. Studio bumps the module's patch
version on every apply.

### 5.5 Safety

- Studio is `studio.manager` (administrators by default): it changes the schema.
- Removing a field Studio added asks for "keep the column" (default: the field leaves the model, the column
  stays, data is not lost) or "remove data" (the column is dropped in the migration, after a confirmation that
  names the records affected).
- A view extension is checked at save against the served views: an anchor that does not exist is refused with
  the ids that do.
- Every apply writes the App manager's log (who, the spec diff, the SQL).

### 5.6 The UI

A **Studio** mode on any screen (a toggle in the header for `studio.manager`): click a form section to add a
field there, a list header to add a column, a menu to add an entry; a side panel edits the selected thing; "Review
changes" shows the spec diff, the generated code diff and the migration SQL; "Apply" (write mode) or "Propose"
(propose mode). A **Studio** app lists the Studio modules with their pending and applied changes.

### 5.7 Tests

The generator: specs to code, deterministic, every change kind, round trip (spec → code → load → describe equals
the spec). The App manager's upgrade on real PostgreSQL (a new field column added, a model added, a removed field
kept or dropped, rolled back on failure). Studio's API in write mode (a field added appears in the API, the form,
the search; permissions: a non-manager is refused) and propose mode (a patch, nothing written). E2E: add a field
to a form in Studio mode, apply, fill it on a record.

## 6. Delivery plan (each step reviewed)

1. The spec format and the generator (`@kosh/studio`, `kosh studio build`), with the round-trip tests.
2. App manager upgrade (`kosh apps upgrade`, the Apps page), with migrations planned from the version difference.
3. The Studio API (write and propose modes), field and model changes, the review (diffs, SQL).
4. Studio mode in the back-office for fields, columns, form sections and menus; E2E.
5. Approvals and automation rules in Studio modules (`automationRules` in the manifest); git proposals.

## 7. Open questions (answers wanted with the approval)

- **Where Studio modules live**: the installation's `src/modules/` (proposed, they belong to the installation),
  or a separate repository per installation?
- **Propose mode's git integration** in version 1 (GitHub and GitLab pull requests), or patches only at first?
- **Prefix**: `x_<module>_` for fields on other apps' models (proposed), or the module name alone?
- **Who may use Studio**: administrators only (proposed), or a separate `studio.manager` role they grant?

## Implementation notes (2026-10-26): step 1 — the spec and the generator

- `@kosh/studio`: `StudioSpec` and `validateSpec` (every problem with where it is: `fields[2].target`),
  `generateModule` (deterministic; `models.ts` with `extendModel` per extended model and `defineModel` per own
  model, `index.ts` with access levels, views, searches, view extensions, actions, menus and approvals,
  `README.md`), `buildModule` / `runStudio` (`kosh studio build`, writing only the files that changed).
- **The prefix is camelCase**: Shutro field keys are `[a-z][a-zA-Z0-9]*`, so `x_<module>_` became `x<Module>`
  (`xAcmeGstNumber`, column `x_acme_gst_number`); own models are `x_<module>.<name>`.
- A list view has no container node: list columns are anchored on a column (`insertAfter: 'city'`), noted in the
  spec type.
- Tests: `packages/studio/test/studio.test.ts`: validation, literals and prefixes, determinism, the round trip (the
  generated module, with workspace imports, loads next to a fixture app through `buildKoshRegistry`: prefixed
  fields on the extended model, the own model, the view extensions by node id, menus, actions and access levels),
  a missing anchor failing at load, and `kosh studio build`.

## Implementation notes (2026-10-26): step 2 — App manager upgrade

- `planApps` takes `upgrade` (installed modules moving to their code's version; never back, unchanged when equal)
  and `outdatedApps` lists them; `prepareApps` accepts the database being behind the code only for an upgrade
  (the drift is the upgrade), refuses destructive statements unless `removeData`; `applyApps` runs Shutro's
  `applyMigrations` for upgrades even without schema statements (it runs the modules' data migrations and records
  their versions), reloads the upgraded modules' seed data and the defaults, and records the version, the log and
  the audit event in the change's transaction.
- `kosh apps upgrade [app …] [--remove-data]` (default: every outdated app), the catalogue listing shows the
  installed version when it is behind; the Settings API takes `upgrade` and the Apps page has Upgrade (it never
  removes data: that stays a deliberate command).
- Found on the way: `kosh_app_log.change` holds the change as a JSON string inside the jsonb (the parameter was
  encoded twice); readers parse it twice for now (the test does); a fix with a data migration of the log later.
- Tests: the planner (upgrade, unchanged, back refused, not installed, the outdated list); on PostgreSQL, a module
  at 1.0.0 upgraded to 1.1.0 (a column added, its data migration filling it, the version and the log), refused
  back, empty again, and 2.0.0 dropping a column refused until "remove data".

## Alignment with CLAUDE.md

"Customizable without forking" and "explicit over magic": a Studio change is a module, traceable to the module
that made it, reviewable and upgrade-safe. No ORM feature is re-implemented: fields and models are Shutro
`extendModel` / `defineModel`, migrations Shutro's planner, views RFC 0004's extensions by node id. The App
manager gains one operation (upgrade) that developers' modules need as much as Studio's.
