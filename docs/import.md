# Data import

`@kosh/import` (RFC 0014) turns CSV and Excel files into records of any model: business apps, custom models and
Studio fields alike, with no code. It runs as the user: their permissions, field security, record rules,
constraints and sequences apply to every row, as if each record were typed in a form.

## Who can import

A user needs the **Import data** access level (`import.user`) **and**, on the model, the `import` permission
plus `create` (to create) or `write` (to update). Administrators pass. The **Import** button next to a list's
**New** appears only for users who have both.

## The screen

1. **File**: a CSV (UTF-8, UTF-16 or Windows-1252; `,` `;` tab or `|` separators, found automatically) or an XLSX
   workbook. **Download a sample file** gives a workbook with the headers to fill and a second sheet that says what
   each column takes.
2. **Columns**: each column of the file with its first values and the field it fills, guessed from the headers
   (the field labels and keys; an export from Shutro ERP re-imports as it is). Choose:
   - **What to do**: create new records, update existing ones, or both. Updates find records by a **key** column:
     the record id, an external id, or a field the model keeps unique (a product code, an email).
   - **Rows with errors**: import nothing if any row has an error (the default), or import the others and download
     the rejected rows as a file with an Error column, ready to fix and import again.
   - How dates (`31/12/2026` or `12/31/2026`) and decimals (`1,250.50` or `1.250,50`) are written.
   - A saved mapping to apply, or save this one (for yourself, or shared with every import user of the company).
3. **Check** runs the whole import and rolls it back: every error, with its row and column. **Import** does it.
   The result says what was created and updated; **Undo this import** stays available for 7 days.

Files of more than 2,000 rows run in the background: the screen shows the progress, and a notification arrives
when the check or the import ends.

## What a cell can say

| Field | Accepted |
|---|---|
| Numbers, amounts | `1250.50`, `1,250.50`, `1.250,50` (with the comma option), `(1,200.00)`, `৳ ১২,৫০০`. Amounts stay exact (`Decimal`) |
| Dates | `2026-12-31`, `31/12/2026` (or the order you chose), `31.12.26`, a date cell of Excel |
| Date and time | `31/12/2026 16:30`, `4:30 PM`, ISO with an offset; times without one are in the chosen time zone |
| Yes / no | yes, no, true, false, 1, 0, x, হ্যাঁ, না |
| Choices | the value or its label (`Sent`, `sent`) |
| Links to a record | its external id (`legacy.partner_42`), a unique code (`C-002`), or its name. A name that matches several records is an error, never a guess |
| Several links | names, codes or external ids separated by commas |

Excel formulas are read as their last computed value, never evaluated.

## Lines

A row whose own columns are empty continues the record above it, and its line columns (**Lines › Product**,
**Lines › Quantity**) add a line:

```csv
Name,Customer,Lines › Product,Lines › Quantity
SO-50,C-001,Rice,2
,,Lentils,1
SO-51,C-002,Salt,3
```

Updating a record with lines replaces its lines, so a file exported with its lines imports back to the same
records instead of doubling them.

## External ids

With an **External ID** column, created records are named (`partner_42` becomes `__import__.partner_42`) so a
later file updates them. Ids of installed modules (`contacts.…`) belong to their modules' data and are refused.

## Templates in a module

A module ships templates for its models in its manifest; the import screen offers them, applies one to a file
that has its headers, and downloads it as a sample workbook:

```ts
export default defineModule({
  // ...
  importTemplates: [
    {
      key: 'customers',
      model: 'res.partner',
      label: 'Customers',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Email', field: 'email' },
        { header: 'Customer', field: 'isCustomer' },
      ],
      options: { mode: 'upsert', key: 'email' },
    },
  ],
});
```

## The API

Every step is an API call, for scripts and other tools (`docs/rfcs/0014-data-import.md` §5.7):

```sh
# Upload: the file is the body. The answer is the session with its guessed mapping.
curl -X POST "$KOSH/api/v1/imports?model=res.partner" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: text/csv' -H 'X-Filename: partners.csv' --data-binary @partners.csv
# Options and columns, then a check, then the import.
curl -X PUT  "$KOSH/api/v1/imports/7/mapping" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"columns":[{"index":0,"field":"name"},{"index":1,"field":"email"}],"options":{"mode":"upsert","key":"email"}}'
curl -X POST "$KOSH/api/v1/imports/7/dry-run" -H "Authorization: Bearer $TOKEN"
curl -X POST "$KOSH/api/v1/imports/7/commit"  -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: partners-2026-10-27'
```

`POST /api/v1/models/:model/import` remains for scripts that already have typed values: rows of field values in,
ids out.

## Limits

50 MB and 1 million rows per file (`SHUTRO_ERP_IMPORT_MAX_BYTES`, `SHUTRO_ERP_IMPORT_MAX_ROWS`). Every check, import and undo
is in the audit log (`data.import`, `data.import.undo`).
