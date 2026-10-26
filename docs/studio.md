# Kosh Studio (RFC 0012)

Studio changes an installation without code and without database customizations: every change is a **module**
in `src/modules/<name>/`, made of `studio.json` (the specification, the only file Studio reads and writes) and the
TypeScript generated from it. It is reviewed, versioned and installed like any module.

Steps 1–2 are the specification, the generator and the App manager's upgrade (a changed Studio module is
applied with `kosh apps upgrade <name>`); the Studio API and the Studio mode of the back-office follow RFC 0012's
plan.

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
