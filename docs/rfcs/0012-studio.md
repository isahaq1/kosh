# RFC 0012: Kosh Studio

- **Status:** Accepted 2026-10-26 with the proposed answers (the installation's `src/modules/`, patches first, the prefix, administrators); implemented 2026-10-26 (steps 1–5; git pull requests added 2026-10-27; `docs/studio.md`)
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
- Found on the way: `kosh_app_log.change` held the change as a JSON string inside the jsonb (the parameter was
  encoded twice). Fixed 2026-10-27: the value goes to the driver unencoded, and the log's table preparation (at
  every app change) turns old rows back into objects. The idempotency table had the same fault (a replayed
  response was a JSON string): fixed the same way, repaired at server start.
- Tests: the planner (upgrade, unchanged, back refused, not installed, the outdated list); on PostgreSQL, a module
  at 1.0.0 upgraded to 1.1.0 (a column added, its data migration filling it, the version and the log), refused
  back, empty again, and 2.0.0 dropping a column refused until "remove data".

## Implementation notes (2026-10-26): step 3 — the Studio API

- The `studio` module (`@kosh/studio`, group `studio.manager`, in the starter's catalogue and default set):
  `GET /api/v1/studio`, `GET …/modules/:name`, `POST …/preview`, `…/apply` (write mode), `…/propose`.
- A review generates the files, loads the generated module from `.kosh-studio/plan/<name>-<uuid>/` (as deep in the
  project as `src/modules/<name>/`, so the imports are the same; removed at once, also in propose mode), plans
  with the App manager on the catalogue with the module replaced (`install`, or `upgrade` to at least the next
  patch of the installed version), and checks the view changes against the views as served (a missing anchor is
  a 422 at preview, not a failed reload). The diff is a small unified diff (`unifiedDiff`, `git apply` reads it).
- Apply: the plan id must match; the database first (one App manager transaction), then the files and
  `src/modules.ts`, then `AppsContext.serveModule` (new: the app host's catalogue takes the new code) and a reload.
  Write mode is single-server by design: another node serves the change once it runs the new code.
- Safety: names of modules Studio does not manage (no `studio.json`) and `base`, `settings`, `studio` are refused;
  dependencies must be in the catalogue; a destructive change is refused (dropping data stays
  `kosh apps upgrade --remove-data`).
- Tests (`packages/studio/test/studio-api.integration.test.ts`, real PostgreSQL and HTTP): every route refuses
  anonymous and non-Studio users; invalid specs, unknown dependencies, taken names and missing anchors; a preview
  with the SQL and the diff and nothing written; a stale plan refused; apply installs, the REST API serves the field
  at once, the files and `src/modules.ts` are written; a second apply upgrades to 0.1.1 with one `ADD COLUMN`;
  propose mode returns a patch, refuses apply and writes nothing. The diff is applied with `git apply` in a test.

## Implementation notes (2026-10-26): step 4 — Studio mode in the back-office

- `@kosh/ui` has a **design mode** (`DesignProvider`, `useDesign`): while it is on, a form section ends with "Add
  field" and a list's toolbar has "Add column"; the renderers only report the spot (view, model, group or last
  column). The shell provides it to every screen.
- `@kosh/studio/web`: the header item `studio.Toggle` (shown when `GET /api/v1/studio` answers, so only to
  Administrators and Studio managers), the add dialog (module, new field or a field the model has), the review
  dialog (the code diff and the SQL, Apply or Download patch), and the Studio app's page `studio.Studio` (the
  Studio modules, a new model with its fields and a menu). English and Bangla.
- The server merges the change: `POST /api/v1/studio/edit` (`applyEdit`) names the field from its label (free
  names `gstNumber2`), the model from its label (`fuel_log`), adds the dependencies on the modules owning the
  models and views, merges view changes per view; a field on a Studio model goes on the model (its generated views
  show every field). The `studio` module is now an app (Studio → Modules).
- Found on the way: (1) a dependency only present as another app's dependency was refused (the check now walks
  the catalogue's closure); (2) after an apply, the database's NOTIFY could rebuild the server with the old code
  before Studio handed the new one over, and Studio's own reload then saw no change: the app host now rebuilds
  whenever module code was handed over (`serveModule`), and puts the new module first in its catalogue (the first
  module of a name wins in the dependency walk). Both have tests (the host test; the E2E on the e2e Contacts app,
  a dependency of another app). `useModule` was renamed `serveModule` (a `use…` name reads as a React hook).
- Tests: `applyEdit` (fields and free names, a column, a model with a menu, a field on a Studio model, an unknown
  model refused); `POST /api/v1/studio/edit` on PostgreSQL (the spec, refusals, non-managers 403); E2E
  `apps/web/e2e/studio.spec.ts`: Studio mode on a contact, Add field in a section, review (new module, ADD COLUMN),
  apply, fill and save the field; Add column with a field the model has (an upgrade, no SQL); the Studio page;
  a user without Studio sees no button and is refused (403).

## Implementation notes (2026-10-26): step 5 — approvals and automation rules

- The manifest has `automationRules` (`AutomationRuleSpec` by key, checked by `defineModule`). The Automation app
  (version 0.2.0: `module` and `moduleKey` on `automation.rule`) installs them in its `defaults` hook after every
  app change, in every company: created as declared, rewritten by upgrades keeping the on/off switch, archived when
  no longer declared; rules of modules not served are left alone.
- The Studio spec has `automationRules` (with a local `id`) and validates `approvals` and rules; the generator
  writes both into `index.ts` and the README. Edits `approval` and `rule` add them (free keys from names) with the
  dependencies (`permissions`, `automation`, the model's owner); `move-rule` turns a rule of the Automation app the
  caller reads (not one a module ships: 409) into a Studio rule and returns it in `retire`; `apply` archives the
  retired rules as the caller once the module is installed. `GET /api/v1/studio/rules` lists the movable rules.
- The Studio page has "Approval policy" (levels with an approver group and an optional amount threshold, kept as a
  decimal string) and "Rules made in the Automation app" with "Move into module".
- Git proposals: not in version 1 (the accepted answer, "patches first"); propose mode returns the patch.
- Tests: the module rules on PostgreSQL (installed, firing, an upgrade keeping the switch, archived when dropped);
  the edits, validation and generation; the API moving a rule and adding a policy (the module's copy installed,
  the original archived, the policy installed, an owned rule refused); E2E: "Move into module" on the Studio page.

## Implementation notes (2026-10-27): git proposals

- After "patches first", proposals can open requests: `KOSH_STUDIO_GIT_URL` and `KOSH_STUDIO_GIT_TOKEN` (the
  environment or the secret manager filling it, as CLAUDE.md asks of secrets: Kosh keeps no store of its own),
  `KOSH_STUDIO_GIT_BASE`, and the provider from the host or `KOSH_STUDIO_GIT_PROVIDER` (`KOSH_STUDIO_GIT_API` for
  self-hosted GitHub Enterprise or GitLab).
- GitHub: the base branch's head, a branch `studio/<name>-<version>` (a suffix when the name is taken), one
  `PUT contents` per changed file (with the file's sha when it exists), a pull request. GitLab: one commit of
  create / update actions starting from the base branch, a merge request. Only the changed files go, with their whole
  new content; the description names `kosh apps install|upgrade <name>` and the SQL. A refusal is a 502 naming what
  was refused; the patch still downloads. `GET /api/v1/studio` names the repository, never the token.
- The review dialog in propose mode has "Open a pull request" / "Open a merge request" with the link once opened.
- Tests: the settings from the environment (GitHub, GitLab with subgroups, GitHub Enterprise); a proposal on fake
  GitHub and GitLab APIs (a taken branch, created and updated files, the requests); a refusal; the route on
  PostgreSQL (the five files of a new module, the description, nothing written, refused without a repository).

## Alignment with CLAUDE.md

"Customizable without forking" and "explicit over magic": a Studio change is a module, traceable to the module
that made it, reviewable and upgrade-safe. No ORM feature is re-implemented: fields and models are Shutro
`extendModel` / `defineModel`, migrations Shutro's planner, views RFC 0004's extensions by node id. The App
manager gains one operation (upgrade) that developers' modules need as much as Studio's.
