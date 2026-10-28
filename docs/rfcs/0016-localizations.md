# RFC 0016: Country localizations (Bangladesh first)

- **Status:** Accepted 2026-10-27 with the proposed answers (several taxes per line; the Bangladeshi taxes move to
  `l10n_bd`; VDS / TDS and the Mushak forms in version 1; India (GST) as the second localization)
- **Depends on:** 0001 (manifests), 0005 (documents, reports), 0008 (apps, `kosh init`), 0009 (accounting), 0015
  (portal: payment details on invoices)

## 1. Summary

A localization is a module per country (`l10n_bd`) that makes Kosh lawful and natural for a company there out of
the box:

- its chart of accounts, taxes and fiscal year;
- its tax identifiers on companies and contacts, checked;
- its legal documents (the tax invoice) and its tax reports, in the official layout;
- withholding at payment where the law asks for it;
- amounts in words and number grouping as people write them.

Kosh's accounting stays country-neutral; a localization declares what is local in its manifest. `kosh init` asks
for the country and installs the matching localization. Bangladesh comes first, with VAT and SD under the VAT and
Supplementary Duty Act 2012 (the "Mushak" forms), VDS and TDS withholding, BIN and TIN, and a July–June fiscal year.

## 2. Problem

Today Bangladesh is half-built in. The Bangladesh chart lives inside Accounting next to the generic one, and its VAT
rates are data of the Products module (`product.tax_sale_vat15`…), so every installation has Bangladeshi taxes,
whatever its country. And what a Bangladeshi company needs on day one cannot be expressed:

- **SD before VAT**: supplementary duty is charged first and VAT on the price plus SD. A line has one tax with one
  rate, so this cannot be computed.
- **VDS and TDS**: withholding entities deduct VAT and income tax when they pay a bill, and must issue a
  certificate (Mushak 6.6 for VDS). A payment has no withholding.
- **The tax invoice** (Mushak 6.3) must show the seller's and buyer's BIN, and per item the value, SD and VAT. There
  is no BIN, and the invoice template is generic.
- **The registers and the return**: the purchase register (Mushak 6.1), the sales register (6.2) and the monthly
  return (9.1) are what accountants prepare every month. Nothing produces them.
- **Numbers**: amounts are written in lakh and crore, and invoices state the total in words ("Taka one lakh twenty
  thousand only", in English or Bangla).
- **Payment details**: there is no company bank account, so invoices (and the portal, RFC 0015) cannot show where
  to pay.

## 3. How Odoo does it, and its weaknesses

Odoo ships `l10n_*` modules: XML/CSV data for the chart, taxes and fiscal positions, plus Python for the country's
reports. Its tax engine is strong: taxes on a line are a list; a tax can affect the base of the next one; groups;
price-included taxes.

- **Bangladesh** (`l10n_bd`, recent versions) has a chart and VAT taxes, but no Mushak forms or registers, no BIN
  check, and no VDS/TDS. Those come from paid third-party apps, each with its own idea of the data.
- **Localizations are data dumps.** Taxes, accounts and report lines are thousands of XML records keyed by external
  ids. Adapting them to a company means editing records that the next upgrade may overwrite (`noupdate` games).
- **Withholding** is not in the standard; partner identifiers are checked by an external library (`stdnum`) for some
  countries only.
- **Reports** are defined with the `account.report` engine, powerful but hard to read or change without Studio.

## 4. Options

- **A. Localization modules with a typed `localization` declaration in the manifest**: the chart, taxes, fiscal
  year, identifiers, documents and reports as typed data and functions. Accounting gains the general mechanisms
  every country needs (taxes affecting later taxes, withholding at payment, bank accounts, amounts in words).
  `l10n_bd` declares Bangladesh with them.
- **B. Bangladesh code inside Accounting**, behind a country switch. Fastest for one country, but every later
  country edits the core, and the generic installation carries all of them.
- **C. Odoo's approach, localizations as data files only**: hard to check, hard to upgrade, and reports still need
  code.

## 5. Recommendation: A

### 5.1 What Accounting gains (country-neutral)

1. **Several taxes per line, in order** (`taxes`, a many2many replacing the single `tax`), each with
   `sequence`, a kind (`percent`, `fixed` per unit) and **`affectsBase`**: a tax whose amount is added to the base
   of the following ones. "SD 20% then VAT 15%" is two taxes, the SD affecting the base. Totals stay exact
   (`Decimal`, per currency), rounded per line or per document as the company chooses. Sales and Purchase lines
   follow (`taxes` instead of `tax`). A data migration moves each line's `tax` into `taxes`.
2. **Withholding at payment**: `account.withholding` (a rate, a payable account, whether it applies to vendors or
   to customers who withhold from us, a threshold). Registering a payment of a bill proposes the withholdings that
   apply to the vendor. The payment then posts the withheld part to the withholding account and pays the rest. The
   bill is settled in full, and a certificate document is printed per withholding.
3. **Company bank accounts** (`res.partner.bank`: bank, branch, account number, routing number; a default per
   company and currency), shown on invoices and in the portal (closing the gap left by RFC 0015).
4. **Amounts in words** in documents (`{{amountTotal | words}}`), by language and currency, and **lakh/crore
   grouping** for companies whose localization asks for it (the formatter's grouping, server and browser).
5. **Fiscal years** that start on any month (the company's `fiscalYearStart`), used by closing and the reports'
   periods.

### 5.2 The `localization` declaration

```ts
export default defineModule({
  shutro: l10nBdShutro,
  depends: [accounting],
  localization: {
    country: 'BD',
    label: 'Bangladesh',
    chart: bdChart,                // accounts, journals, default accounts (typed, as CHARTS today)
    taxes: bdTaxes,                // sale and purchase taxes with their accounts and order
    withholdings: bdWithholdings,  // VDS and TDS rates
    fiscalYearStart: 7,            // July
    grouping: 'lakh',
    identifiers: {                 // on companies and contacts
      bin: { label: 'BIN', pattern: /^\d{13}$/, check: binCheck },
      tin: { label: 'TIN', pattern: /^\d{12}$/ },
    },
    documents: [mushak63],         // the tax invoice, a document template (RFC 0005)
    reports: [mushak61, mushak62, mushak91, mushak66],
  },
});
```

Installing the localization for a company (Accounting → Settings, or `kosh init`) applies the chart, taxes,
withholdings, fiscal year and grouping, once, like the chart install today. After that everything is the company's
data to change; upgrades never overwrite it (it is `noupdate`). Accounting's settings list the localizations that
are installed, instead of today's fixed `generic` / `bd`. The generic chart stays in Accounting for companies
without one.

### 5.3 `l10n_bd` (version 1)

- **Chart**: the current Bangladesh chart, moved from Accounting (output and input VAT, VAT payable, AT, SD, AIT,
  TDS, VDS).
- **Taxes**: VAT 15 % (standard), 10 %, 7.5 %, 5 %, exempt and zero-rated (exports); SD at the common rates,
  affecting the VAT base; AT 5 % on imports (recoverable). The Bangladeshi taxes leave Products' data: their
  external ids move from `product.*` to `l10n_bd.*` in a data migration, so existing records and their references
  stay.
- **Withholding**: VDS at the rates of the VDS schedule (by service), and TDS (income tax at source) by the
  section's rate, with thresholds.
- **Identifiers**: the 13-digit BIN on companies and contacts (format checked; the check digit when the NBR's
  algorithm is confirmed), the 12-digit TIN; both on the tax invoice.
- **Documents**: the Mushak 6.3 tax invoice (seller and buyer BIN, per item value, SD and VAT, total in words);
  the Mushak 6.6 VDS certificate; credit and debit notes (Mushak 6.7 / 6.8).
- **Reports**: the purchase and sales registers (Mushak 6.1, 6.2) and the monthly return summary (Mushak 9.1, its
  sections filled from the posted documents of the month), each on screen, as XLSX in the NBR's column order, and as
  PDF. Filing stays on the NBR's online system (it has no API for third parties); Kosh prepares what is entered there.
- **Fiscal year** July–June; lakh/crore grouping; amounts in words in English and Bangla (taka and paisa).

### 5.4 Contacts and countries

`res.partner` and `res.company` get **tax identifiers by country** from the installed localizations: a field per
declared identifier (`bin`, `tin`), shown when the contact's country matches, checked on save. The existing
`taxId` stays for countries without a localization.

### 5.5 Tests

- Tax engine: SD then VAT on one line, fixed and percent taxes, line and document rounding, per currency, exempt
  and zero-rated; sales, purchase and invoice totals agree; the migration from `tax` to `taxes`.
- Withholding: a bill paid with VDS and TDS: the entries, the bill settled, the certificates; thresholds.
- `l10n_bd`: installing for a company, BIN checks, the tax invoice's fields, the registers and 9.1 sums against
  hand-computed months; the external id move from Products.
- E2E: a Bangladeshi company from `kosh init --country BD`: a sale with SD and VAT, its Mushak 6.3, a bill paid with
  VDS, the month's 9.1.

## 6. Delivery plan (each step reviewed)

1. Accounting: several taxes per line with `affectsBase`, the migration from `tax`; company bank accounts; fiscal
   year start; amounts in words and grouping in documents and the formatter.
2. Withholding at payment with certificates.
3. The `localization` declaration and its installer; Accounting's settings and `kosh init --country`; `l10n_bd`
   with its chart, taxes (moved from Products), withholdings, identifiers.
4. `l10n_bd` documents and reports (Mushak 6.3, 6.6, 6.7/6.8, 6.1, 6.2, 9.1); E2E; `docs/localizations.md`.
5. `l10n_in`, India (GST): CGST and SGST within a state, IGST between states (by place of supply), GSTIN on
   companies and contacts, HSN / SAC codes, TDS; the tax invoice and the GSTR-1 / GSTR-3B summaries. It checks the
   declaration against a very different tax shape.

## 7. Open questions (answers wanted with the approval)

- **Several taxes per line** (proposed: `taxes` replaces `tax` on sales, purchase and invoice lines, with a data
  migration), or keep one tax per line and express "SD then VAT" as a single combined tax? The first is what VAT
  law needs and what other countries will need; it touches Sales, Purchase and Accounting.
- **Move the Bangladeshi taxes out of Products** into `l10n_bd` (proposed, with the external-id migration), so a
  company elsewhere does not get them?
- **Withholding in version 1** (proposed: VDS and TDS at payment, with certificates), or later?
- **The 9.1 return**: a filled summary plus the registers, for entry on the NBR's system (proposed), since there is
  no filing API?
- **Next countries**: which after Bangladesh (India GST, for example), so the declaration is checked against a
  second one early?

## Implementation notes (2026-10-27): step 1, part 1 — several taxes per line

- **The engine** (`computeTaxes` in `@kosh/product`, where taxes live): taxes in `sequence` order, a percentage of
  the base or a fixed amount per unit, `affectsBase` adding a tax to the base of the ones after it, and taxes
  included in the price solved exactly (the included taxes are linear in their base). Decimals throughout; rounding
  stays per document at posting.
- **`account.tax`** gains `sequence`, `amountType`, `fixedAmount`, `affectsBase`; `priceIncluded` moves from
  Accounting's extension to the tax itself, so sales and purchase lines honour it too (before, only invoices did).
- **Lines**: `taxes` (many2many) on sales, purchase and invoice lines, and `taxes` / `purchaseTaxes` on products,
  computed through the engine. The single `tax` / `purchaseTax` fields stay as read-only fields this version:
  Shutro applies schema changes before data migrations, so the 0.2.0 migrations of Products, Sales, Purchase and
  Accounting copy them into the lists first, and a later version drops them.
- **Posting** makes one tax line per tax with `taxBase`, the base it was computed on (SD in the VAT's base); the
  tax report pivots the tax lines (base and amount per tax) instead of product lines. The quotation and invoice
  templates print each line's tax amount (documents do not print a list).
- **Form line editors** send a line's many2many values as `{ set }`. Shutro request #29 (fixed): an onchange handler
  can set a many2many, and the set comes back as ids.
- **Tests**: the engine (5), an invoice with SD then VAT (the totals, one tax line each with its base and account),
  and the existing Sales, Purchase, Accounting and bridge suites on the lists.

## Implementation notes (2026-10-27): step 1, part 2 — bank accounts, fiscal years, words, grouping

- **Bank accounts** (`res.bank.account`, Accounting › Configuration › Bank accounts): bank, branch, account number,
  holder, routing number, SWIFT, and a currency (an account without one shows on every invoice). Every user may read
  them (they are printed on invoices); accounting managers change them. A customer invoice's **`paymentDetails`**
  (computed, not stored) lists the accounts in its currency and the reference to quote. It is printed on the invoice
  template and shown in the portal (`account_portal`), which closes the gap RFC 0015 left.
- **Fiscal years**: the company's `fiscalYearStart` (month 1–12, checked) and `fiscalYearOf(date, start)`. On the
  fiscal year form, the first day fills the last day and the name (`2026–27`). The localization installer (step 3)
  will create the first year from it.
- **Amounts in words**: `{{amountTotal|words}}` in document templates (template checks accept the filter).
  `amountInWords` writes English in lakh and crore for BDT, INR, PKR, NPR and LKR, and in thousands and millions
  otherwise; Bangla always in lakh and crore (the 100 Bangla number words). Taka / paisa, rupees / paise, dollars /
  cents, and "Only" / "মাত্র". The invoice and quotation templates print the total in words.
- **Grouping**: the company's `numberGrouping` (`international`, `lakh`) on `res.company` (base). `GET
  /api/v1/auth/me` gives the grouping of each of the user's companies; the back-office formatter and printed
  documents then group English as `1,23,45,678` (`en-IN`). Bangla groups by lakh already.
- **Tests**: words (3), the formatter's grouping (1), payment details by currency with the reference and none on
  bills, fiscal year dates.

## Implementation notes (2026-10-27): step 2 — withholding at payment

- **`account.withholding`** (Accounting › Configuration › Withholdings): a rate on the documents' untaxed amount,
  their tax or their total, a threshold on the document total, an account, and a direction. `vendor`: we keep it
  back when paying a bill, and owe it to the state. `customer`: a customer keeps it back when paying our invoice,
  and the state owes it to us. A contact lists the withholdings that apply to them (`withholdings`, on the contact
  form through a view extension).
- **The proposal** (`POST /api/v1/accounting/payments/propose { moves }`): the partner's withholdings in the payment's
  direction, for documents reaching their threshold, on a base prorated to what is still due, rounded to the
  currency, in their sequence. The cash to pay is the residual less them.
- **The payment** (`withholdings` lines, `amountWithheld`): the register route takes `withholdings: [{ withholding,
  amount }]` (none by default, as before). Posting settles the documents by the cash **plus** the withheld amounts:
  the payable or receivable line takes the whole, the bank the cash, and each withholding's account its part. The
  documents are paid in full and reconciled as before.
- **The screen**: Register payment shows the proposed withholdings, each amount editable, and the cash due less
  them, computed in exact decimals in the browser.
- **The certificate**: a document template on payments (`accounting.withholding_certificate`): the payee, the
  payment, each withholding's base and amount, the total in words. `l10n_bd` will add the Mushak 6.6 layout.
- **Tests**: a bill paid with VDS (all the VAT) and TDS (5 % above a threshold) — the proposal, the entry's four
  lines, the bill paid; a bill below the threshold with VDS only; a customer withholding from us.

## Implementation notes (2026-10-27): step 3 — the declaration, its installer and `l10n_bd`

- **`localization`** in a Kosh manifest (`LocalizationSpec`, `@kosh/modules-sdk`): a key (the chart's code, `bd`),
  the country, a label, the chart (accounts, default accounts, the accounts taxes without one get), the accounts
  of the module's own taxes by external id, withholdings, the fiscal year's first month and the grouping. The
  identifiers, documents and reports of §5.2 are not in it: identifiers are ordinary fields of the module's
  `extendModel` (with their checks), and documents and reports are templates and report definitions like any
  other (step 4). A declaration carries only what an installer has to apply once per company.
- **The installer** (`installLocalization`, Accounting): the chart when the company has none, the accounts of the
  localization's taxes (a tax the users deleted is skipped), the withholdings it lacks (by name), the fiscal year's
  start and the grouping, and the current fiscal year when there is none. Running it again changes nothing.
- **Accounting** keeps only the generic chart. `GET /api/v1/accounting/charts` lists it and the installed
  localizations' charts; installing a localization's key runs the installer. `res.company.chartTemplate` is now a
  short text, not a fixed selection.
- **`l10n_bd`**: the Bangladesh chart (moved from Accounting), the 14 VAT, SD and AT taxes (moved from Products:
  their external ids move from `product.*` to `l10n_bd.*` in Products' 0.2.0 migration, so existing databases keep
  the records and every line pointing at them), VDS (all the VAT) and TDS 5 % / 10 % on vendors, AIT 3 % kept back
  by customers, a July–June year and lakh grouping; BIN (13 digits) and TIN (12 digits) on contacts and companies,
  checked, shown on the contact form for contacts in Bangladesh. Its `defaults` hook sets up each company without a
  chart (or with the Bangladesh one); a company on another chart is left alone. The BIN's check digit waits for the
  NBR's algorithm to be confirmed.
- **Without a localization** the demo data and the apps' tests have no country taxes: demos look the VAT up by
  name and leave lines untaxed when there is none, and tests create the taxes they use.
- **`kosh init`** asks for the country (`--country`; BD by default for BDT): a localization is installed with the
  apps it bridges (Accounting), like a bridge. The demo catalogue and the apps' E2E server install `l10n_bd`.
- **Tests**: `l10n_bd` installed with Accounting — the chart, every tax with its account, the four withholdings, the
  company's fiscal year start, grouping and fiscal year; the defaults run twice; the chart install refused once
  installed; BIN and TIN checks; a second company on the generic chart untouched. `kosh init` with the defaults
  (BDT, every app) installs it.

## Implementation notes (2026-10-27): step 4 — the Mushak documents, registers and return

- **Mushak kinds**: `account.tax.mushak` (standard, reduced, zero-rated, exempt, SD, AT), set on the Bangladesh
  taxes and editable on the tax form. Product lines store `sdAmount`, `vatAmount` and `totalWithTaxes`, from the
  same tax engine as their totals.
- **Documents** (templates of `l10n_bd`): the tax invoice (6.3) and the credit note (6.7) on invoices, the
  certificate of VAT deducted at source (6.6) on payments. Debit notes (6.8) wait for debit notes in Accounting.
- **Registers and return**: `GET /api/v1/l10n_bd/mushak/{6.1|6.2|9.1}?month=…[&format=xlsx|pdf]`, as the user
  (read right on entries; export right and an audit event for files), and the Mushak returns page under Accounting ›
  Reporting (English and Bangla). Rows are the posted product lines of the month, in taka through their posted
  balance, credit notes negative, banded by the Mushak kind of their VAT tax. 9.1 adds AT from the posted AT tax
  lines and VDS from withholdings on the VAT of posted payments: deducted by us (part 5) or by our customers
  (part 6). The 9.1 here is the summary of its parts, not the NBR's note numbering; the registers have no stock
  columns until Inventory.
- **Tests**: the 6.3 amounts (SD 200, VAT 180 on price plus SD) and its HTML with both BINs; the registers with a
  credit note, the 9.1 net VAT with AT and VDS (105 − 300 + 300 − 100 = 5), XLSX and PDF with their audit events,
  400 / 404 / 403. E2E: the page shows the month's invoice and downloads the return.
- **Docs**: `docs/localizations.md`.

## Step 5 design: India (`l10n_in`), approved 2026-10-28

Answers given: CGST / SGST or IGST are chosen **at posting** from one GST tax on the line (not by mapping taxes,
Odoo's fiscal positions); version 1 also has **reverse charge**, **GST cess**, **e-invoicing (IRN, QR)** and
**e-way bills**.

### 5.a Accounting (country-neutral)

- **Tax components**: a tax may have components (`account.tax.component`: name, share of the rate, account,
  `scope`: `intra` | `inter` | `always`, and a report `kind`). `GST 18%` has CGST 9 % and SGST 9 % (intra) and IGST
  18 % (inter). Lines, orders and invoice totals keep one tax and one amount — the engine is unchanged; posting
  writes one tax line per component of the document's scope (the tax amount split by share, the rounding paisa on
  the last), each to its account, with its base. A tax without components posts as today.
- **Place of supply**: `state` (ISO 3166-2, `IN-MH`) on contacts, and `country` / `state` on companies (their
  registered place). Invoices and bills get `placeOfSupply` (a state), from the partner's state, editable. Scope:
  `intra` when the place of supply is the company's state, `inter` otherwise and for another country (exports).
  Generic: any country with a federal tax split can use it.
- **Reverse charge**: a tax flag `reverseCharge`. On a bill its amount is not added to the total (the supplier is
  not paid it); posting writes the tax as payable (output) and as claimable (input) — two opposite lines, net zero.
  The document shows it, and the returns read it.
- Tests: the split and its rounding, intra / inter / export, reverse charge entries, totals unchanged.

### 5.b `l10n_in`

- **Chart** (Indian Accounting Standards headings): CGST, SGST, IGST and cess payable and input credit, GST under
  reverse charge, TDS payable, TDS receivable; April–March year; lakh / crore grouping.
- **Taxes**: GST 0 %, 0.25 %, 3 %, 5 %, 12 %, 18 %, 28 % for sales and purchases with their components; nil-rated,
  exempt and non-GST; zero-rated exports (with and without IGST paid); reverse-charge variants for purchases;
  compensation cess (percent; fixed per unit where the rate is so).
- **Identifiers**: GSTIN (15 characters, its check digit verified, its state code matching the contact's state, its
  PAN inside), PAN (10 characters) on contacts and companies.
- **HSN / SAC** on products (`hsnCode`, 4–8 digits; a service flag), printed on lines.
- **TDS** (income tax, by section): 194C contractors 1 % / 2 %, 194J professional fees 10 %, 194H commission, 194I
  rent, with thresholds — as withholdings (step 2), rates to be checked each Finance Act.
- **Documents**: the tax invoice (rule 46: both GSTINs, place of supply, HSN / SAC, taxable value and each tax per
  line, reverse charge yes / no, total in words, the IRN and its QR once registered) and the credit note.
- **Returns**: GSTR-1 (B2B by GSTIN, B2C large and small, exports, credit notes, nil / exempt, HSN summary) on
  screen, as XLSX and as the GST portal's offline JSON; GSTR-3B (3.1 outward and reverse-charge inward supplies, 4
  input credit, 5 exempt inward, the tax payable by head) on screen, XLSX and PDF.

### 5.c E-invoicing and e-way bills

- **Payloads** built from posted documents: the IRP e-invoice schema (version 1.1: transaction, document, seller,
  buyer, items with HSN and each tax, totals) and the e-way bill (part A from the invoice, part B: transporter,
  vehicle, distance — asked on a dialog).
- **Providers** behind an adapter (`EInvoiceProvider`: generate, cancel; `EwayBillProvider`: generate, update part
  B, cancel), like the `Messenger` of notifications: credentials per company from the environment / secret
  manager, never in records. Registration runs as a job after posting (outbox), retried; the IRN, acknowledgement
  and signed QR are stored on the invoice and printed; the 24-hour cancellation window is enforced.
- Tests run against a fake provider that checks the payload. A real adapter is written for one provider once there
  are sandbox credentials to test it (see the open question); until then the feature is off.

### Delivery (each part reviewed)

1. 5.a in Accounting (components, place of supply, reverse charge).
2. `l10n_in`: chart, taxes, cess, identifiers, HSN / SAC, TDS, the tax invoice and credit note.
3. GSTR-1 and GSTR-3B (screen, XLSX, PDF, GSTR-1 JSON); E2E.
4. E-invoicing and e-way bills with the fake provider; then a real adapter.

### Decisions (2026-10-28)

- **E-invoice and e-way bill access**: decided at part 4, when sandbox credentials exist (NIC direct or a GSP);
  parts 1–3 and part 4 with the fake provider come first.
- **Debit notes** come in part 1: customer and vendor debit notes (`out_debit`, `in_debit`) post like invoices and
  link to the invoice they add to; they also give Bangladesh its Mushak 6.8.

## Implementation notes (2026-10-28): step 5, part 1 — components, place of supply, reverse charge, debit notes

- **Tax components** (`account.tax.component`: name, code, share, scope `always` / `intra` / `inter`, accounts for
  invoices, credit notes and reverse charge), on the tax form with the tax's own accounts. Posting allocates each
  tax's rounded amount between the components of the document's scope by share (the odd paisa on the first), one
  tax line per component (`taxComponent`), each with the tax's base. Shares of a scope not adding up to 1 are
  refused at posting. Lines, orders and invoice totals keep the tax whole.
- **Place of supply**: `state` (ISO 3166-2) on contacts; `country` and `state` on the company, in Accounting ›
  Settings (the localization sets the country); `placeOfSupply` on documents, from the partner's state at posting
  unless set. The scope is `inter` for a partner in another country, else the place of supply against the
  company's state; `intra` when either is unknown.
- **Reverse charge**: `reverseCharge` on taxes (Products: the engine computes it but leaves it out of the totals);
  on bills, posting writes what may be claimed (the tax or component account) and what is owed (its reverse-charge
  account), both marked `taxReverseCharge`, net zero; on customer documents it posts nothing.
- **Debit notes**: `out_debit` and `in_debit`, posted like invoices, `debitOf` the invoice they add to; with
  invoices and bills in the lists and the portal; Bangladesh's Mushak 6.8 and its registers count them.
- **Fixed**: a vendor credit note's counterpart was the receivable account; it is now the payable one (documents
  of customers settle on receivables, of vendors on payables). Posted entries are not rewritten.
- Products 0.3.0, Accounting 0.3.0, Contacts 0.2.0 (new columns; no data migration).
- **Tests**: within the state (9.01 + 9.00 of 18.01), between states, abroad, the place of supply set on the
  document, reverse charge on a bill, shares refused, a debit note, a vendor credit note on payables; the engine
  with reverse charge and cess.

## Implementation notes (2026-10-28): step 5, part 2 — `l10n_in`

- **Chart, taxes, components**: the India chart (CGST / SGST / IGST / cess payable and input credit, reverse-charge
  payables, TDS); GST per slab for sales and purchases, each with CGST and SGST (`intra`, half each) and IGST
  (`inter`) as data records; purchases under reverse charge; cess; nil-rated, exempt, non-GST, zero-rated (LUT).
  The localization declaration gained `components` (external id → account, and the reverse-charge account); the
  installer sets them per company. `gstTreatment` on taxes says where the returns (part 3) put them.
- **Identifiers**: GSTIN checked for its format, its check digit (Luhn mod 36) and its state code against the
  contact's or company's state (old and new ISO 3166-2 codes of the renamed states); PAN; HSN / SAC on products.
- **Lines** store `cgstAmount`, `sgstAmount`, `igstAmount`, `cessAmount`, `gstRate` and `totalWithGst`, split by the
  document's place of supply as posting splits them; documents store `gstReverseCharge`.
- **Documents**: the tax invoice (rule 46 fields), the credit note and the debit note.
- **TDS** withholdings by section; their thresholds are annual or per payment and are not applied per document:
  to check, like the rates.
- **`kosh init`**: India for INR (`--country IN`).
- **Tests**: the installed setup (every component's account, cess, withholdings, April year, lakh); GSTIN check
  digit and state, PAN, HSN; an invoice within Maharashtra (CGST 4,500 + SGST 4,500) and one to Karnataka (IGST
  9,000) with their line heads and the tax invoice; a bill under reverse charge (input 1,800, payable 1,800, the
  vendor owed 10,000).

## Alignment with CLAUDE.md

"Money is always `Decimal`": every tax and withholding amount, per currency. "Metadata-driven": a country is a
declaration; its documents and reports use the existing engines. "Customizable without forking": what a
localization installs becomes the company's data. "Works in English and Bangla": the tax invoice, amounts in words
and the registers in both. "Kosh never reimplements ORM features": migrations and data loading are Shutro's; the
external-id move uses its data API.
