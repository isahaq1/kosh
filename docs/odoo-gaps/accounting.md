# Accounting & finance: Odoo 19 Community vs Kosh

Scope: Odoo `account`, `analytic`, `account_payment`, `payment` (+ providers), `account_edi*`, `account_peppol*`,
`account_debit_note`, `account_check_printing`, `account_tax_python`, `account_qr_code_emv/sepa`, `snailmail_account`,
`account_fleet`, `account_add_gln`, `account_payment_interco`, `account_update_tax_tags`. (`currency_rate_live` is not in
this Community tree.) Kosh: `modules/accounting`, `account_asset`, `account_budget`, `account_portal`, `payment`,
`expense_account`, `trade_finance_account`, `sale_account`, `purchase_account`, `l10n_bd`, `l10n_in`.

Verified by reading the Kosh models (`modules/accounting/src/module.ts`, `index.ts`, `payments.ts`, `closing.ts`,
`chart.ts`, the bridges, `payment/src/module.ts`) and by grepping all Kosh modules, packages and docs for each concept.

## 1. Kosh already ahead

- **Financial reports in the core**: trial balance, general ledger, partner ledger, P&L, balance sheet, VAT and
  cost-centre pivots with drill-down, period comparison, Excel/PDF and scheduled email; aged balances. In Odoo
  Community these reports (`account_reports`) are Enterprise-only.
- **Year closing and reopening** with a closing entry to retained earnings (`closing.ts`); Odoo Community has none.
- **Immutability enforced in PostgreSQL** (triggers on `account_move` / `account_move_line`, `chart.ts`), not only an
  inalterability hash in the app layer; gapless yearly numbering per journal type.
- **Approvals on vendor bills** by amount through the shared approval engine (`submit` → `to_approve`), with
  delegation, deadlines and email decisions from RFC 0025. Odoo needs Studio/Enterprise for this.
- **Fixed assets** (`account_asset`: straight line, declining, units of production, disposal/sale, revaluation,
  impairment, a separate tax book) and **budgets** (`account_budget`: actual + committed from POs, warn/block
  control on purchase orders) — both Enterprise in Odoo, and Odoo budgets do not block POs.
- **Withholding at payment** (VDS / TDS proposed and posted, certificates) as a generic model
  (`account.withholding`, `account.payment.withholding`) — Odoo only has it in some localizations.
- **Tax components by place of supply** (CGST/SGST/IGST, cess, reverse charge accounts) generic in the core, plus
  `l10n_in` GSTR-1 / 3B and e-invoicing / e-way bills behind a provider adapter; `l10n_bd` Mushak 6.1/6.2/6.3/6.6/6.7
  and 9.1 on screen, XLSX and PDF.
- **Local online payments**: bKash, SSLCommerz (IPN validated), Razorpay, Stripe; Pay now in the portal settles and
  reconciles exactly once through inbound webhooks (idempotent per event id).
- **Domain bridges Odoo lacks in Community**: Trade Finance (LC margins, payments, bank charges posted), Spend with
  advances and company cards (`expense_account`), Payroll posting with bank / bKash / Nagad files, stock valuation
  (avg / FIFO) with GRNI and price differences, production WIP.
- **Lakh/crore grouping, amounts in words, bank payment details on invoices and in the portal**, Bangla UI.

## 2. Gaps

| Odoo capability | Odoo addon | Kosh status | Value | Size |
|---|---|---|---|---|
| Bank statements (lines, import, running balance) and statement-to-entry matching | account (`account.bank.statement[.line]`) | **Missing** — RFC 0009 §2 lists it out of v1; only manual matching of open items (`ReconcilePage`, `/accounting/reconcile`) | High | L |
| Reconciliation models: write-off buttons, auto-match rules by label/amount/partner, suspense account per journal | account (`account.reconcile.model`) | **Missing** (no rules, no suspense account on journals) | High | M |
| Customer follow-ups / dunning: overdue reminders by level, "no follow-up" flag, next action date | account (`no_followup`, partner trust) — levels are Enterprise | **Missing** — only the aged balance report | High | M |
| Customer credit limit with warning / block on orders and invoices | account (`partner.credit_limit`, `use_partner_credit_limit`) | **Missing** (no field in contacts/sales/accounting modules) | High | S |
| Partial invoicing: by delivered/received quantity, down payments, multiple invoices per order | account + sale/purchase (`qty_invoiced`, down payment wizard) | **Partial** — `sale_account` / `purchase_account` make one invoice/bill for the full order (`This order is invoiced already`); `sale_stock` knows `qtyDelivered` but invoicing ignores it; no down payments | High | M |
| Fiscal positions: map taxes and accounts per customer/country/VAT status, auto-detected | account (`account.fiscal.position`) | **Partial** — place-of-supply scope on tax components (intra/inter) and reverse charge; no generic tax/account mapping per partner or country (exports, exempt customers, SEZ) | High | M |
| Income/expense accounts per product and product category; partner-specific receivable/payable | account (`product.py`, `partner.py` properties) | **Partial** — only the journal's default account plus an override hook `productLineAccounts()` used by stock valuation; RFC 0009 step 2 notes both as "not in this step" | High | S |
| Send invoices by email with the PDF (Send & Print, batch send, auto-send cron, sent flag) | account (`account.move.send`, wizards) | **Partial** — `account_portal` announces posted invoices by email with a portal link; no send dialog with template + PDF attachment, no "sent" status, no batch send | High | S |
| Analytic plans: several dimensions, % distribution across cost centres, distribution models (auto by account/product/partner), analytic lines independent of GL | analytic, account (`account.analytic.plan`, `.distribution.model`, `.line`) | **Partial** — one dimension `account.analytic` (tree) per journal line; no split, no plans, no rules | High | M |
| Payment terms: end of month, N days after end of month, fixed-amount parts, early payment (cash) discount with tax adjustment | account (`account.payment.term[.line]`) | **Partial** — lines of days + percent only; no early discount | Medium | S |
| Recurring / auto-posted entries (monthly, quarterly, yearly), scheduled posting at date | account (`auto_post`, cron `_autopost_draft_entries`) | **Missing** (no recurrence in accounting) | Medium | S |
| Deferred revenue / expense (spread over periods) and accrual/cut-off entries (change period, accrued revenue/expenses from un-invoiced orders) | account (`account_automatic_entry_wizard`, `accrued_orders`) | **Missing** — RFC 0009 §2 lists deferred revenue as later | Medium | M |
| Lock dates by scope (sales, purchases, fiscal year, tax, hard lock) with temporary audited exceptions | account (`company.py`, `account.lock_exception`) | **Partial** — company `lockDate` and `taxLockDate`, fiscal year lock on close; no per-journal-type locks, no hard lock, no exceptions | Medium | S |
| Duplicate vendor bill detection (same partner + reference / amount) | account (`duplicated_ref_ids`, `is_exact_move_duplicate`) | **Missing** (Spend has duplicates; bills do not) | Medium | S |
| Vendor bills by email (journal alias) and e-invoice XML import into a draft bill | account (journal `alias_name`, `account_document_import_mixin`), account_edi_ubl_cii | **Partial** — inbound email exists in messaging and the assistant's "Fill from a document" reads PDFs/images; no per-journal bill inbox creating drafts automatically, no XML import | Medium | M |
| Cash-basis taxes (VAT due on payment) | account (`tax_exigibility`, `tax_cash_basis_rec_id`) | **Missing** — RFC 0009 open question 4 deferred | Medium | M |
| Tax groups, "percentage tax included" (division), repartition lines and tax grids/tags for returns | account (`account.tax`, `account.account.tag`) | **Partial** — percent / fixed per unit, price-included, affects-base, components with shares; no tax grids/tags mapping lines to return boxes (returns are coded per localization) | Medium | M |
| Batch payments: register payments for many bills at once, grouped per vendor, with write-off of differences | account (`account.payment.register` group mode, write-off) | **Partial** — register payment from documents; no multi-vendor payment run, no write-off on the difference | Medium | M |
| Check printing: check numbers, layouts, print/reprint/void | account_check_printing | **Missing** (only a test mentions cheques) | Medium (BD/IN still pay by cheque) | S |
| Payment QR codes on invoices (EMV merchant QR, SEPA QR) | account_qr_code_emv, account_qr_code_sepa | **Missing** generically — only the India e-invoice IRN QR | Medium | S |
| Online payment depth: saved cards/tokens, refunds from Kosh, manual capture, payment links for any amount/order, express checkout | payment, account_payment (`payment.token`, refund/capture/link wizards) | **Partial** — `payment.transaction` is invoice-only, states pending/done/failed/cancelled; no tokens, refunds, capture or standalone links | Medium | M |
| Peppol network and UBL / CII / Factur-X export and import | account_edi_ubl_cii, account_peppol, account_peppol_response | **Missing** generically (India IRP adapter only) | Medium (EU markets), Low (BD/IN) | L |
| Multi-currency: journal currency, bank journals in foreign currency, unrealised FX revaluation at period end | account (`journal.currency_id`), revaluation is Enterprise | **Partial** — realised exchange differences done; account currency exists; no journal currency, no revaluation (RFC 0009 §2 "later"); rates by hand | Medium | M |
| Cash rounding on invoices (round total to 0.05 / 1 with a rounding line) | account (`account.cash.rounding`) | **Missing** | Low | S |
| Incoterms on invoices | account (`account.incoterms`) | **Partial** — incoterms on trade finance only | Low | S |
| Tax computed by formula (custom code) | account_tax_python | **Missing** for taxes (Payroll already has a safe formula language that could be reused) | Low | S |
| Delivery date / taxable supply date on invoices | account (`delivery_date`, `taxable_supply_date`) | **Missing** | Low | S |
| Intercompany payments matching invoices across companies | account_payment_interco | **Missing** (no intercompany anywhere) | Low | M |
| Invoices by post | snailmail_account | **Missing** | Low | S |
| Resequence entries, merge accounts, storno accounting, GLN on partners, vehicles on bill lines | account wizards, account_add_gln, account_fleet | **Missing** | Low | S |

## 3. Recommended next steps (top 8 by value)

1. **Bank statements and a reconciliation workspace.** Statement lines per bank journal (CSV/OFX/CAMT import plus a
   feed adapter like the payment providers), a suspense account, and a keyboard-first matching screen that proposes
   open items by amount, reference and partner — surpass Odoo by making bank feeds for BD/IN banks an adapter and by
   explaining each proposal in words, as the replenishment forecast does.
2. **Reconciliation rules.** Declarative rules (label/amount/partner conditions → match, write-off with tax, or
   suggest) that run on import, show their hit rate and can be dry-run like automation rules; every auto-match is
   audited and reversible.
3. **Partial invoicing and down payments.** Invoice/bill by ordered or delivered/received quantity per product,
   several invoices per order, down payments deducted on the final invoice, and a three-way-match check (PO ↔
   receipt ↔ bill) that holds bills with a price/quantity variance for approval — Odoo has no hold-with-approval.
4. **Credit control and follow-ups.** A credit limit per customer (and per company) enforced at order confirmation
   and invoice posting through the approval engine (override by a manager, not a silent warning), plus follow-up
   levels (email / SMS / WhatsApp through `@kosh/notify`, with the portal pay link) running as jobs — Odoo's levels
   are Enterprise and email-only.
5. **Fiscal positions and account determination.** One declarative mapping (tax → tax, account → account) chosen
   automatically from the partner's country, state, tax status and the supply scope, plus income/expense accounts
   on product categories and products and partner-specific receivable/payable, all previewable before posting.
6. **Send invoices properly.** A send action on invoices, bills and credit notes: template per language, the PDF
   (and the e-invoice XML/QR) attached, email/WhatsApp, a sent/opened status, batch send and auto-send on posting
   per customer — beating Odoo by tracking delivery and opens through the existing notify pipeline.
7. **Analytic plans with distribution.** Several dimensions (department, project, branch, product line) with
   percentage splits on lines and rules that fill them by account/product/partner; budgets and reports by any plan.
   Keep `account.analytic` as the first plan so existing data and `account_budget` carry over.
8. **Recurring, deferred and accrual entries.** Recurring entries and bills (scheduled jobs that post as the owner),
   deferred revenue/expense schedules created from invoice lines with a start/end date (reuse the asset board
   engine), and period-end accruals for received-not-billed and delivered-not-invoiced orders, reversed on day one
   of the next period.

Close behind: payment-term early discounts and end-of-month terms (S), duplicate bill detection (S), scoped lock
dates with audited exceptions (S), cheque printing with amount in words for BD/IN (S), Bangla QR / UPI QR on
invoices (S), unrealised FX revaluation (M), payment tokens/refunds/links (M), UBL/Peppol for EU markets (L).
