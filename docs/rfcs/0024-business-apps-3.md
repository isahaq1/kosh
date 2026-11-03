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

## Implementation notes (2026-11-02): step 2 — Attendance

- **Shifts** (`attendance.shift`, shared by every company): start and end as `HH:MM` (an end earlier than the start
  is the next day: night shifts), the break, the grace before an arrival is late, overtime after so many minutes and
  counted in steps (30: half hours), the overtime rate (2: the Labour Act's twice the hourly basic, for Payroll).
  General (09:00–18:00) and Night (22:00–06:00) ship. **Rosters** assign a shift for a period, never overlapping;
  without one, the person's usual shift (on the employee) applies.
- **Punches** (`attendance.record`): from the **phone** (`POST /api/v1/attendance/punch`: the nearest site with
  coordinates decides — within its radius, else refused when its geofence is on; only on site or not and the
  distance are kept), the **kiosk** (a device signed in with the kiosk role: a badge scanned, or a name and a PIN on
  the pad — PINs are stored hashed, five wrong ones lock the person for 15 minutes on that node, each wrong one is
  audited), a **device file** (`POST /api/v1/attendance/import`: ZKTeco's attendance log or a CSV, behind a format
  adapter; each person's punches of a day in pairs; a punch already imported is skipped; one left alone is a
  check-in on the person's last day and reported otherwise), or by hand. One open check-in per person, no overlaps;
  a second tap within a minute is not a check-out.
- **Days** (`attendance.day`), computed in the installation's time zone (App settings › Attendance, Asia/Dhaka by
  default) whenever a punch lands and on request (`POST /api/v1/attendance/days/compute`, three months at most):
  worked time (the shift's break deducted, less the breaks the punches show), expected time, late after the grace,
  early leave, absent on a working day without punches, on leave (approved Workforce leave), holiday, weekend
  (Workforce's week), check-out missing; overtime past the threshold in whole steps, and every hour on weekends and
  holidays. Approved overtime starts as the overtime and may be lowered; **approving** (an Attendance manager, never
  for oneself) locks the day — recomputing leaves it — and emits `attendance.day.approved` for Payroll.
- **Screens**: the phone check-in page (one button, the location sent with it, today's hours), the kiosk (badge box
  and PIN pad, a greeting that clears itself), the PIN set from the employee's form (managers only: the badge, device
  number and PIN are readable by Attendance managers only), days with list, calendar and pivot, the attendance
  register as a printed list, rosters on a calendar, an overtime tile on employees, the overview.
- **Limits**: the PIN lock is per server node (a shared lock with Valkey when there are several); face photos at the
  kiosk are not taken; seed data cannot go into company-scoped models during installation, so shifts are shared by
  every company; ZKTeco's network protocol (pulling from the device) is not here — its exported log is.
- **Tests**: the day rule without a database (on time with overtime in steps, late, early, the break, a night shift,
  weekends, absence, leave, holidays, a missing check-out, the time zone, the ZKTeco and CSV files, distances); on
  real PostgreSQL the phone's geofence, the kiosk's badge and PIN with the lock, badges and PINs hidden from people,
  a ZKTeco file imported once, days with a holiday, approval by a manager only and kept on recomputing, own days
  only, the demo. E2E: a PIN set on the employee form, a check-in at the kiosk, seen on the phone; the overview.

## Implementation notes (2026-11-02): step 3 part 1 — the Payroll engine and `payroll_account`

- **The formula language** (`formula.ts`): a hand-written parser, never `eval`; Decimals throughout; variables in
  capitals, `+ - * /`, comparisons, `and` / `or` / `not`, `min`, `max`, `abs`, `round`, `floor`, `ceil`, `if`, and
  `slab('CODE', amount)` for progressive tables; 500 characters at most. A rule whose formula or condition does not
  parse is refused when saved; `POST /api/v1/payroll/formula` checks one and lists the variables it reads.
- **Structures and rules** (`payroll.structure`, `payroll.rule`): rules in order, each a code, a category (basic,
  allowance, deduction, company contribution, for information), a formula, an optional condition and effective
  dates. **Parameters** (`payroll.parameter`, read as `P_CODE`) and **slab tables** (`payroll.slab` with bands) are
  data with effective dates, each with a note of where the value comes from.
- **Runs** (`payroll.run`): computed from every running contract with a structure (`hr.contract.structure`) — one
  payslip a person, by their most recent contract, with a warning when they hold several. Each rule sees the
  variables of `compute.ts` (the wage, the period's and contract's days, service, the fiscal month — App settings ›
  Payroll, July by default —, Attendance's **approved** days with the approved overtime and its rate, the month's
  inputs, loan instalments, year-to-date sums by code, parameters) and the codes before it; unset `INPUT_` and
  `YTD_` read as zero. Every **line** keeps its explanation (`45000 × 0.6 × 31 ÷ 31 = 27000`). Payslips warn about
  attendance days still waiting for approval. A formula that fails stops the run, naming the person and the rule.
- **Approval** (`payroll.approve`, managers) locks the run and records each running loan's instalment; repaid loans
  end. People read their **own** payslips, and only once the run is approved. A **correction**
  (`POST /api/v1/payroll/runs/:id/correction`) is a new run of the same period whose payslips show what was paid
  before and the difference to pay; the corrected run stays as it was; year-to-date sums read the latest payslip
  of each period.
- **Payment files** (`GET /api/v1/payroll/runs/:id/payment-file?format=`): a generic bank CSV, bKash, Nagad and
  Rocket bulk-disbursement CSVs and a cash sheet, each taking the people paid that way (the employee's pay details,
  readable by payroll officers only), behind a format adapter; every file made is audited.
- **`payroll_account`** (proposed with Accounting): rules may name their account; an approved run is one posted entry
  in the Payroll journal (`PAY`) — basic, allowances and contributions to their expense accounts (Salaries, 6000),
  deductions to their payables (2191), contributions against 2192, the net to Salaries payable (2190); paying it
  clears 2190 from the bank or cash journal chosen on the run; a correction books only its differences, line by line.
- **Not in this part**: the Bangladesh rules (part 2, `l10n_bd_payroll`), reimbursing expenses with the next run,
  each read of someone else's payslip in the audit log (generic reads are not audited one by one yet), and real bank
  file formats (they need each bank's specification).
- **Tests**: the language without a database (arithmetic, logic, functions, slabs, zero inputs, the explanation,
  mistakes with reasons); on real PostgreSQL a broken rule refused, a month with approved overtime, an absence, a day
  not approved, a loan and a bonus — each line's amount and explanation —, officers compute, managers approve, the
  instalment recorded, a run locked, own payslips after approval, the bank and bKash files, a correction paying only
  the difference, November's year-to-date, the demo; `payroll_account` booking, paying and a correction's entry.

## Implementation notes (2026-11-03): step 3 part 2 — `l10n_bd_payroll`, and the engine's last pieces

- **The engine** gained what country rules need without any country in it: **per-person values**
  (`payroll.employee.value`, read as `E_CODE`, with effective dates: a provident fund membership, the year's declared
  investment, a fixed allowance), the run's **festival flag** (`FESTIVAL`), and the running **`GROSS`** and
  **`DEDUCTIONS`** of the rules before (income tax reads the gross).
- **`l10n_bd_payroll`** (proposed with the Bangladesh localization and Payroll) installs, once and shared by every
  company, two **structures** — *standard* (basic as a share of the gross, house rent and medical on the basic,
  conveyance the rest) and *garments (RMG)* (the minimum wage gazette's breakdown: the gross less medical 750,
  transport 450 and food 1 250 is the basic and its 50% house rent) — with the same tail: **overtime** at the
  shift's rate (twice, Labour Act s.108) of the basic ÷ 208 an hour, a **festival bonus** of the basic in a festival
  run after twelve months' service, **absence** on the basic ÷ 30, **provident fund** (10% and 10%) for members,
  loan instalments, and **income tax deducted at source**: the year's salary projected (this year's taxable pay so
  far, this month's, the regular pay over the months left), the exempt part (the lower of a third and 4,50,000),
  the slab table in force, the investment rebate (the lowest of 3% of the taxable income, 15% of the investment and
  10,00,000), the minimum tax, less what was deducted, over the months left. Irregular pay is taxed when paid.
- **Data, to verify**: the parameters and the two `BD_TAX` tables (income year 2025–26: 3,50,000 free then 5% to 30%;
  2026–27 and 2027–28: 3,75,000 free, the 5% band gone) each carry a note to check them against the year's Finance
  Act and NBR circular; company policies (the basic's share, provident fund rates) are marked as such. Installing
  again adds what is missing and never overwrites a manager's change.
- **Not in this part**: the yearly salary certificate and tax statement per employee, earned leave accrual into
  Workforce's balances, the investment declaration's proofs, and the minimum tax by city (one value for now).
- **Tests**: on real PostgreSQL the bridge proposed, the data installed once (a changed value kept), a standard
  payslip worked by hand (60 000 / 30 000 / 6 000 / 4 000, provident fund 6 000 each side, 1 200 000 projected,
  400 000 exempt, 48 750 on the slabs, a 24 000 rebate, 24 750 for the year, a twelfth deducted; August deducting
  what is left over eleven months), garments (6 700 / 3 350 / 750 / 450 / 1 250 from 12 500, the Eid bonus after a
  year and not after six months, no tax).

## Implementation notes (2026-11-03): step 4 — Helpdesk

- **Teams** (`helpdesk.team`): agents, business hours (opening and closing, the weekend) and how new tickets are
  assigned — by hand, in turn, or to the agent with the fewest open tickets; whether solved tickets ask for a
  rating. **Stages** for the board, **types**, **canned replies** with `{{customer}}`, `{{ticket}}` and `{{agent}}`.
- **Tickets** (`helpdesk.ticket`): from the back-office or by email to `helpdesk@` (a catch-all alias: the sender
  is found among the contacts by address or added as one; replies come back into the chatter through the reply
  address, RFC 0006). A life cycle of its own beside the board's stages — open, **waiting on the customer**,
  solved, closed, merged — so the SLA clock is exact: waiting records its start, resuming adds its working minutes
  to the pause.
- **SLA policies** (`helpdesk.sla`): the first by sequence that matches the ticket's team, priority (this one or
  higher) and customer gives the first-reply and resolution targets in business hours (the team's, in the time zone
  of App settings › Helpdesk). The **clock** (`sla.ts`, every five minutes and `POST /api/v1/helpdesk/refresh`)
  assigns, applies the policy, reads the **first reply** from the chatter (the first message, not a note, by an
  agent), **resumes** a waiting ticket when the customer writes back by email, and sets the status — on track, at
  risk (less than a fifth left), breached, met. Tickets are in the change feed, so automation rules act on a breach.
- **Solving** asks the customer for a **rating** through a one-time link (`/api/v1/public/helpdesk/rate`, no sign-in,
  rate limited, across companies by its token) sent by email when SMTP is set. **Merging**
  (`POST /api/v1/helpdesk/tickets/:id/merge`) moves the conversation into the other ticket, both visible to the agent.
  Drafted replies come from the chatter's assistant (RFC 0013), as on any record.
- **Framework**: a catch-all alias's `defaults` now receives the sender (`{ address, name }`), so a module can name
  the customer.
- **Not in this step**: the portal page of a customer's tickets, tickets from Sites' forms (a `website_helpdesk`
  bridge), public holidays in business hours, timesheets on tickets, and escalation rules shipped by the module
  (automation rules can be made on the change feed today).
- **Tests**: business hours without a database (across the weekend, before the opening, after the closing, every
  day; minutes between); on real PostgreSQL assignment in turn, the matching policy (urgent's faster), agents of
  the team only, the first reply, waiting two hours pushing the resolution back and the customer's email resuming
  it, a breach after nine hours, met when solved, the rating link once and the token hidden from agents, merging
  (refused to an agent who cannot see both), a canned reply filled in, tickets from email with the sender as one
  contact, the demo. E2E: a ticket opened, put on waiting and solved; the overview.

## Implementation notes (2026-11-03): step 5 part 1 — cost centres and fixed assets

- **Cost centres** (`account.analytic`, in Accounting, which moves to 0.4.0): code, name, a parent for a tree; an
  optional **cost centre on every journal line** (invoice lines included), shown on the lines and the ledger, and a
  *By cost centre* pivot (balance by account type, against the previous period). Budgets read it (part 2).
- **`account_asset`**: **categories** (the asset, accumulated depreciation, expense, gain and loss accounts, the
  journal, the method, the life, the declining rate, prorata, and the tax book's rate) and **assets** — from a
  posted bill's line on a category's asset account (a subscriber of `account.move.posted` makes a draft asset,
  once per bill line, with the vendor and the line's cost centre) or by hand, or imported as an opening register.
- **Boards** (`board.ts`, pure): straight line over the life with the first month from the date of use and the rest
  in one more month; declining balance on what remains, switching to straight line over the months left when that
  is more, ending at the salvage value; units of production from each month's usage. Planned on confirmation; the
  lines due are **posted once each** (daily on the server, `POST /api/v1/assets/post-due`), Depreciation against
  Accumulated depreciation with the asset's cost centre on the expense; a fully depreciated asset closes.
- **Disposal and sale** (`POST /api/v1/assets/:id/dispose`): depreciation up to the date, then one entry taking the
  cost out, the accumulated depreciation back, the proceeds in and the **gain or loss** booked; the rest of the board
  dropped. **Revaluation and impairment** (`POST /api/v1/assets/:id/revalue`): a lower value impairs (the loss
  against accumulated depreciation), a higher one revalues (against Revaluation surplus, 3150, made when missing);
  the rest of the board is planned again from the new value.
- **The tax book** (`GET /api/v1/assets/tax-book?year=`): reducing balance at the category's tax rate, a full year
  in the year of acquisition (Bangladesh's Third Schedule as last known — **verify the rates and the first-year rule
  for the year**), the opening and closing written-down values beside the year's accounting depreciation and book
  value, and the difference for deferred tax. Odoo keeps one book.
- **Not in this part**: budgets (part 2), the tax book's screen (the API and its rows for now), deferred tax entries
  from the difference, assets split from one bill line by quantity, and asset counts by tag.
- **Tests**: the boards without a database (straight line in full and prorated months, declining balance to the
  salvage value, units capped, the tax book's reducing balance); on real PostgreSQL a 120 000 asset over twelve months
  — three posted once each with the cost centre, an impairment from 80 000 to 60 000 replanning eight months at
  7 500, a sale for 50 000 on a 45 000 book value booking a 5 000 gain in one balanced entry —, its tax-book row
  (24 000 against 55 000 in the books), a bill above the approval threshold approved and its asset line made a draft
  asset once, only managers posting, the demo.

## Implementation notes (2026-11-03): step 5 part 2 — budgets

- **Budgets** (`account.budget`, `account_budget`): a period, approved, closed or set back to a draft by Accounting
  managers (`account.budget`), with **lines** by cost centre and / or account — what for, the planned amount and a
  **control**: report only, warn or block.
- Each line's **actual** (posted journal lines of the period on its account — every expense account when none — and
  its cost centre) and **committed** amount (the untaxed lines of the period's confirmed purchase orders with its cost
  centre that are not billed yet; lines without an account or on the purchases account), what is **left** and how
  much is **used**, refreshed on approval, hourly on the server and by `POST /api/v1/budgets/refresh`; the lines list
  and pivot (by cost centre and budget), the printed *Budget against actuals*.
- **Purchase orders** carry a cost centre on each line (`purchase_account`, 0.2.0, which carries it onto the bill).
  When one is submitted (a `submitting` hook Purchase now calls before asking for approvals), the lines it touches
  are checked against what is left: beyond a **block** line the submission is refused with the shortfall; beyond a
  **warn** line the order is marked `overBudget` with the reason, and the *Purchases beyond a budget* approval policy
  brings an Accounting manager in — the order is confirmed by the last approval, as any other.
- **Not in this part**: budgets by month inside the year (a line per period for now), comparisons with last year's
  budget in the period pivots, commitments from expense reports, and revisions of an approved budget with their history.
- **Tests**: on real PostgreSQL the approval by a manager only, a posted bill as actual, an order within what is left
  going on, the refreshed figures (30 000 actual, 60 000 committed, 10 000 left), an order beyond the warn line marked,
  refused to its buyer's confirmation and confirmed by the manager's approval, an order beyond the block line refused
  with its 10 000 beyond, billing moving the commitment to the actual with the cost centre on the bill, the demo.

## Implementation notes (2026-11-03): step 6 part 1 — reorder rules and replenishment

- **Reorder rules** (`stock.reorder`, Stockroom 0.3.0): a product in a warehouse with a minimum, a maximum, a step
  (`multiple`), a lead time, a method — **buy** from a vendor, **make**, **transfer** from another warehouse — and
  whether the server orders it on its own; one rule per product and warehouse; edited by Stockroom managers.
- **The forecast** of a rule: on hand in the warehouse's stock location and those inside it, less what confirmed
  transfers take out of it, plus what they bring in, plus what other apps have **on order** (the rules' `pending()`
  method, extended by bridges). Reservations are not subtracted again: a reserved quantity is already on a transfer
  going out. Every open document counts, whatever its date (the RFC said "over the lead time": a later delivery is
  still stock that will be needed, and a later arrival would otherwise be ordered twice).
- **The proposal**: below the minimum, enough to reach the maximum, rounded up to the step; written on the rule with
  the reckoning in words — *On hand 100 − going out 60 (TR/2026/00004) + on order 40 (PO/2026/00012) = forecast 80;
  below the minimum 100: 120 to reach the maximum 200, ordered in steps of 50: 150.*
- **Ordering** goes through the rules' `procure()` method, by method: Stockroom makes one internal transfer per pair
  of warehouses, confirmed (reserved at the source); `purchase_stock` (0.2.0) adds the lines to a draft request for
  quotation from replenishment to the vendor for that warehouse, or makes one (the product's cost and purchase
  taxes, the arrival after the lead time); `mrp` (0.2.0) makes a production order with the bill valid on its date,
  confirmed — refused, with the reason, when there is none. A method no installed app orders is skipped with the
  reason. Purchase orders now say which warehouse they are **delivered to** (the main one when empty); the receipt
  goes there.
- **The Replenishment screen** (Stockroom › Replenishment): the rules with something to order (or all), their
  figures and the reckoning, the quantity editable, Order, Snooze for a week, Refresh. `POST
  /api/v1/stockroom/replenishment/refresh` (Stockroom users), `…/order` and `…/snooze` (Stockroom managers; ordering
  runs in an audited superuser scope after the rules are read as the user). Hourly on the server every rule is
  refreshed and the automatic ones ordered. Products show their rules as a tile; the Overview counts the products
  to reorder.
- **Not in this part**: rules per location inside a warehouse, vendors' price lists and lead times per product
  (the rule's vendor and the product's cost for now), forecasts by date (a chart of the projected stock), and the
  routes of part 2.
- **Tests**: on real PostgreSQL a transfer rule's reckoning word for word, a Stockroom user refused the ordering, the
  transfer ready at the source and counted as coming in, nothing ordered twice, the source warehouse seeing it go
  out, buying skipped without Purchase, snoozing; in `purchase_stock` a request for quotation to the vendor into the
  rule's warehouse after the lead time, a second rule adding to it, counted as on order, received into that
  warehouse and then counted once as coming in; in `mrp` a confirmed production order with the valid bill and its
  quantity, counted as on order, and a product without a bill refused; the demo's rules; end to end, the reckoning
  on screen, a changed quantity ordered on a request for quotation.

## Implementation notes (2026-11-03): step 6 part 2 — routes, putaway, make to order, dropship

- **Routes**: a warehouse receives in one step, two (Input, then stock) or three (Input, Quality control, then
  stock), and delivers in one, two (a pick into Output, then the delivery) or three (pick into Packing, pack into
  Output, deliver). The step locations are made beside the stock location when first needed. Shutro has no hook on
  a model's writes, so routing happens where Stockroom already decides: **confirming** a receipt into the
  warehouse's stock location sends it into Input, a delivery out of it leaves from Output and gets its pick (and
  pack) — confirmed, the pick reserving; **validating** a step makes the next receipt step from what was done, or
  reserves the next delivery step now that its stock is there. A location chosen inside the stock location is kept.
  Each step is a transfer of its own (`next` / *Steps before*), validated, done in part with a backorder (which keeps
  its next step) or cancelled — cancelling a delivery cancels the steps before it that are not done.
- **Replenishment** counts the whole warehouse (its stock location and the steps), so a receipt into Input is
  coming in, a pick inside the warehouse is neither in nor out, and a delivery from Output goes out once.
- **Putaway rules** (`stock.putaway`, Stockroom › Configuration): what arrives in a location — a product, or a
  category and those inside it — is put away in a location inside it; the product's rule first, then the closest
  category's, by sequence. Applied as a transfer is validated, line by line (`Put away in` on the line, which can
  also be chosen by hand).
- **Make to order**: a reorder rule may order *for each delivery* (`trigger: order`). Confirming a delivery from
  its warehouse orders what each of its lines needs through the rule's method — a transfer, a request for
  quotation, a production order — once; the line says on which document (*Ordered on*), its pick and pack carry it,
  and validating that document's transfer into the warehouse reserves the transfers that wait for it.
- **Dropship** (`purchase_stock`): a dropship rule (with a vendor; always for each delivery) takes its product's
  lines out of a delivery as it is confirmed, into a **dropship** transfer from the vendors to the customer — with the
  delivery's links (a sales order's, so what is delivered on the order follows) — and a request for quotation to
  the vendor marked *Dropship*, linked line by line. The order gets no receipt (the dropship is its transfer), is
  received when the dropship is validated, is never counted as on order for the warehouse and never valued in
  stock; its bill keeps the purchases account (`purchase_stock_account`), as the goods' cost.
- **Not in this part**: cross-docking, routes chosen per product or per sales line (a rule per product and warehouse
  for now), reservations for make to order that leave other stock alone (a make-to-order delivery also takes what
  is free), and dropship valuation through an interim account.
- **Tests**: on real PostgreSQL three-step receipts through Input and Quality control into a bay by a putaway rule,
  an invalid putaway refused, a three-step delivery's pick, pack and delivery each reserving the next, the chain
  cancelled with the delivery; a make-to-order transfer from another warehouse reserved for the delivery once it
  comes; a dropship split from a delivery with its request, no receipt, received and stock unchanged; a dropship
  bill off Goods received not billed; end to end, a two-step delivery's pick validated on screen.

## Implementation notes (2026-11-03): step 7 part 1 — the Shop: catalogue, cart, delivery fees and checkout

- **Headless, as Sites is**: the Shop (`website_sale`) is a public API for a storefront (the Next.js site later, or
  any other) beside the back-office screens. A site sells when it is marked *Shop*; every route is public, rate
  limited per address, and runs as the system in the site's company once the site is known.
- **Products**: *On the shop*, a shop description in English and Bangla (read in the visitor's `lang`), a weight,
  related products and an order. The catalogue: published products for sale, searched by name or code, by category
  (and those inside it), by price, sorted by the shop's order, price, name or newest, paged; a product's page with its
  published related products; the categories that hold published products.
- **Delivery methods** (`delivery.carrier`, Sites › Delivery methods): a fixed fee, by weight (the first kg, then
  each kg or part of one), or by zone (a fee inside a list of cities — Dhaka — and one outside); free from an amount;
  cash on delivery or not; the courier (the adapters come with part 2). The fee is a service product's line on the
  order, replaced whenever the cart or the method changes.
- **Carts** are quotations of the site's company for its visitor contact, with a secret token the visitor holds (only
  its hash is kept) and the site's salesperson (or its creator). Lines are priced by the server from the product —
  quantities only come from the visitor — with the product's taxes; at most 100 lines of up to 1 000 each.
- **Checkout**: name, email, phone, address and city, the method and the payment. The customer is found by email in
  the company, else made (a known customer's address is not changed by a visitor: the delivery address is written
  in the order's note). **Cash on delivery** confirms the order when the method takes cash and the total is within
  the site's limit; above it, the order is placed as a quotation for the team to confirm. **Online**, a payment
  starts with one of the company's providers (RFC 0017): `payment` now lets a transaction wait for another app's
  document (`startPayment`, `returnUrl`, and `payable()` on `payment.transaction`, overridden here) — once the
  provider confirms, the order is confirmed and invoiced, the invoice posted and the payment registered against it,
  once, and the visitor comes back to the storefront's address. The token then follows the order (`GET …/order`).
- **Back office**: Sites › Shop orders (placed orders), Shop products, Delivery methods; the order form shows the
  site, the method, how it is paid, when it was placed and the customer's note, with its online payments.
- **Not in this part** (part 2): couriers' adapters (Pathao, Steadfast, RedX with fakes), tracking in the portal and
  COD collection; `website_sale_stock` (availability, backorders); product variants with attributes; product pictures
  served publicly; coupons and promotions; abandoned-cart emails; SEO and the sitemap; an Overview for the Shop
  (overviews belong to apps, and the Shop is inside Sites).
- **Tests**: on real PostgreSQL the catalogue (published only, search, price filter, categories, sort, the Bangla
  description, related products published only, an unknown shop), the cart (no token, another token, a product not
  on the shop, quantities changed and removed, priced by the server), fees by zone inside and outside and by weight,
  cash on delivery confirmed within the limit and left as a quotation above it, a method without cash refused, the
  customer made with their address, an online payment with the test provider that confirms, invoices and pays the
  order once, the return to the storefront, the demo; end to end, a shop and its delivery method made on screen and
  a visitor's order in Shop orders.

## Implementation notes (2026-11-03): step 7 part 2a — couriers and stock on the shop

- **Couriers** behind one adapter each (`CourierAdapter`: book a parcel with the cash to collect, track it, cancel
  it; credentials from the environment, never in records), registered with `websiteSaleModule({ couriers })`. The
  test courier moves no parcel (tests and the demo move it with `advance`); Pathao, Steadfast and RedX adapters come
  with their sandbox credentials, as decided.
- **Shipments** (`delivery.shipment`, Sites › Shipments): a draft for each confirmed shop order whose delivery method
  has a courier — once, through the outbox (`sale.order.confirmed`) — with the customer's name, phone and address,
  the goods' weight and, paid on delivery, the cash to collect. *Book the courier* books it (the consignment id and
  the label); what the courier says becomes its tracking events and moves it along — picked up, in transit,
  delivered (the cash collected) or returned — hourly on the server and by `POST /api/v1/shop/shipments/refresh`.
  Cancelling asks the courier first. The customer follows the shipments with their token (`GET …/order`). Orders show
  their shipments as a tile.
- **`website_sale_stock`** (the Shop ↔ Stockroom bridge): products show *in stock*, *few left* (with how many, by
  the site's threshold) or *out of stock* from what Stockroom has available, services nothing (`shopAvailable()` on
  products, which the bridge overrides); a site that does not sell beyond stock refuses a cart line beyond what is
  available, saying how many are left.
- **Not yet**: the courier's own callbacks (through inbound webhooks, with the real adapters), COD remittances
  matched in Accounting, labels printed in bulk; then part 2b — coupons, abandoned carts, SEO and the sitemap,
  product pictures served publicly.
- **Tests**: on real PostgreSQL the shipment drafted once for a confirmed order (a replay makes no second one) with
  its cash and weight, booked, tracked in transit and delivered with the cash collected, followed by the token, not
  cancellable once delivered; few left with how many, out of stock, services without; beyond stock sold by default
  and refused with what is left otherwise; end to end, a parcel booked from the shipment's form.

## Implementation notes (2026-11-03): step 7 part 2b — coupons, abandoned carts, search engines, pictures

- **Coupons** (`shop.coupon`, Sites › Coupons): a code in capitals that takes a percentage off the goods (as each
  line's discount, so taxes follow), an amount off (a line of its own, never more than the goods) or the delivery fee
  — from a minimum, between two dates, up to a number of uses, once per customer (by email) if it says so. Put on the
  cart with `PUT …/cart/coupon`; a cart that falls below the minimum loses it; checked again and counted at checkout.
- **Abandoned carts**: a visitor may leave an email on their cart (`PUT …/cart/contact`). A cart left longer than
  the site's *Remind abandoned carts after* hours, with goods, gets one reminder (in the site's language) with a
  recovery code — the cart's token is never sent; only the code's hash is kept — in a link to the site's
  `/cart/recover`; `POST …/cart/recover` gives the cart a new token (the old one stops). Hourly on the server and by
  `POST /api/v1/shop/carts/remind`; sent after the commit through the mailer (`SMTP_URL`).
- **Search engines**: products have a search title and description (English and Bangla; the product's page returns
  them, falling back to the name and description); `GET …/sitemap.xml` lists the site's published pages (other
  languages under `/<lang>`) and the shop's products (at `/shop/p/<id>`) with when they last changed — the
  storefront's paths, documented.
- **Pictures**: `GET …/products/:id/image?w=256` serves a product's picture (or its thumbnail) without a sign-in,
  only of products on the shop, and only images.
- **Not yet**: product variants with attributes, the courier adapters' real APIs and callbacks, COD remittances
  matched in Accounting.
- **Tests**: on real PostgreSQL a percentage, an amount and free delivery; the minimum (and the coupon taken off
  below it), an ended coupon, an unknown one, a code not in capitals refused, a coupon used up, once per customer;
  a reminder sent once with the cart's lines, the code restoring the cart with a new token, the old token and the
  used code refused; the sitemap with the published products only; the search title; pictures refused for products
  without one or not on the shop.

