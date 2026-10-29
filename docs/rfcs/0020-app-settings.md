# RFC 0020: App settings — every app's own settings, in one place, declared once

- **Status:** Accepted (2026-10-29)
- **Depends on:** 0001 (module manifest), 0003 (permissions), 0008 (Settings app), 0019 (Settings)
- **Asked for (2026-10-29):** "make settings and all module more professional and flexible than odoo" — chosen
  first: *settings per app*.

## 1. Summary

Each app declares its settings in its manifest — sections of typed fields with labels, help, defaults, who may
change them and whether they hold per company or for the whole installation — and Settings shows them: one page per
app under **Settings › Apps**, found by the Settings search, saved through one checked, audited API. On top of the
values themselves: **who changed what and when**, **reset to the default**, **copy a company's settings to
another**, **export and import** as a file, and the apps' **document numbering** with a preview of the next number.

## 2. How Odoo does it, and its weaknesses

- **One long page** (`res.config.settings`): every installed app's checkboxes on a single scroll, a transient
  model that is recomputed and written on every save — slow, and a save can touch settings you never looked at.
- **Settings install modules**: ticking a box may install an app, silently, with its data — configuration and
  installation are mixed.
- **Per company or global is unclear**: some values follow the current company, some are global system
  parameters; the screen does not say which.
- **No history, no default, no copy**: who changed the lock date? what was the old value? a new company starts
  from nothing; moving a setup from a test database to production is manual.
- **Numbering** (`ir.sequence`) hides in the *Technical* menu in debug mode, with no preview.
- **A developer's work**: a module's settings need a transient model, an XML view, `config_parameter` or
  `related` fields and an `execute` override.

## 3. Design

### 3.1 Declaring settings (manifest)

```ts
defineModule({
  // …
  settings: {
    sections: [
      {
        key: 'quotations',
        label: 'Quotations',
        description: 'How new quotations start and how long they stay valid.',
        keywords: 'quote validity terms',
        scope: 'company',               // 'company' (per company) or 'installation'
        editors: ['sales.manager'],     // who may change it (Administrators always)
        fields: [
          { key: 'quotationValidityDays', type: 'integer', label: 'Valid for (days)', default: 30, min: 1, max: 365 },
          { key: 'defaultPaymentTerm', type: 'many2one', model: 'account.payment_term', label: 'Payment terms' },
          { key: 'requireSignature', type: 'boolean', label: 'Ask for a signature online', default: true,
            help: 'Customers sign in the portal before the order is confirmed.' },
        ],
      },
    ],
  },
});
```

- **Field types**: boolean, integer, decimal (Shutro `Decimal`), char, text, selection, many2one, date; each with
  label, help, default, bounds or options, and `visibleWhen` (another setting's value) for dependent settings.
- **Storage**:
  - `scope: 'company'` — the field **is** a `res.company` field the module adds with `extendModel` (as Accounting
    already does for its lock dates and accounts): typed, validated and checked by Shutro, readable in code as
    `company.quotationValidityDays`. The section only names it and adds the help, bounds and editors.
  - `scope: 'installation'` — a `settings.value` record per key (private model in `@kosh/settings`: key, JSON value,
    changed by, changed at); typed on read by the declaration.
- **Validation at load**: unknown types, a company field the module does not declare, a section without editors
  that is not administrator-only, and duplicate keys fail the module's load, like other manifest errors.
- **In code**: `settings(env).get('sales.quotationValidityDays')` returns the typed value for the current company
  (or the installation), with the default when unset.

### 3.2 Screens

- **Settings › Apps › *the app*** (one page per app that declares settings, in the Settings sidebar and the
  overview): its sections as cards; each field with its label, help and current value; **Save** per section, only
  what changed is sent; for company settings, the company it applies to is named and switchable.
- **A badge** on settings that differ from the default, with **Reset**; **History** per field (from the audit log:
  who, when, old → new).
- **Search**: the overview's search covers every section's label, description, keywords and fields' labels.
- **Copy to another company** (administrators): all or chosen sections, previewed (which values change) before
  saving. **Export / Import** a JSON file of the installation's and a company's settings, also previewed.
- **Not here**: installing apps. A setting that needs another app says so with a link to the App manager; nothing is
  installed from a settings page.

### 3.3 Document numbering

- **Settings › Apps › *the app* › Numbering**: every sequence the app declares (orders, invoices…), with its format
  (prefix, padding, suffix, reset yearly / monthly) and the **next number**, previewed as it will print
  (`SO/2026/00042`), per company. Changing the next number below what is already used is refused.
- This needs Shutro: sequences are code-defined today. **Shutro request #31**: runtime overrides of a sequence's
  format and next number per company, read and written through Shutro (audited), with a guard against going back.
  Until it is answered, Numbering shows the formats and next numbers read-only.

### 3.4 Server

- `GET /api/v1/settings/apps` → the apps with settings the user may see; `GET /api/v1/settings/apps/:app` → its
  sections with values, defaults, changed-from-default and editable flags, for the current company.
- `PATCH /api/v1/settings/apps/:app/:section` `{ values }` — validated against the declaration (types, bounds,
  options, many2one existence through the user's own rights), written as the user for company fields (Shutro checks
  the field security) or to `settings.value`; audited `settings.changed` with old and new values.
- `POST …/:section/reset` `{ keys }`; `GET …/:section/history?key=`; `POST /api/v1/settings/apps/copy`
  `{ from, to, sections, preview }`; `GET /api/v1/settings/export`, `POST /api/v1/settings/import` `{ file,
  preview }`.
- Permission: view needs the app's access; change needs one of the section's `editors` or Administrator.

### 3.5 First adopters

- **Sales**: quotation validity, default payment terms, online signature and payment, down payments.
- **Purchase**: approval threshold and levels (the existing approval policy, edited here), default receipt lead time.
- **Accounting**: fiscal year start, lock dates, default accounts (already company fields), rounding.
- **Contacts**: required fields for a new customer (tax id, phone), duplicate warning.
- **Projects**: default stages, timesheet rounding.

## 4. Delivery plan (each step reviewed, with screenshots)

1. The `settings` declaration and its validation, `settings.value`, the read helper, the apps' settings API, the
   per-app page with sections, Save, defaults and Reset; Sales, Purchase and Accounting declare their first sections.
2. History per field, Copy to another company, Export / Import with previews; Contacts and Projects sections.
3. Numbering: read-only formats and next numbers now; editing once Shutro request #31 is in.

## 5. Open questions

1. **Storage for company settings**: as `res.company` fields through `extendModel` (proposed: typed, Shutro-checked,
   readable in code), or everything in `settings.value`?
2. **Shutro request #31** (runtime sequence formats and next numbers): ask Shutro for it (proposed), or keep
   numbering code-only?
3. **Order**: this RFC now, before the visual polish pass and custom fields from any form?

## Alignment with CLAUDE.md

- Metadata-driven: a module declares its settings once; the screens, API, search, permissions, history and export
  follow. Customizable without forking: a module may add sections to another app's page (`extends` with
  `settings.sections`), traceable to it.
- Secure by default: every change is checked on the server against the declaration and the section's editors,
  written as the user, audited. Money settings use Shutro `Decimal`.
- Kosh does not reimplement ORM features: company settings are Shutro fields; sequences wait for Shutro (#31).

## Decisions (2026-10-29)

1. **Storage**: company settings are `res.company` fields the apps add (typed, checked by Shutro); installation-wide
   ones a key / value record.
2. **Shutro request #31** (runtime sequence formats and next numbers): asked of Shutro; Numbering is read-only
   until it is in.
3. **Order**: this RFC now; step 1 first.

## Implementation notes (2026-10-29): step 1 — the declaration, the API and the page

- **Declaration** (`@kosh/modules-sdk`: `SettingsSpec`, `SettingsSectionSpec`, `SettingFieldSpec`): company sections
  name `res.company` fields (type, label and default from Shutro's metadata, so nothing is declared twice);
  installation sections declare type, label, default and options. Types: boolean, integer, decimal (a string, never
  a JS number), char, text, selection, date; bounds, help and `visibleWhen`. Many2one settings wait for a picker
  that searches as the user. Checked when the server starts (the Settings app reads every declaration).
- **Storage**: company fields; `kosh.setting` (base, private) for installation values; `installationSetting()` in
  `@kosh/server` reads them in code.
- **API** under `/api/v1/settings/app-settings` (not `/settings/apps`, the App manager's): the apps the user may see
  (those whose access levels they hold, or administrators), an app's sections with values, defaults,
  changed-from-default and editable, `PATCH` a section (only the given keys; each checked against its setting; only
  what changed is written; `settings.changed` audited with the old and new values) and `reset`.
- **Screen**: Settings › App settings (Apps group): the apps on the left (`?app=` in the address), each section a
  card with its scope (*For this company* / *For every company*), the settings with their help, *Changed* and
  *Reset* (the default in its tooltip), *Save* and *Discard* per section, read-only for those who may only see it;
  dates on the app's own calendar. The Settings search finds the page by any section's or setting's words.
- **First adopters**: Sales — quotations valid for N days (from the order date; 0 leaves it open) and default terms,
  applied by the order form's onchanges (Shutro defaults are synchronous, so they cannot read the company); Purchase
  — default terms; Accounting — fiscal year start, lock date, tax lock date (existing company fields). Sales and
  Purchase move to 0.3.0 for their new company columns.
- **Tests**: on real PostgreSQL — a test app's company and installation sections: who sees them, the field's metadata,
  editors only, checked values (bounds, options, unknown keys), audit with old and new values, reset; a wrong
  declaration stops the server; Sales' onchanges fill the validity and terms from the company and move the validity
  with the date. E2E (apps): found by the Settings search, changed, kept after a reload, marked, reset; Accounting's
  section.

