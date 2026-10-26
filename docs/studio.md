# Kosh Studio (RFC 0012)

Studio changes an installation without code and without database customizations: every change is a **module**
in `src/modules/<name>/`, made of `studio.json` (the specification, the only file Studio reads and writes) and the
TypeScript generated from it. It is reviewed, versioned and installed like any module.

Steps 1–3 are the specification, the generator, the App manager's upgrade (a changed Studio module is applied
with `kosh apps upgrade <name>`) and the Studio API (review, apply, propose); the Studio mode of the back-office
follows RFC 0012's plan.

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
- **Approvals** are RFC 0003 policies.

## Building

```sh
npx kosh studio build            # every src/modules/*/studio.json
npx kosh studio build src/modules/acme
```

The generator is deterministic (the same spec gives the same bytes) and writes only the files that changed:
`models.ts` (the Shutro side), `index.ts` (the manifest), `README.md` (what the module changes, for reviewers).
Then list the module in `src/modules.ts` and install it (`kosh apps install acme`). To take a module over as
code, delete `studio.json`: Studio stops managing it and the TypeScript is yours.

## The Studio API

Studio is the `studio` module (in the starter's `src/modules.ts`, installed by `kosh init`). Only Administrators
and holders of **Studio** (`studio.manager`) reach it; it changes the schema.

| Route | Does |
| --- | --- |
| `GET /api/v1/studio` | the mode and the Studio modules of the project |
| `GET /api/v1/studio/modules/:name` | a module's `studio.json` and generated files |
| `POST /api/v1/studio/preview` `{ spec }` | the review; changes nothing |
| `POST /api/v1/studio/apply` `{ spec, planId }` | write mode: installs or upgrades the module, writes its files |
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
`kosh apps upgrade <name> --remove-data`).

**Modes** (`.env`):

```sh
KOSH_STUDIO=propose   # the default: Studio returns patches, never writes code (production)
KOSH_STUDIO=write     # development or one server: Studio writes src/modules/<name>/ and applies at once
KOSH_STUDIO_DIR=.     # the project folder (default: the working directory)
```

In propose mode the patch (`git apply`) goes through review, CI and deploy, then `kosh apps upgrade <name>` (or
`install`). Write mode changes this server only: other servers serve the module once they run the new code, so
use it where there is one. To plan, Studio loads the generated module from `.kosh-studio/plan/` in the project
(removed at once; keep `.kosh-studio/` out of git).

