# RFC 0032 — Requests (indents), Workforce for groups, Stockroom for depots, procurement

- Status: Accepted (2026-11-08)
- Builds on: RFC 0021 (Workforce, Stockroom), RFC 0024 (replenishment, routes), RFC 0025 / 0027 (the Approvals
  engine and matrix), RFC 0029 (follow-ups), RFC 0030 (returns, landed costs)
- Sources: Paragon's Odoo addons `indent_request` and `pg_employee`; the screen recordings `inventory-bs23.mp4` and `purchase-bs.mp4`
  (Paragon's Inventory in use across 36 warehouses and depots of 7 companies)

## 1. Why

A group like Paragon runs feed mills, farms and depots across many companies. Three things are missing from Kosh:

- **No internal requests.** A section asks the store for goods ("indent"), the store issues them, and a depot asks
  another warehouse to send stock. Today this is a phone call and a transfer typed by the store keeper: nobody
  approves it, nobody sees what is still owed, and stock "on the road" between two warehouses is invisible.
- **Employees lack the group's structure.** A unit head beside the manager, the property or unit someone works for,
  and approvers for expenses are kept outside the system.
- **Stockroom lacks the depot's daily screens.** Transport details at the gate (truck, driver, freight bill, deductions
  from the supplier), stock-in-transit notes, a ledger by movement type (opening, received from purchase / returns /
  production / transfer / adjustment, issued to …, closing), a stock report across chosen warehouses and locations,
  and the "My operations" board with what is ready and late in each depot.

## 2. Where we go further than the addons and Odoo

| | Paragon's Odoo addons | Kosh after this RFC |
| --- | --- | --- |
| Indents | Draft → submitted → approved → done → acknowledged; approvers from product groups, hard-coded levels | The same states, approvers through the **Approvals engine** (product group, department head, amount, matrix by company) with deadlines, delegation and decisions from email; **what is still owed** per line, partial issues, the raiser's acknowledgement, reasons on rejection |
| Issue from store | Issue records, "Issue All" | Issues are **Stockroom transfers** (reserved, lots first-expiry-first-out, valued by `stock_account`, charged to the section's cost centre) — one stock truth |
| Purchase requests | A list of approved lines with remaining | **Request for quotation from the shortfall** in one step (vendor chosen by RFC 0030's vendor prices), linked back to the indent line |
| Transfers between warehouses | STN / SRN as separate models, pickings created in code | STN and SRN are **two transfers through a transit location**, shipped and received with lots, **in-transit stock and value visible**, shortages on receipt recorded with a reason, the indent done when fully received |
| Employees | Extra fields, a re-laid form | Unit head and property **used by approvals** (the unit head as an approver kind), expense and leave approvers on the employee, the work schedule beside them |
| Inventory | Odoo + custom reports | Transport details with **freight deducted from the supplier's bill**, gate and QC notes, the **stock ledger by movement type** (any period, any warehouses, quantity and value), My operations board — all in Community, in Bangla |

## 3. Design

### 3.1 Requests — a new module `indent` (app "Requests"), depends on `stock`, `approvals`, `hr`

- `indent.product.group`: name, products / categories, approvers (users) — used as an approver source by the
  Approvals matrix ("product group approvers", like RFC 0027's product category).
- `indent.request` (IND/…): requester (user, default me), employee and department (from the user), warehouse (the
  store asked), destination location (the section's consumption location or cost centre), required date, priority
  (0–3 as stars), purpose, lines; state `draft → submitted → approved → partially_issued → issued → acknowledged`,
  plus `rejected` (reason required) and `cancelled`.
- `indent.request.line`: section / note rows, product, unit, requested qty, approved qty (editable by approvers,
  never above requested), issued qty (from transfers), remaining, on hand in the warehouse (computed, explained).
- Submit runs the Approvals engine with the policy for `indent.request` (default policy installed: product group
  approvers, then the department head above an amount). Approved quantities can be lowered at each level.
- **Issue** (store keeper): creates or updates one internal transfer warehouse → destination for the remaining
  approved quantities; validating it (partially or fully, with backorders) updates issued quantities. "Issue all" =
  validate with every reserved quantity.
- **Acknowledge** (requester) closes it; issued-but-unacknowledged after N days (app setting) reminds once.
- **Purchase shortfall** (`indent_purchase` bridge): approved lines with remaining > on hand → "Request for
  quotation" grouping by vendor via `vendorPriceFor`; the RFQ line links the indent line, receipt updates it.
- **Transfer indent** (`kind = transfer`): a depot asks another warehouse. On approval a **Stock Transfer Note**
  (an internal transfer source → the source warehouse's transit location) is drafted; shipping it (with truck and
  driver, §3.3) creates the **Stock Receive Note** (transit → destination); receiving it — partly, with a shortage
  reason for the difference — completes the indent. Both notes are ordinary transfers with a `note_kind`
  (`stn` / `srn`), numbered STN/… and SRN/….
- Groups: `indent.user` (own requests, those they approve), `indent.store` (store keepers: requests of their
  warehouses), `indent.manager` (all, configuration). Record rules by requester and warehouse.
- Menus: My requests, To approve (from Approvals), To issue, Transfers (to ship / to receive), Purchase shortfall,
  Reporting (lines pivot by department, product, month), Configuration (product groups). Print templates for the
  indent, the STN and the SRN; import templates; Bangla.

### 3.2 Workforce updates (`hr`)

- `hr.employee`: `unitHead` (m2o employee, tracked), `property` (char, "Property / unit"), `mobile`, `tags`,
  `coach`, `expenseApprover` (user), `leaveApprover` (user), `workingSchedule` (the Attendance shift or calendar when
  installed), `timezone`.
- The form re-laid as in `pg_employee`: header in two columns (work email, phone, mobile, tags, company, property |
  department, position, manager, unit head, coach); Work information with an **Approvers** card and a **Schedule**
  card.
- Approvals: a new approver kind **the employee's unit head** next to "the requester's manager"; Spend reports use
  `expenseApprover` when set, leave uses `leaveApprover`.
- Employment types: code and country (`hr.contract.type`), as in the addon. Sales territories and payroll tabs of
  the addon are not copied (empty in the source).

### 3.3 Stockroom updates (`stock`, `purchase_stock`, `stock_account`)

- **Transport details** (`stock.transport`, on receipts and deliveries, also on STN): vehicle number, driver, mobile,
  transport vendor, date, in / out time at the gate, bill amount, "deduct from supplier" with the amount, extra
  products (bags, pallets), additions / deductions lines, remarks, gate and QC notes. With `purchase_stock_account`,
  a supplier deduction becomes a line on the vendor bill (or a vendor credit if already billed); the freight bill
  of the transport vendor is drafted as a bill and can feed a landed cost (RFC 0030).
- **Additional info on transfers**: carrier, tracking reference, weight (from products), responsible, sale / purchase
  order and project links shown in one card.
- **Stock ledger** (report, screen + XLSX + PDF): for a period, chosen warehouses / locations / categories / products
  and lots, per product: opening, received by type (purchase, sales return, production, transfer in, adjustment,
  other), issued by type (purchase return, delivery, production consumption, transfer out, adjustment, scrap, other),
  closing; quantity always, value with `stock_account`; a "summary" and a "details" (each move) mode; every figure
  drills to its moves. Movement types are derived from location usages and links, not typed by users.
- **Stock report**: on hand, reserved, available and incoming across chosen warehouses and locations, by category,
  with History and Replenishment from each row (existing quant list improved).
- **My operations**: a board of cards per operation (warehouse × receipts / deliveries / internal / STN / SRN) with
  ready, waiting and late counts, each opening the filtered list; the Stockroom overview's first tab.
- **In transit**: transit locations per warehouse created on install; in-transit quantity and value shown on the
  warehouse and in the ledger.

### 3.4 Purchase updates (`purchase`, new `purchase_request` and `purchase_tender`), from `purchase-bs.mp4`

The recording shows procurement as a chain: **purchase request → RFQ to several vendors → vendor responses →
comparative statement (financial, and technical when needed) approved → purchase order → work acceptance or
receipt**, every request line followed through the chain.

- **Purchase requests** (`purchase_request`, PR/…): company, requester, date, priority, linked indents, cost centre;
  lines with product group, product, unit, category, quantity, due date, cost centre; state draft → submitted →
  approved → done (cancelled). Approval through the Approvals engine. Indents' shortfall (§3.1) **creates purchase
  requests** (not RFQs directly) when this module is installed.
- **The line tracker** ("PR line master tracker"): every approved request line with its buyers (assignment by product
  group, several buyers), approved quantity, quantity transferred from a sister company, quantity to buy, and the
  RFQ, comparison and purchase order it reached with their states; tabs All / Assigned to me / Not assigned /
  Approved / RFQ created / In comparison / Vendor selected / Comparison approved / PO created / Done / Cancelled.
- **RFQs to many vendors** (`purchase_tender`, RFQ/…): sourcing local or import, PO type, topic, vendors, response
  deadline, delivery date, payment term and method, currency, VAT / tax term, advance %, technical comparison
  required; lines from request lines (several requests into one RFQ); evaluation criteria with weights; state draft
  → sent → responses received → in comparison → vendor selected → PO created (cancelled). The RFQ dashboard counts
  them by state.
- **Vendor responses**: one per vendor, sent as a **quote link** (the vendor fills prices, delivery and terms in the
  portal without an account, or the buyer types them); lines with quoted price, attachments, technical rank; state
  draft → quoted → submitted, or not responded / rejected.
- **Comparative statement** (CS/…): a workspace with the vendors as columns and the products as rows — quantity,
  quote, **negotiation rounds** (Nego 1, Nego 2), final price, total — and the terms side by side (payment, VAT,
  advance, delivery); the lowest final price highlighted per line, **lines awarded to different vendors** (multi
  vendor), an expiry date; approved through the Approvals engine (e.g. GM SCM above an amount), then **Confirm**
  creates one purchase order per selected vendor with the final prices, linked back to the request lines. A
  **technical CS** (an assigned engineer scoring each vendor on specifications) must be approved first when the RFQ
  asks for it.
- **Purchase orders**: PO type, sourcing type, LC yes / no (opens the Trade Finance LC from the order), advance %,
  project, agreement, the vendor's on-time rate beside the expected arrival (RFC 0030's scorecard), product group
  and packaging on lines, "Check budget" (RFC 0024's budget check shown before confirming), the estimated landed cost
  tab (RFC 0030), vendor search by name, TIN, email or reference.
- **Agreements** (blanket orders): vendor, validity, lines with quantity, ordered and price; orders draw on them at
  the agreed price until the quantity or date runs out; draft → confirmed → closed.
- **Work acceptance** for services: vendor, purchase order, responsible, due date, lines accepted; bills of service
  lines are limited to accepted quantities (like received quantities for goods).
- **Vendor requests**: a request to add a vendor (name, address, NID, trade licence, proprietor and mobile) approved
  through the engine, then created as a contact marked vendor; until then nobody can order from it.

## 4. Steps

1. **Requests core**: `indent` with product groups, requests and lines, approvals through the engine, issues as
   transfers, acknowledgement, reminders, print / import templates, Bangla, demo data.
2. **Transfer indents**: transit locations, STN / SRN, shortages on receipt, in-transit stock; `indent_purchase`.
3. **Workforce**: the employee fields and form, the unit head approver kind, expense and leave approvers,
   employment type code and country.
4. **Stockroom part 1**: transport details with supplier deductions on bills, additional info, My operations.
5. **Stockroom part 2**: the stock ledger (summary and details, quantity and value) and the stock report.
6. **Purchase requests** and the line tracker; indents' shortfall into requests.
7. **RFQs to many vendors** with vendor responses and quote links, the RFQ dashboard.
8. **Comparative statements** (financial with negotiation rounds and split awards, technical), orders from them.
9. **Purchase order fields, agreements, work acceptance and vendor requests.**

Each step ends with the full gate (typecheck, lint, tests, both E2E projects), docs and the roadmap.

## 5. Not in this RFC

- Batch, wave and cluster transfers; a dispatch / fleet management system (the video shows them switched off).
- Petty cash, Gate QC as an app of its own (the video shows them as separate apps; QC notes on transport only here).
- Feed-specific production (shift and overhead costs) — covered by RFC 0031 steps 4–5.

## 6. Notes

- **Step 1 (2026-11-08).** `modules/indent` (app *Requests*): product groups by category with their approvers;
  indents with the requester's employee and department filled in, the store and an internal-use location; lines with
  their group (computed from the category), approved / issued / still owed quantities and what the store holds;
  approvals through the engine — department head, then product group approvers (`approvalUsers('groups')`), each
  able to lower quantities —; **Issue** as one internal transfer to the internal-use location (backorders stay with
  the indent), **Acknowledge** by the requester; record rules for requesters, deciders and store keepers; print and
  import templates, events, the overview, demo data, Bangla. Stockroom gained the *Internal use (consumed)* location
  usage and the shared `Internal use` location; internal transfers may end there. Manifests' approval levels may name
  `department_head`, `department_approvers` and `{ record }` approvers. Not yet: the reminder for unacknowledged
  indents, a per-section expense account for consumption (the product category's cost of goods sold is used), header
  fields locked after approval (only the rules' states guard them).
- **Step 2 (2026-11-08).** Transfer indents: the kind (issue / transfer), a transfer going to a stock location of
  another warehouse; each warehouse's *Transit* location (`transit` on locations: held as stock, left out of the
  warehouse's own stock and on-hand) made by `transitLocation()`; the Stock Transfer Note into transit on Issue, the
  Stock Receive Note made when it is validated (`validated` override) and reserved on the goods in transit, partial
  receipts on backorders that keep their note; the shortage written off from transit with its reason as an
  adjustment; shipped / in transit / short per line. STN and SRN are transfers numbered by Stockroom (their kind is on
  the transfer). Not yet: `indent_purchase` (the shortfall into purchase requests moves to step 6, where purchase
  requests are built), a Goods in transit account (transit stays in the Inventory account).
- **Step 3 (2026-11-08).** Workforce: the employee's job title, work mobile, tags (`hr.employee.tag`), unit head,
  coach, property, expense and leave approvers and time zone, the form laid out as `pg_employee` (contact and property
  beside the reporting line, Approvers and Schedule cards); employment types (`hr.contract.type`: name, code, country
  as an ISO code — Kosh has no country model) on contracts; the approval engine's kind **a person on the requester's
  employee record** (`approver: { employee }` in manifests); Spend's first level asks for the expense approver; leave
  decided by the leave approver instead of the manager. Not copied: the addon's empty Sales Territories tab, the hidden
  Payroll tab (Kosh's Payroll keeps its own screens), the Attendance shift on the employee (Attendance's rosters hold
  it).
- **Step 4 (2026-11-08).** Stockroom part 1: additional information and transport details on every transfer
  (`stock.picking.charge` for additions and deductions, `stock.picking.extra` for goods that came along); the freight
  bill and the supplier's refund drafted by `stock_account` when the transfer is validated, each once (as drafts: the
  accountant chooses the accounts); **My operations** as a client page over `GET /api/v1/stockroom/operations`, the
  counts computed as the user with the domain each one opens. Not yet: the sale / purchase order and project links in
  one card (the bridges already append their own fields to the transfer form), the freight bill as a landed cost
  (drafted by hand from the bill, RFC 0030 §3.3).

