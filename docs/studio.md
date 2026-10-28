# Shutro ERP Studio (RFC 0012)

Studio changes an installation without code and without database customizations: every change is a **module**
in `src/modules/<name>/`, made of `studio.json` (the specification, the only file Studio reads and writes) and the
TypeScript generated from it. It is reviewed, versioned and installed like any module.

RFC 0012 is implemented: the specification, the generator, the App manager's upgrade (a changed Studio module is
applied with `shutro-erp apps upgrade <name>`), the Studio API (review, apply, propose), Studio mode in the back-office,
and approval policies and automation rules in Studio modules. Proposals are patches, or pull requests on GitHub and
merge requests on GitLab when a repository is configured.

## Studio mode

Administrators and Studio managers see a **Studio** button in the header. While it is on:

- each **form section** ends with **Add field**: a label, a type (text, long text, whole or decimal number, date,
  date and time, yes / no, a choice with its options, a link to a record), required, track changes;
- a **list** has **Add column**: a field the model has but the list does not show, or a new field;
- the **Studio app** (Studio → Modules) lists the Studio modules, adds a **model** of the module's own with its
  fields and a menu entry in the module's app, adds an **approval policy** (levels in order, each with an approver
  group and an optional "only when this field is above"), and **moves a rule** made in the Automation app into a
  module (the original is archived on apply; in propose mode, archive it after deploying).

The dialog asks which Studio module saves the change (a new module `custom`, "Customizations", the first time),
then **Review changes** shows what the server will do: the module's version (install, or upgrade to the next patch),
the diff of every file and the database statements. **Apply** (write mode) installs or upgrades the module and the
page reloads with the change; in propose mode the button downloads the patch instead. The browser only says where
and what: the server names the field (`GST number` → `gstNumber`, column `x_custom_gst_number`), adds the
dependencies, merges the view change, and checks everything again on apply.

## The specification

```json
{
  "name": "acme",
  "label": "Acme customizations",
  "version": "0.1.0",
  "depends": ["contacts"],
  "app": { "label": "Fleet", "icon": "box" },
  "fields": [
    { "model": "res.partner", "name": "gstNumber", "type": "char", "label": "GST number", "tracking": true },
    { "model": "res.partner", "name": "tier", "type": "selection", "label": "Tier",
      "options": { "gold": "Gold", "silver": "Silver" }, "default": "silver" }
  ],
  "models": [
    { "name": "vehicle", "label": "Vehicle", "archivable": true, "fields": [
      { "name": "plate", "type": "char", "label": "Plate", "required": true },
      { "name": "owner", "type": "many2one", "label": "Owner", "target": "res.partner" }
    ] }
  ],
  "viewChanges": [
    { "view": "res.partner.form", "operations": [{ "insertAfter": "email", "fields": ["gstNumber", "tier"] }] },
    { "view": "res.partner.list", "operations": [{ "insertAfter": "city", "fields": ["tier"] }] }
  ],
  "menus": [{ "id": "vehicles", "label": "Vehicles", "model": "vehicle" }],
  "approvals": []
}
```

- **Fields on another module's model** get the module's prefix: `gstNumber` of module `acme` is `xAcmeGstNumber`
  (column `x_acme_gst_number`), so a future version of the app never collides with it. Types: char, text,
  integer, decimal (`scale`), monetary (`currency`, default `currency`), date, datetime, boolean, selection
  (`options`), many2one and many2many (`target`); `required`, `default`, `help`, `tracking` (the change log, and
  automation rules can watch it), `groups` (field security).
- **Models of its own** are `x_<module>.<name>`, with a list, a form and a search, and access for the module's
  two groups (`<module>.user`, `<module>.manager`).
- **View changes** use RFC 0004's operations on **node ids** (`insertAfter`, `insertBefore`, `append` into a form
  group, `remove`, `setAttrs`); a list's columns are anchored on a column. An anchor that does not exist fails at
  load with the anchors that do, naming the view.
- **Menus** open a model's records (an action is made for each), under the module's app or a `parent` menu.
- **Approvals** are RFC 0003 policies, installed by the Permissions app (by name, once: administrators edit them
  afterwards).
- **Automation rules** (`automationRules`: `id`, `name`, `model`, `trigger`, `actions`, and the rule editor's other
  fields) are shipped by the module and installed by the Automation app as rules owned by it (see
  docs/automation.md): an upgrade rewrites them, keeping their on/off switch.

## Building

```sh
npx shutro-erp studio build            # every src/modules/*/studio.json
npx shutro-erp studio build src/modules/acme
```

The generator is deterministic (the same spec gives the same bytes) and writes only the files that changed:
`models.ts` (the Shutro side), `index.ts` (the manifest), `README.md` (what the module changes, for reviewers).
Then list the module in `src/modules.ts` and install it (`shutro-erp apps install acme`). To take a module over as
code, delete `studio.json`: Studio stops managing it and the TypeScript is yours.

## The Studio API

Studio is the `studio` module (in the starter's `src/modules.ts`, installed by `shutro-erp init`). Only Administrators
and holders of **Studio** (`studio.manager`) reach it; it changes the schema.

| Route | Does |
| --- | --- |
| `GET /api/v1/studio` | the mode and the Studio modules of the project |
| `GET /api/v1/studio/modules/:name` | a module's `studio.json` and generated files |
| `POST /api/v1/studio/edit` `{ module?, label?, edit }` | a change (`field`, `show`, `model`, `approval`, `rule`, `move-rule`) merged into the module's spec, and the rules to archive (`retire`) |
| `GET /api/v1/studio/rules` | the rules made in the Automation app (movable) |
| `POST /api/v1/studio/preview` `{ spec }` | the review; changes nothing |
| `POST /api/v1/studio/apply` `{ spec, planId, retire? }` | write mode: installs or upgrades the module, writes its files, archives the moved rules |
| `POST /api/v1/studio/propose` `{ spec }` | the change as a patch; writes nothing |

The **review** (`preview`) holds the spec as it will be applied (an installed module moves to at least its next
patch version), `change` (`install` or `upgrade`) and `from`, the unified **diff** of every file of
`src/modules/<name>/` and of `src/modules.ts` (a new module is listed there), the migration's **SQL**, whether it
is destructive, and a `planId`. `apply` plans again and refuses (409) when the plan is no longer the one reviewed.
The database changes first, in one App manager transaction (logged and audited); then the files are written and
the server serves the new module at once.

Refused: an invalid spec (400, every problem with where it is), a dependency that is not in the catalogue (400),
the name of a module Studio does not manage (409), a disabled module (409), a view change whose anchor the view
does not have (422), a change that would drop data (409: removing data stays a deliberate
`shutro-erp apps upgrade <name> --remove-data`).

**Modes** (`.env`):

```sh
SHUTRO_ERP_STUDIO=propose   # the default: Studio returns patches, never writes code (production)
SHUTRO_ERP_STUDIO=write     # development or one server: Studio writes src/modules/<name>/ and applies at once
SHUTRO_ERP_STUDIO_DIR=.     # the project folder (default: the working directory)
```

In propose mode the patch (`git apply`) goes through review, CI and deploy, then `shutro-erp apps upgrade <name>` (or
`install`). With a repository configured, "Open a pull request" (GitHub) or "Open a merge request" (GitLab) pushes
the change on a branch of its own (`studio/<name>-<version>`, a fresh one if it exists) from the base branch and
opens the request, its description naming the command to run after deploying and the database changes
(`POST /api/v1/studio/propose` with `pullRequest: true`):

```sh
SHUTRO_ERP_STUDIO_GIT_URL=https://github.com/acme/erp   # or https://gitlab.example.com/group/erp
SHUTRO_ERP_STUDIO_GIT_TOKEN=...                         # from the environment or the secret manager; never stored
SHUTRO_ERP_STUDIO_GIT_BASE=main
# SHUTRO_ERP_STUDIO_GIT_PROVIDER=github|gitlab           # when the host does not say; SHUTRO_ERP_STUDIO_GIT_API for self-hosted
```

The token needs the rights to push branches and open requests (GitHub: contents and pull requests; GitLab: `api`).
Studio's API never returns it. Write mode changes this server only: other servers serve the module once they run the new code, so
use it where there is one. To plan, Studio loads the generated module from `.kosh-studio/plan/` in the project
(removed at once; keep `.kosh-studio/` out of git).

