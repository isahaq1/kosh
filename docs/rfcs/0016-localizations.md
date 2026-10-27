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

## Alignment with CLAUDE.md

"Money is always `Decimal`": every tax and withholding amount, per currency. "Metadata-driven": a country is a
declaration; its documents and reports use the existing engines. "Customizable without forking": what a
localization installs becomes the company's data. "Works in English and Bangla": the tax invoice, amounts in words
and the registers in both. "Kosh never reimplements ORM features": migrations and data loading are Shutro's; the
external-id move uses its data API.
