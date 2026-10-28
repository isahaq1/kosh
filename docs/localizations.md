# Country localizations

A country is a module (`l10n_bd` Bangladesh, `l10n_in` India). It declares what a company in that country starts
with — the chart of accounts, the accounts of its taxes, the withholdings, the fiscal year and how numbers are
grouped — and ships the country's taxes, tax identifiers, documents and returns. Accounting itself is
country-neutral: several taxes per line in sequence (supplementary duty before VAT), withholding at payment,
fiscal years starting in any month, amounts in words, lakh / crore grouping (RFC 0016).

Everything a localization installs becomes the company's data: rates, accounts and templates are edited in
Accounting › Configuration and the document designer, and upgrades never overwrite them.

## Installing

- A new installation: `npx kosh init --country BD` or `--country IN` (the defaults for BDT and INR). The localization comes
  with Accounting, like a bridge.
- An existing one: install `l10n_bd` in Settings › Apps (or `kosh apps install l10n_bd`). Its defaults set up each
  company that has no chart yet; a company already on another chart is left alone.
- A company created later: Accounting › Configuration › Settings lists the installed localizations' charts beside
  the generic one; installing `Bangladesh` there applies the whole localization to that company.

## Declaring a localization

```ts
import type { LocalizationSpec } from '@kosh/modules-sdk';
import { COMMON_ACCOUNTS, DEFAULT_ACCOUNTS } from '@kosh/accounting';

export const BANGLADESH: LocalizationSpec = {
  key: 'bd', // the chart's code
  country: 'BD',
  label: 'Bangladesh',
  chart: {
    accounts: [...COMMON_ACCOUNTS, { code: '2200', name: 'Output VAT (Mushak)', type: 'liability_current' }],
    defaults: DEFAULT_ACCOUNTS,
    taxAccounts: { sale: '2200', purchase: '1300' }, // for taxes without an account
  },
  taxes: { 'l10n_bd.tax_sale_vat15': '2200' }, // the module's own taxes (data records) → their account
  withholdings: [{ name: 'VDS (the full VAT)', direction: 'vendor', base: 'tax', rate: '1', account: '2240' }],
  fiscalYearStart: 7, // July
  grouping: 'lakh',
};

export const l10nBd = defineModule({
  shutro: l10nBdShutro, // the taxes as `noupdate` data, the identifier fields with their checks
  depends: [accounting, contacts],
  localization: BANGLADESH,
  hooks: { defaults: (env) => localize(env) }, // installLocalization for companies without a chart
  documents: MUSHAK_DOCUMENTS,
  // …
});
```

`installLocalization(env, spec)` (Accounting) applies it to the company of `env`, once and idempotently: the chart
when there is none, the accounts of the declared taxes, the withholdings it lacks, the fiscal year's first month,
the grouping and the current fiscal year.

## Bangladesh (`l10n_bd`)

| | |
| --- | --- |
| Chart | the generic accounts plus output and input VAT, VAT payable, advance tax (AT), supplementary duty (SD), AIT, TDS and VDS |
| Taxes | VAT 15 % (standard), 10 %, 7.5 %, 5 %, exempt, zero-rated (exports); purchase VAT 15 %, 5 %, exempt; SD 10 %, 20 %, 30 %, 45 % before VAT; AT 5 % on imports |
| Withholdings | VDS (the full VAT of a bill), TDS 5 % (supplies) and 10 % (services) from suppliers; AIT 3 % kept back by customers |
| Year and numbers | July–June fiscal year; 1,00,000.00 grouping; amounts in words in English and Bangla |
| Identifiers | BIN (13 digits) and TIN (12 digits) on companies and contacts, checked; on the contact form for contacts in Bangladesh |

Each tax has a **Mushak kind** (on the tax form): standard, reduced, zero-rated, exempt, SD or AT. It decides where
the tax goes in the registers and the return; a VAT tax without one is listed as "without a Mushak VAT kind".
Product lines of invoices and bills store their SD, VAT and total with taxes.

Rates follow the VAT and Supplementary Duty Act 2012 and the income tax rules as commonly applied; withholding
rates change with each Finance Act — check them in Accounting › Configuration › Withholdings.

### Documents

Printed from an invoice or a payment (Reporting's documents), editable in the designer:

- **Tax invoice (Mushak 6.3)**: seller and buyer with their BIN, the date and time of issue, each line's value,
  SD, VAT and total, the totals and the total in words.
- **Credit note (Mushak 6.7)**: the same, with the tax invoice it corrects and the reason.
- **Certificate of VAT deducted at source (Mushak 6.6)**: on a payment with VDS — the withholding entity and the
  supplier with their BIN, each deduction with what it was computed on.

### Registers and the monthly return

Accounting › Reporting › **Mushak returns** (accountants), for a month:

- **Sales register (6.2)** and **purchase register (6.1)**: a row per product line of the posted invoices or bills
  and their credit notes (negative): date, number, customer or supplier and BIN, description, quantity, value, SD,
  VAT, total and VAT band.
- **Monthly return (9.1), summary**: supplies and purchases by VAT band (part 3 and 4), VAT deducted at source from
  suppliers (part 5), VAT deducted by customers and AT paid on imports (part 6), and the net tax (part 7): output
  VAT − input VAT + increasing − decreasing adjustments, with the SD payable.

Each downloads as XLSX and PDF. The same is available to scripts:

```http
GET /api/v1/l10n_bd/mushak/9.1?month=2026-10                 # JSON
GET /api/v1/l10n_bd/mushak/6.2?month=2026-10&format=xlsx     # or format=pdf
```

Reading needs the right to read journal entries; a file needs the right to export them and is recorded in the
audit log. Amounts are in taka: a line in another currency converts at its document's rate.

**Limits**, for now: the return is filed on the NBR's online system (it has no API for third parties) — Kosh
prepares what is entered there. The registers have no stock columns until Inventory exists. The BIN's check digit
is not verified (only its 13 digits) until the NBR's algorithm is confirmed. Debit notes (Mushak 6.8) wait for
debit notes in Accounting.

## India (`l10n_in`)

| | |
| --- | --- |
| Chart | the generic accounts plus CGST, SGST / UTGST, IGST and cess payable and input credit, GST payable under reverse charge, TDS payable and receivable |
| GST | one tax per slab — 0.25 %, 3 %, 5 %, 12 %, 18 %, 28 % — for sales and for purchases, each with its components: CGST and SGST (half each) within the state, IGST between states and abroad |
| Other taxes | nil-rated, exempt, non-GST, zero-rated exports under LUT; compensation cess 1 %, 3 %, 12 %, 15 %, 22 %; purchases under reverse charge at 5 %, 12 %, 18 %, 28 % |
| TDS | 194C 1 % / 2 %, 194J 10 % / 2 %, 194H 2 %, 194-I 10 % when paying vendors; 2 % kept back by customers |
| Year and numbers | April–March fiscal year; 1,00,000.00 grouping |
| Identifiers | GSTIN (format, check digit, its state code against the contact's state) and PAN on companies and contacts; HSN / SAC on products |

**Within the state or not.** Set the company's state in Accounting › Configuration › Settings (`IN-MH`), and the
contacts' states. A document's place of supply is the customer's state unless set on the document; posting writes
CGST and SGST when it is the company's state, IGST otherwise and for customers abroad. The tax on the line stays
`GST 18%` either way, and totals do not change; only the posted tax lines differ. Each product line also stores its
CGST, SGST, IGST and cess, its GST rate and its total for the tax invoice.

**Reverse charge.** A bill with a reverse-charge GST is paid to the supplier without the tax; posting writes the
input credit and the GST payable by the company, net zero. The tax invoice says whether tax is payable on reverse
charge.

**Documents**: the tax invoice (supplier and recipient with their GSTIN, the place of supply, each line's HSN / SAC,
taxable value, GST rate, CGST, SGST, IGST and cess, the total in words), the credit note and the debit note.

### GST returns

Accounting › Reporting › **GST returns** (accountants), for a month:

- **GSTR-1** by section: B2B invoices by the recipient's GSTIN (4A), B2C large invoices — unregistered, between
  states, above ₹1,00,000 (5), exports with IGST paid or under LUT (6A), other B2C summed by place of supply and rate
  (7), credit and debit notes to registered and unregistered recipients (9B), nil-rated / exempt / non-GST supplies
  and the HSN summary. As XLSX (a sheet per section), PDF, and the **GST portal's offline JSON** (check it against
  the current offline tool's schema before uploading: the portal changes it).
- **GSTR-3B**: 3.1 (a)–(e) outward supplies and inward supplies under reverse charge, 4 (A)(3) and (A)(5) input tax
  credit, 5 exempt inward supplies from another state and within it, and 6.1 the tax payable, the credit and what
  is left to pay by head (negative: carried forward). As XLSX and PDF.

```http
GET /api/v1/l10n_in/gstr/1?month=2026-10                  # JSON (with the summary by section)
GET /api/v1/l10n_in/gstr/1?month=2026-10&format=portal    # the portal's JSON; or format=xlsx | pdf
GET /api/v1/l10n_in/gstr/3b?month=2026-10&format=pdf
```

Reading needs the right to read journal entries; a file the right to export them, recorded in the audit log.
Amounts are in rupees through the posted balances. A line whose GST tax has no GST treatment is in no section (the
screen counts them). Not yet: amendments, advances (11A / 11B), the documents issued table (13), the credit
utilisation order of 6.1, and filing (the portal has no API for this; a GSP's would be part 4's adapter).

### E-invoicing and e-way bills

Set the company up on the GST returns page (**Company GST settings**: GSTIN — checked against the company's state —,
PAN, address and PIN code) and switch e-invoicing on. Then every posted customer invoice, credit or debit note to a
registered customer or abroad is registered with the IRP: the IRN, the acknowledgement and the signed QR code come
back onto the document, and the tax invoice prints them. What the IRP would refuse (no GSTIN, no PIN code, a line
without HSN / SAC…) is said on the document first, in words, to fix and register again from the **E-invoice** panel
of the invoice. An IRN is cancelled within 24 hours (after that, issue a credit note). From the same panel, an
invoice's **e-way bill** is generated with its transport (mode, distance, vehicle, transporter), valid one day per
200 km by road, and cancelled within 24 hours.

```http
POST /api/v1/l10n_in/einvoice/42                   # register (the subscriber does it when posted)
POST /api/v1/l10n_in/einvoice/42/cancel            # { "reason": "2", "remark": "Wrong rate" }
POST /api/v1/l10n_in/ewaybill/42                   # { "mode": "road", "distanceKm": 450, "vehicleNo": "MH12AB1234" }
GET  /api/v1/l10n_in/einvoice/42                   # the document's e-invoice and e-way bill
```

The IRP and the e-way bill system are reached through a **provider** (`GstProvider`: NIC's APIs directly, or a GST
Suvidha Provider), given to the module (`l10nInModule({ provider })`) or named by the environment. For now there is
the fake provider (`KOSH_GST_PROVIDER=fake`, for demonstrations: it answers as the IRP does, the IRN being the SHA-256
of the seller's GSTIN, the financial year, the document type and number); a real adapter comes with sandbox
credentials. Without a provider the screens say e-invoicing is not set up. The IRN fields are written by the system
only. Not yet: the QR code printed as an image (the signed content is stored), part B updates of an e-way bill, and
e-way bills for deliveries without an invoice.

Rates and TDS thresholds change with the GST Council and each Finance Act: check them in Accounting › Configuration.
