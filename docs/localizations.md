# Country localizations

A country is a module (`l10n_bd`, Bangladesh; India next). It declares what a company in that country starts
with — the chart of accounts, the accounts of its taxes, the withholdings, the fiscal year and how numbers are
grouped — and ships the country's taxes, tax identifiers, documents and returns. Accounting itself is
country-neutral: several taxes per line in sequence (supplementary duty before VAT), withholding at payment,
fiscal years starting in any month, amounts in words, lakh / crore grouping (RFC 0016).

Everything a localization installs becomes the company's data: rates, accounts and templates are edited in
Accounting › Configuration and the document designer, and upgrades never overwrite them.

## Installing

- A new installation: `npx kosh init --country BD` (the default when the currency is BDT). The localization comes
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
