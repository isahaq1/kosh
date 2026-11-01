# RFC 0024 — Business apps, part 3: money out, people paid, service, assets, supply, selling online, paper

- Status: Accepted (2026-11-01)
- Depends on: RFC 0008/0009 (apps, Accounting), 0006 (messaging, inbound email), 0013 (assistant), 0014 (import),
  0015 (portal), 0016 (localizations), 0017 (payments, webhooks), 0020 (app settings), 0021 (Workforce, Stockroom,
  Production, Sites), 0023 (the module standard: every new module meets it from day one)

## 1. Summary

The gaps against Odoo that matter most for a business in Bangladesh, each built further than Odoo's version and
named as the other apps are:

| App | Module(s) | Odoo counterpart | Where it goes further |
|---|---|---|---|
| **Spend** | `expense`, `expense_account` | Expenses | cash advances and their settlement, policies enforced by the server, receipts read by the assistant, duplicates caught |
| **Attendance** | `attendance` | Attendances | shifts and rosters, kiosks with PIN / QR, phone check-in inside a geofence, biometric device import, overtime computed by rule |
| **Payroll** | `payroll`, `payroll_account`, `l10n_bd_payroll` | Payroll (Enterprise; no Bangladesh rules) | Bangladesh Labour Act structure, overtime, festival bonuses, tax deducted at source on salary from yearly slabs, provident fund, bank and mobile-wallet pay files, payslips in Bangla |
| **Helpdesk** | `helpdesk` | Helpdesk (Enterprise) | SLAs on business hours with pause, escalation by rule, drafted replies, tickets from email, portal, website and chat |
| **Fixed assets & budgets** | `account_asset`, `account_budget` | Assets, Budgets (Enterprise) | two books (accounting and tax, with the Bangladesh tax rates), commitments from purchase orders, a budget that blocks or warns |
| **Replenishment & routes** | in `stock`, `purchase_stock`, `mrp` | Inventory routes | one forecast screen with why each line is proposed, routes in one, two or three steps, putaway, dropship, make to order |
| **Shop** | `website_sale`, `website_sale_stock` | eCommerce | cash on delivery, Bangladesh couriers behind an adapter, Bangla storefront, stock shown live, orders straight into Sales |
| **Documents & Sign** | `documents`, `sign` | Documents, Sign (Enterprise) | one file store for records and folders, requests for documents, signatures with one-time codes and a sealed certificate, signing from any record |

Every module meets RFC 0023 (search, archive, chatter, print and import templates, events, Bangla) and ships demo
data, an overview, docs and an E2E.

## 2. The apps

### 2.1 Spend (`modules/expense`, app code `spend`)

- **Expenses** (`expense.expense`): employee, date, category, amount and currency, tax, the receipt (an attachment,
  required above a category's threshold), paid by the employee or the company (card), a project or department
  (dimensions, §2.5). **Fill from the receipt**: the assistant (RFC 0013) reads a photo or PDF into date, vendor,
  amount and tax, as a proposal the employee confirms.
- **Categories** (`expense.category`): the expense account, default tax, a **policy** — a limit per expense, per day
  or per month, receipts required above an amount, allowed for which groups — **enforced on the server**: an expense
  over its policy needs a reason and goes to a further approver; never silently accepted.
- **Reports** (`expense.sheet`): the expenses of a period submitted together, approved through the approval engine
  (amount-based levels: manager, then finance), **duplicates flagged** (same amount, date and vendor, or the same
  receipt file hash).
- **Cash advances** (`expense.advance`): requested, approved, paid; later expense reports **settle** against it —
  the balance returned or reimbursed. Common in Bangladesh, absent from Odoo.
- **Per diem and mileage**: categories with a rate per day or per kilometre.
- **`expense_account`**: an approved report posts one entry (expense accounts and taxes against the employee's payable
  or the card's clearing account); reimbursement by a payment or with the next payroll run (`payroll`).

### 2.2 Attendance (`modules/attendance`, app code `attendance`)

- **Shifts and rosters** (`attendance.shift`, `attendance.roster`): hours, breaks, grace minutes, night shifts across
  midnight; employees assigned by roster with a calendar view and swaps approved by managers.
- **Check-in / out** (`attendance.record`): from the **kiosk** page (a tablet at the gate: PIN, QR badge or face
  photo kept as evidence), from the **phone** inside the site's geofence (location kept only as inside / outside
  plus distance), or **imported** from biometric devices (CSV or an adapter; ZKTeco's export first). Duplicate
  punches merged; a missing check-out flagged for the manager.
- **Computed per day** (`attendance.day`): worked hours, late, early leave, absent (none of leave, holiday or
  weekend — from Workforce), **overtime** by rule (after the shift's hours, on weekends and holidays, with the
  rate), approved by the manager before payroll reads it.
- Holidays (`attendance.holiday`) per company and year, with Bangladesh's public holidays loaded by `l10n_bd`.

### 2.3 Payroll (`modules/payroll`, `payroll_account`, `l10n_bd_payroll`; app code `payroll`)

- **Salary structures** (`payroll.structure`) with **rules** (`payroll.rule`): each a code, a category (basic,
  allowance, deduction, company contribution, net), and an amount — fixed, a percentage of another rule, or a small
  safe expression over the employee's contract, attendance and inputs (no code execution: a formula language with
  arithmetic, `min`, `max`, `if`, evaluated with Decimals). Rules are data, versioned with effective dates.
- **Runs** (`payroll.run`) per month and company: payslips computed for the employees in scope, **explained line by
  line** (the rule, its inputs and the arithmetic), inputs from Attendance (days worked, absence, overtime hours),
  Spend (reimbursements) and loans; checked, approved, then **locked**; a correction is a new payslip referring to
  the old, never an edit.
- **Payslips** (`payroll.slip`): printed and in the employee portal (the employee's own only), in English or Bangla.
- **Loans and salary advances** (`payroll.loan`): instalments deducted run by run.
- **Payment files**: bank transfer files (a generic CSV and an adapter per bank) and **mobile wallets** (bKash /
  Nagad disbursement files), with each payslip's payment state.
- **`payroll_account`**: a locked run posts one entry (expense per rule category, payables per deduction, net pay).
- **`l10n_bd_payroll`**: the Bangladesh structure — basic, house rent, medical, conveyance, food; overtime at twice
  the hourly basic (basic ÷ 208 per hour, the Labour Act's rule, configurable); absence deduction on basic per day;
  two **festival bonuses** a year after the qualifying service; **provident fund** (employee and employer shares);
  **tax deducted at source on salary** from the fiscal year's slabs, the tax-free threshold, investment rebate and
  the yearly projection spread over the remaining months (slabs and thresholds are data per fiscal year, loaded by
  the module and checked against the year's NBR rates when implemented); the salary certificate and the yearly tax
  statement per employee; earned leave accrual (one day per 18 days worked) into Workforce's balance.

### 2.4 Helpdesk (`modules/helpdesk`, app code `helpdesk`)

- **Teams** (`helpdesk.team`) with members, an email alias (RFC 0006 inbound email: a message to the alias opens a
  ticket, replies thread into it), a website form (Sites) and a portal page; assignment round-robin or by load.
- **Tickets** (`helpdesk.ticket`): customer, priority, type, stage board, tags, the conversation in the chatter (sent
  as email to the customer), **merge** duplicates, split, link to orders, invoices and projects; timesheets with
  Projects.
- **SLA policies** (`helpdesk.sla`): first reply and resolution targets by team, priority and customer, counted on
  the team's **business hours and holidays**, paused while waiting on the customer, shown as days / hours left;
  **escalation rules** (automation, RFC 0011) on breach.
- **Drafted replies** by the assistant from the ticket and similar solved tickets; canned replies with placeholders.
- **Satisfaction**: a rating asked on closing, by email or portal; reports by team, agent and type.

### 2.5 Fixed assets and budgets (`account_asset`, `account_budget`)

- **Dimensions** (in `accounting`): an optional **cost centre** (`account.analytic`) on journal lines and on order and
  expense lines, set by default from the project or department (bridges); reports and budgets read it. A small,
  explicit form of Odoo's analytic accounting.
- **Assets** (`account.asset`): from a bill line whose account belongs to an asset category, or by hand; acquisition
  date and value, salvage value, method (**straight line, declining balance, units of production**), life, prorata
  from the date of use; the **depreciation board** computed in advance; entries posted monthly by a scheduled job,
  once each; **disposal and sale** with the gain or loss; **revaluation** and impairment.
- **Two books**: the accounting book posts entries; a **tax book** with Bangladesh's tax depreciation rates (Third
  Schedule of the Income Tax Act, loaded by `l10n_bd`) is computed beside it for the return, with the difference as
  deferred tax. Odoo keeps one book.
- **Budgets** (`account.budget`): per fiscal year, by account (or account group) × month or quarter × cost centre;
  actual from posted lines, **committed** from confirmed purchase orders not yet billed; a budget line set to **warn
  or block**: a purchase order that would exceed it asks for a further approval, or is refused, on the server.
  Variance reports with drill-down.

### 2.6 Replenishment and routes (in `stock`, `purchase_stock`, `mrp`)

- **Reorder rules** (`stock.reorder`): product × warehouse (or location), minimum, maximum, multiple, lead time; the
  **forecast** (on hand − reserved + incoming − outgoing, over the lead time) and the **replenishment screen** that
  proposes what to order, **why** (the forecast arithmetic) and how — buy (an RFQ grouped by vendor, `purchase_stock`),
  make (a production order, `mrp`) or move from another warehouse; snooze, order now, or let a scheduled job do it.
- **Routes**: a warehouse receives in **one, two or three steps** (input → quality → stock) and delivers in one, two
  or three (pick → pack → ship); the steps are chained transfers created from the first, each validated on its own.
- **Putaway rules**: where received goods go by product or category.
- **Make to order** (a sale line creates its purchase or production), **dropship** (the vendor ships to the
  customer: a receipt-delivery in one, `sale_stock` + `purchase_stock`), cross-dock.

### 2.7 Shop (`website_sale`, `website_sale_stock`; in Sites)

- **The storefront** on a Sites site: products published with pictures, descriptions in English and Bangla,
  categories and filters, search, product pages with variants' choices (attributes as options), related products.
- **Cart and checkout**: as a guest or a portal user, addresses, **delivery methods** with fees (fixed, by weight, by
  zone — Dhaka / outside Dhaka), **payment** through the payment providers (RFC 0017: SSLCommerz, bKash…) or **cash on
  delivery**; the order lands in Sales confirmed (or as a quotation for COD above a limit), with the payment
  registered once.
- **Couriers** (`delivery.carrier`): an adapter for shipping labels, tracking and COD collection — Pathao, Steadfast
  and RedX as adapters, a fake provider for tests; tracking shown in the portal.
- **`website_sale_stock`**: stock shown live (in stock / few left / out of stock), backorders allowed or not.
- Coupons and promotions, abandoned-cart emails, SEO (titles, descriptions, sitemap), the public API rate limited and
  cached as Sites' is.

### 2.8 Documents and Sign (`documents`, `sign`)

- **Documents** (`documents.folder`, `documents.document`): folders with access by group and company; files from
  storage (RFC 0006 storage on S3); every record's attachments are documents too, so one search finds both; tags,
  versions, preview; **share links** with expiry and optional password; **requests**: ask a person (employee or
  contact) for a file, with a reminder, uploaded through the portal into the right folder; the assistant suggests the
  folder and tags.
- **Sign** (`sign.template`, `sign.request`): a PDF with fields placed by drag (signature, initials, date, text,
  checkbox) and roles; requests to signers **in order or in parallel**, by email link with a **one-time code** by
  email or SMS; signing in the browser on a phone; the final PDF **sealed** with the signatures, a certificate page
  (who, when, IP, the document's hash before and after) and stored as a document; **sign from any record** — a
  quotation, an employment contract, a purchase order — with the signed PDF attached to it.

## 3. Shared principles

- Every amount is a Shutro Decimal; every rule a server rule; every approval through the approval engine.
- Rates and legal values (tax slabs, depreciation rates, holidays, overtime factors) are **data** with effective
  dates, loaded by localization modules, never constants in code.
- Personal data (salaries, attendance locations, signatures) is visible to the people who need it only (field groups
  and record rules), and every read of a payslip by someone other than its employee is audited.
- External services (biometric devices, banks, wallets, couriers, OTP SMS) behind adapters with a fake provider for
  tests; nothing calls out without credentials configured.

## 4. Delivery plan (each step reviewed)

1. **Spend** (expenses, categories with policies, reports and approvals, advances, `expense_account`).
2. **Attendance** (shifts, kiosk and phone check-in, device import, days with overtime).
3. **Payroll** core and `payroll_account`, then `l10n_bd_payroll`.
4. **Helpdesk**.
5. **Dimensions, assets and budgets**.
6. **Replenishment and routes**.
7. **Shop** with couriers.
8. **Documents and Sign**.

## 5. Open questions

1. **Order**: as above (people and money first, then service, assets, supply, selling, paper)?
2. **Payroll scope**: Bangladesh rules first, the core structure engine general so other countries follow?
3. **Sign's PDF**: stamping signatures into the PDF and sealing it needs a PDF library — `pdf-lib` (MIT, no native
   code) is proposed; the alternative is rendering the signed document again as HTML → PDF, which cannot keep an
   uploaded PDF as it was.
4. **Couriers and banks**: which to build first after the fake providers (Pathao / Steadfast / RedX; which banks'
   payroll files)? Real adapters need their sandbox credentials.

## Alignment with CLAUDE.md

- Metadata-driven and customizable without forking: rules, policies, routes and structures are records; screens come
  from views; other modules extend them.
- Secure by default: policies, budgets and approvals are enforced on the server; payroll and attendance data are
  restricted by field groups and record rules.
- Kosh never reimplements ORM features: anything Shutro lacks is written as a request before a work-around.

## Decisions (2026-11-01)

1. **Order**: as proposed — Spend, Attendance, Payroll, Helpdesk, dimensions with assets and budgets, replenishment and
   routes, Shop, Documents and Sign.
2. **Payroll**: a country-neutral structure and rule engine, with Bangladesh's rules in `l10n_bd_payroll`.
3. **Sign** adds `pdf-lib` (MIT, no native code) to stamp signatures into uploaded PDFs and seal them.
4. **Adapters**: every external service behind an adapter with a fake provider now; the real couriers (Pathao,
   Steadfast, RedX), payroll files (bKash / Nagad and a bank) and ZKTeco import come with their sandbox credentials.

## Implementation notes (2026-11-01): step 1 — Spend and `expense_account`

- **Categories** (`expense.category`): claimed as an amount, per day or per kilometre (with the rate; the amount is
  the rate times the quantity, filled on the form and checked by the server); the policy — a limit per expense, a
  limit per person and month, a receipt above an amount (empty: always) — and the tax included. Five categories ship
  (Travel, Meals, Daily allowance, Own vehicle, Office supplies).
- **Expenses** (`expense.expense`): the employee (the user's own, filled), date, category, quantity, amount with the
  tax included (and the tax worked out of it), paid to, receipt number, paid by the employee or the company card,
  the report; the status follows the report. The receipt is an attachment, so the assistant's *Fill from a
  document* reads a photo into the form as on any model.
- **Reports** (`expense.sheet`): submitted with the server's **policy check** — a missing receipt refuses the
  submission; an expense beyond a limit needs its reason, and marks the report `overPolicy`, which brings the
  *Beyond the policy* approval level (Spend managers); likely **duplicates** (the same amount, date and category,
  or the same receipt file by its hash) are flagged for the approvers. Approvals through the engine: every report
  by an approver, beyond-policy and large (over 50 000) reports by a Spend manager as well, never by the person
  asking. Employees change their expenses and reports only before submission (record rules).
- **Cash advances** (`expense.advance`): requested, approved (large ones by a manager), paid out, then **settled** by
  later reports — each takes what is left of the advance up to its total; the rest is returned at settlement.
- **`expense_account`** (proposed with Accounting): a category's expense account; an approved report is **booked**
  as one posted entry in the Expenses journal (`EXP`) — the amounts less tax to the categories' accounts, the tax to
  the tax's account, against Employee advances (1170) for what an advance covered, Employee reimbursements payable
  (2170) for what the employee paid and Company card clearing (2180) for the card — and **reimbursed** from the cash
  or bank journal chosen on it. An advance's payout and the cash returned are booked from its journal. Accounts and
  the journal are made when the chart lacks them.
- **The standard** (RFC 0023): Spend meets every rule but Bangla (step 5 of RFC 0023): search, chatter, help on the
  states, print templates (the expense report, the cash advance voucher), import templates (expenses, advances,
  categories; reports waived — they are made from expenses), named events (report submitted and approved, advance
  requested and paid out), the overview, demo data.
- **Not in this step**: expenses in a foreign currency (one currency per company for now), approval by the line
  manager (the approval engine routes by role; manager routing is a later addition to the engine), reimbursement
  through payroll (step 3), cost centres on expenses (step 5).
- **Tests**: Spend on real PostgreSQL — the receipt and the reason at submission, approvals with the policy level,
  locked after submission, never one's own, duplicates, the rate, own records only, an advance approved, paid out by
  a manager and settled; the demo. `expense_account` — the bridge proposed; booked (balanced, by account) and
  reimbursed from the cash journal; an advance paid out, settled by a report and the rest returned, Employee
  advances back at zero. E2E: an allowance at the rate, a report submitted, approved by a Spend manager in the
  approvals panel; the overview.

