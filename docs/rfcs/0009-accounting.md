# RFC 0009: Accounting (the ledger, documents, payments, reports)

- **Status:** Accepted (2026-10-25, with the proposed answers to §11); steps 1–2 implemented (see Implementation notes)
- **Depends on:** 0001 (modules), 0002 (generated API), 0003 (permissions, approvals), 0004 (views), 0005
  (reporting: pivots, comparisons, scheduled reports), 0006 (chatter, notifications), 0008 (apps, bridges)
- **Followed by:** the `sale_account` and `purchase_account` bridges (RFC 0008 §5.1), Projects (RFC 0008 step 6)

## 1. Summary

Accounting is the app a business trusts its numbers to. This RFC designs it as a **double-entry ledger in exact
money** on Shutro, with customer invoices, vendor bills, credit notes and payments as documents that *post*
entries, reconciliation that settles them, lock dates that make periods final, and reports (trial balance,
general ledger, P&L, balance sheet, aged receivables and payables, VAT) built on the reporting engine. Taxes
stay where RFC 0008 put them (`product`), extended here with the accounts they post to.

The design keeps the ledger small and the rules strict, so that it is easier to understand and audit than Odoo's
`account.move`, and faster: a posted entry is immutable, every amount is a Shutro `Decimal`, every document in a
foreign currency carries its rate and its company-currency amounts, and every report is one server query over
`account.move.line`.

## 2. What is in and out of version 1

**In**

- Chart of accounts: a generic template and a Bangladesh template (RFC 0008 decision 2), per company, with account
  types that drive the reports.
- Journals (sales, purchases, cash, bank, miscellaneous), sequences per journal and year, fiscal years and lock
  dates.
- Journal entries (`account.move`) with lines (`account.move.line`): draft → posted → (reversed). Posted entries
  are immutable; corrections are reversals.
- Customer invoices, vendor bills, customer and vendor credit notes: the same `account.move` model with a
  document `kind`, product lines with taxes, due dates from payment terms, a PDF (the reporting engine's templates).
- Taxes posting to accounts (`account.tax` extended): tax lines computed at posting, VAT report.
- Payments (`account.payment`) in cash or bank journals, and **reconciliation** of receivable and payable lines
  (partial and full), with the residual amount on each document.
- Multi-currency: a document in any currency with a rate at its date; the ledger in the company currency; a
  realised exchange difference at reconciliation.
- Multi-company: everything company-scoped (Shutro `companyScoped`); a chart per company.
- Reports: trial balance, general ledger, partner ledger, aged receivables / payables, profit and loss, balance
  sheet, VAT return basis; all with period comparison, drill-down to the lines, Excel and PDF, scheduled by
  email (RFC 0005).
- Approvals: bills above an amount (RFC 0003 §5.3), as in Purchase.
- The chatter on every document; notifications for approvals (RFC 0006).

**Out of version 1** (each a later RFC or step)

- Bank statement import and automatic matching (a bank feed adapter; the reconciliation model is ready for it).
- Analytic accounting (cost centres, projects): comes with Projects / `project_account`.
- Assets and depreciation, deferred revenue, budgets, cash-flow forecasting.
- Inventory valuation entries (`inventory` app).
- Multi-currency unrealised revaluation at period end.
- Withholding taxes (TDS/VDS, Bangladesh) — the tax model has the hook (`type: 'withholding'`), the entries come
  later with the local statutory reports.

## 3. Principles

1. **Exact money, always.** Amounts are Shutro `Decimal`; `Money` carries its currency. Rounding happens once,
   at posting, to the currency's `rounding`, per line and per tax group (not per unit).
2. **Posted means immutable.** A posted `account.move` cannot be edited or deleted; it is reversed (an entry with
   the lines negated, linked both ways). The audit log (Shutro) records who posted what, when.
3. **The ledger is the truth; documents are views of it.** Invoice totals, residuals, aging and reports are read
   from `account.move.line`; no second copy of amounts.
4. **Balanced by construction.** A move's lines must sum to zero in the company currency; the check runs at
   posting, in the same transaction, and a move that does not balance is refused with the difference shown.
5. **Dates are law.** An entry cannot be posted (or reversed) on a date at or before the company's lock date;
   a fiscal year can be closed with a hard lock (administrators only, audited).
6. **Server decides.** Every state change is a Shutro transition with guards; the UI only asks.

## 4. Data model (Shutro, in `modules/accounting`)

```
account.account          code, name, type, company, reconcile?, deprecated?, currency?
account.account.type     a fixed selection: asset_receivable, asset_cash, asset_current, asset_fixed, …,
                         liability_payable, liability_current, …, equity, income, expense, off_balance
account.journal          code, name, type (sale|purchase|cash|bank|general), default account, sequence code,
                         company, payment method lines (bank/cash only)
account.fiscal.year      company, start, end, state (open|closed), lock date
account.payment.term     name, lines (days, percent) → due dates
account.tax (extended)   + accounts (tax collected / paid), scope (invoice line / tax line), type
                         (percent|fixed|withholding), price included?, group
account.move             the entry: name (per journal sequence), journal, date, company, currency, rate,
                         kind (entry|out_invoice|out_refund|in_invoice|in_refund), partner, ref, state
                         (draft|posted|cancel), reversed_by / reversal_of, invoice fields (date due, payment
                         term, origin document), totals (untaxed, tax, total, residual) in both currencies
account.move.line        move, account, partner, name, debit, credit (company currency, Decimal), amount
                         currency + currency (document currency), date, date maturity, product, quantity,
                         taxes, tax line of?, reconciled?, matched residual
account.partial.reconcile  debit line, credit line, amount (company currency), amount in currency, exchange move
account.full.reconcile   the set of lines fully settled together (one id per settlement)
account.payment          journal, method, partner, amount, currency, date, memo, state (draft|posted|cancelled),
                         the move it posted; "pay" from an invoice pre-fills it and reconciles on post
```

Decisions inside the model:

- **One `account.move` for entries and documents** (as Odoo 13+): simpler reports, one reconciliation. The
  `kind` field drives the form (an invoice form, a plain entry form), the numbering (the journal's sequence) and
  the sign conventions. Lines are of three sorts: product lines (what was sold or bought), tax lines (generated),
  and the balancing receivable / payable line (generated). Generated lines are recomputed from the product lines
  while the move is a draft and frozen at posting.
- **Debit and credit as two non-negative Decimals** in the company currency; `amountCurrency` signed in the
  document currency. Reports sum `debit - credit`; the receivable/payable residual is read from the partial
  reconciliations.
- **Reconciliation is its own model**, not a flag: partial matches are first-class (a bill paid in three
  instalments), the exchange-difference entry is linked to the partial that created it, and unreconciling a
  payment removes exactly its partials.
- **Fiscal years and lock dates** are explicit records, so that "which periods are open" is data the UI can show
  and the guards can read, rather than a setting hidden in the company form.

## 5. Behaviour

### 5.1 Posting

`post` is a transition on `account.move` with guards, run in one transaction:

1. The date is after the lock date of the company (and of the fiscal year, if closed).
2. For documents: at least one product line, a partner, a due date (from the payment term, or the date).
3. Generated lines are rebuilt: tax lines per tax (grouped by tax and account; rounding per group), the
   receivable / payable counterpart line for the total, with `dateMaturity` from the payment term lines
   (several maturities give several counterpart lines).
4. Multi-currency: `amountCurrency` per line in the document currency; `debit` / `credit` converted at the move's
   rate (the rate stored on the move: the company's rate table at the date by default, editable before posting).
5. The sum of `debit - credit` is zero; otherwise the transition fails with the difference.
6. The name is taken from the journal's sequence (`INV/2026/00001`, yearly reset) **at posting**, never earlier,
   so there are no gaps from deleted drafts (a tax requirement in most countries).
7. The move becomes `posted`; its lines are immutable from then on (a Shutro constraint on write).

### 5.2 Reversal and cancellation

A posted move is never deleted. `reverse` creates a draft move in the same journal with every line negated, dated
today (or the user's date, after the lock date), linked both ways, and posts it when asked; the pair is
reconciled automatically when the account is reconcilable. Cancelling a draft just marks it `cancel`.

### 5.3 Payments and reconciliation

- A payment is a move in a cash or bank journal: the journal's default account against the partner's
  receivable / payable account. "Register payment" from one or several invoices pre-fills amount, partner,
  currency and memo, posts the payment and **reconciles** it with the invoices' counterpart lines: partials are
  created oldest due first, the invoices' residuals shrink, an invoice whose residual reaches zero is marked
  `paid`, and a full reconcile record groups the settled lines.
- The exchange difference between the invoice's rate and the payment's rate, when both are in a foreign
  currency, is posted automatically to the company's exchange gain / loss accounts, linked to the partial.
- Manual reconciliation: a screen listing unreconciled lines of a reconcilable account (by partner), where the
  user selects lines whose sum is zero (or writes off the difference to an account they choose), using the list
  grid's selection (RFC 0010).
- Unreconcile removes the partials and the exchange entries they created (by reversal when posted after a lock).

### 5.4 Taxes

`account.tax` (from `product`) gains: the accounts to post to, `type` (`percent`, `fixed`, `withholding`), a
`priceIncluded` flag, a group for the invoice totals, and a `scope` (sales / purchases, as today). Tax
computation lives in one pure function used by Sales, Purchase and Accounting (`computeTaxes(lines, currency)`,
exported by `product`), so the three apps agree to the paisa. Rounding: per tax group per document, at posting.

### 5.5 Lock dates and closing

- `res.company` gains `lockDate` (everyone) and `taxLockDate` (tax returns): no posting, reversal or
  reconciliation on or before them. Administrators change them, audited.
- Closing a fiscal year: a wizard that checks every move is posted or cancelled, posts the P&L transfer to
  retained earnings (one entry per company), sets the year's state to `closed` and its lock date to its end.
  Reopening is an administrator action with a reason, audited.

### 5.6 Charts of accounts

Templates are data files (Shutro `loadData` records): `generic` (an IFRS-flavoured small chart) and `bd`
(Bangladesh: VAT 15 % with the common reduced rates, AIT/VDS placeholders, BDT, a Mushak-oriented account set).
Installing Accounting for a company asks which template (Settings → Accounting), creates the accounts, the
journals, the default taxes and links the company's default accounts (receivable, payable, exchange gain / loss,
retained earnings). A template is never applied twice to a company.

### 5.7 Permissions (RFC 0003)

| Level | Groups | May |
| --- | --- | --- |
| Invoicing | `account.invoicing` | create and send customer invoices and credit notes; register their payments; read partner ledgers |
| Accountant | `account.user` | everything in Invoicing, plus bills, entries, reconciliation, reports |
| Manager | `account.manager` | plus posting over approval thresholds, lock dates, year closing, chart changes |

Record rules: everything company-scoped. Bills above a threshold go through approvals (the Purchase policy
pattern). Reports are export-permission gated like any list.

### 5.8 Bridges (RFC 0008 §5.1)

- `sale_account`: "Create invoice" on a confirmed sales order (full, or a down payment percentage), the
  invoicing state on the order (`to invoice`, `invoiced`), the order's lines as invoice lines (product, tax,
  discount), the invoice linked to the order in the chatter.
- `purchase_account`: "Create bill" on a confirmed purchase order, bill lines from order lines, three-way match
  later (with Inventory).

## 6. Reports (RFC 0005)

All reports are pivots or lines over `account.move.line` with `state = posted`, filtered by company, date range,
journal and partner, with a comparison period and drill-down:

| Report | Shape |
| --- | --- |
| Trial balance | accounts × (opening, debit, credit, closing) |
| General ledger | lines grouped by account, running balance |
| Partner ledger | lines grouped by partner for receivable / payable accounts, balance and due |
| Aged receivables / payables | partners × buckets (not due, 1–30, 31–60, 61–90, 90+) on `dateMaturity`, from unreconciled residuals |
| Profit and loss | income and expense account types, by period |
| Balance sheet | asset, liability and equity types at a date, with the current year's result |
| VAT | tax lines by tax, base and amount, for a period (the Bangladesh Mushak-6.3 layout later) |

The P&L and balance sheet use the account types' hierarchy declared in `account.account.type` (a fixed tree),
rendered by the reporting engine's hierarchy view; every number drills to the lines.

## 7. API and UI

- Generated REST from the models (RFC 0002) plus a few explicit routes: `POST /api/v1/accounting/moves/:id/post`
  is the transition; `POST /api/v1/accounting/payments/register` (invoices → payment), `/reconcile` and
  `/unreconcile`, `/fiscal-years/:id/close`, and `/charts/install`.
- Views: invoice form (customer, dates, lines with taxes, totals with tax groups, residual and payments widget),
  entry form (lines as a grid: RFC 0010 keyboard editing and paste serve accountants well here), payment form,
  reconciliation screen (a client page), reports (pivots and hierarchies), Settings → Accounting (chart, lock
  dates, journals, taxes).
- Numbers in forms use the formatted inputs of RFC 0010 §3.6 (to be built with this app).

## 8. Performance

- Posting an invoice with 50 lines: one transaction, < 150 ms on the CI database.
- Aged receivables over 1 M lines: one `GROUPING SETS` query with the residual computed in SQL from partials,
  < 2 s; indexes on (`account`, `partner`, `reconciled`, `dateMaturity`) and (`move`, `account`).
- Reports never load lines into Node: aggregation stays in PostgreSQL (RFC 0005).

## 9. Tests

- Unit: tax computation (rounding, price-included, groups), payment terms, aging buckets, exchange differences.
- Integration (real PostgreSQL): post / reverse / lock-date refusals, balanced-move constraint, sequence at
  posting without gaps, reconciliation partial → full → unreconcile, multi-currency payment with its exchange
  entry, year closing, template install idempotence, permission tests (invoicing users cannot post bills).
- E2E: invoice from a sales order, pay it, see it paid; a bill through approval; the trial balance drilling to
  a line; the grid editing an entry's lines.

## 10. Delivery plan (each step reviewed)

1. Models, chart templates, journals, fiscal years, lock dates; `post` / `reverse` with the balanced constraint
   and sequence-at-posting; integration tests.
2. Documents: invoices, bills, credit notes, payment terms, taxes posting, PDF; the Accounting app manifest,
   menus, views, permissions; `sale_account` and `purchase_account`.
3. Payments and reconciliation (register payment, manual reconciliation, exchange differences).
4. Reports (trial balance, ledgers, aging, P&L, balance sheet, VAT) with comparisons and drill-down; year
   closing; Settings → Accounting.
5. `kosh init` default set with Accounting (RFC 0008 step 7), docs and benchmarks.

## 11. Open questions (answers wanted with the approval)

1. **Rates**: a `res.currency.rate` table maintained by hand in version 1 (a daily rate per currency per
   company), or also an adapter pulling Bangladesh Bank / ECB rates? Proposal: by hand now, adapter later.
2. **Sequence per journal per fiscal year** (`INV/2026/00001`) or per company? Proposal: per journal, yearly.
3. **Bangladesh template**: should VAT accounts follow the Mushak-6.x structure from the start (output VAT,
   input VAT, VAT payable, AT, SD)? Proposal: yes, those five, with the reports' Mushak layouts in a later step.
4. **Cash basis VAT**: not in version 1 (tax reported on invoice date). Confirm.

## Decisions (2026-10-25)

1. Currency rates are maintained by hand in version 1 (`res.currency.rate`: per currency, date, optionally per
   company); a rate adapter comes later.
2. Sequences are per journal type and year (`INV/2026/00001`, `BILL/…`, `CSH/…`, `BNK/…`, `MISC/…`), gapless.
3. The Bangladesh template carries the Mushak VAT accounts from the start (output VAT, input VAT, VAT payable,
   AT, SD, plus AIT, TDS and VDS placeholders); the Mushak report layouts come with the reports step.
4. No cash-basis VAT in version 1: tax is reported on the invoice date.

## Implementation notes (2026-10-25): step 1 — the ledger core

`modules/accounting` (`@kosh/accounting`, the Accounting app, `kosh-erp/accounting`):

- **Models** (`src/module.ts`): `res.currency.rate` (Kosh defines it; Shutro's `env.fx` reads it), `account.account`
  (typed by `ACCOUNT_TYPES`, unique code per company), `account.journal` (five types), `account.fiscal.year`
  (open / closed, lock date, no overlap), `account.move` and `account.move.line` (debit and credit as monetary
  fields in the company currency, the signed amount in the entry's currency beside them, a SQL check that a line
  is one side only), and extensions of `res.company` (chart template, lock dates, default accounts) and
  `account.tax` (tax account, refund account, price included).
- **Posting** is the `post` transition's `before` hook, in its transaction: the lock date and closed years, the
  rate of the entry's date (`env.fx.prepare`; a missing rate is a 422 with Shutro's message), company-currency
  amounts for lines entered in the entry's currency (rounded to the currency's unit), the balance to the paisa
  (the difference is in the message), the number from the journal type's sequence (`assignNumber`, so drafts and
  deleted drafts leave no gap), and the posting time and transaction. Posting needs the `account.post`
  permission (accountants, not invoicing users).
- **Immutability** twice: a Shutro constraint on entries and lines refuses changes from any transaction but the
  posting one (`postedTx`, `pg_current_xact_id()`), and database triggers (`installImmutability`, installed with
  the module's defaults) refuse updates of the ledger columns and deletes below the ORM. A trigger's refusal is a
  422 `database-rule` problem with the raised message (`problemOf` maps SQLSTATE P0001).
- **Reversal**: `POST /api/v1/accounting/moves/:id/reverse` (`{ date?, post? }`) creates the negated entry in the
  same journal, linked both ways, posted when asked; once per entry.
- **Charts**: `POST /api/v1/accounting/charts/install` (`{ template }`, managers; once per company) creates the
  accounts and the five journals, links the company's default accounts in system scope (companies are read-only
  to everyone else) and points the product module's taxes at their accounts; `GET …/charts` lists the templates
  and the installed one.
- **Shutro requests**: a sequence per journal (#22; meanwhile one numbered field per journal type) and an
  unlink / immutability hook (#23; meanwhile the triggers).
- Tests: `modules/accounting/test/accounting.integration.test.ts` (install and chart, posting and numbering,
  refusals with their reasons, immutability at the API and in the database, reversal, lock dates and closed
  years, a USD entry at the rate of its date, permissions).
- **Next:** step 2, the documents (invoices, bills, credit notes, payment terms, taxes posting, PDF) and the
  `sale_account` / `purchase_account` bridges.

## Implementation notes (2026-10-25): step 2 — the documents and the bridges

- **Documents are entries of a `kind`** (`out_invoice`, `out_refund`, `in_invoice`, `in_refund`) whose lines are
  typed by `lineKind`: the user's **product** lines (product, description, quantity, unit price, discount, tax;
  `subtotal` and `taxAmount` computed in the document currency, price-included taxes handled) and, generated at
  posting, the **tax** lines (one per tax, the per-line amounts summed and rounded to the currency's unit per
  document, posted to the tax's account or its credit-note account) and the **counterpart** lines on the
  company's receivable / payable account, one per payment term part with its due date (the rounded total
  allocated between the parts with `Money.allocate`, so the paisa lands once). The document's `dateDue` is the
  latest part. Every line's company-currency side is then settled at the entry's rate as for any entry, and the
  balance, number and immutability rules apply unchanged. `invoiceLines` (a second one2many through a computed
  `invoice` link on product lines) gives the PDF and the reports the product lines only.
- **Payment terms** (`account.payment.term` with parts in days and percent; four shipped as shared data).
- **Approvals**: a vendor bill above the policy's threshold (100,000 by default) is submitted (`submit` →
  `to_approve`, approval requests from RFC 0003) and posted by the last approval (`onApproved: 'post'`); a bill
  no level applies to posts after submission; `reject` sends a bill back to draft.
- **PDF**: the `accounting.invoice` document template (RFC 0005), listing the product lines, totals and the
  payment terms' note; printed from the document routes.
- **Reversal of a document** is a credit note: the product lines are copied and the reversed kind flips the sides.
- **Window actions** gained `defaults` (values of a record created from the action: the customer invoices action
  creates `out_invoice`, the vendor bills action `in_invoice`); `@kosh/views` and the shell carry them.
- **Bridges** (RFC 0008 §5.1): the manifest's `bridge: [a, b]` field; the planner proposes a bridge (reason
  `bridge`) whenever every module it connects is installed, unless the change names it in `withoutBridges`.
  `sale_account` adds the `invoice` transition to a confirmed sales order (a draft customer invoice from its lines
  in the sales journal; the order's `invoiceState` is computed from its invoices) and `purchase_account` the
  `bill` transition to a confirmed purchase order (a draft vendor bill with the vendor's reference), each with a
  button and a status on the order's form and list through view extensions. A bridge's access level combines
  the two apps' user groups.
- Tests: `modules/accounting/test/documents.integration.test.ts` (an invoice with three lines and two taxes, parts
  and due dates, the PDF, a credit note, the bill approval flow, refusals), `modules/sale_account/test` and
  `modules/purchase_account/test` (the plan's proposal, invoicing and billing once, posting).
- **Not in this step:** partner-specific receivable / payable accounts, product-category income and expense
  accounts (the journal's default account is used), down payments.
- **Next:** step 3, payments and reconciliation.

## Alignment with CLAUDE.md

- Money is Shutro `Decimal`, never `number`; the ORM's `Money` and `companyScoped` do the heavy lifting.
- Default deny: three access levels, record rules per company, approvals for bills, exports gated.
- Metadata-driven: the generated API and views carry the models; the few explicit routes are transitions and
  wizards, validated from schemas.
- Explicit over magic: bridges are separate modules; the chart template is chosen, not assumed.
- Fast by design: reports aggregate in PostgreSQL; budgets in §8 go into CI.
