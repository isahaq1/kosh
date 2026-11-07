# RFC 0028 — The commercial core: price lists, credit control, invoicing by what was delivered, deals to quotations, quotation templates

- Status: Accepted (2026-11-07); implemented (2026-11-07)
- Builds on: RFC 0008 (Sales, Purchase, Products), RFC 0009 (Accounting), RFC 0021 (Pipeline, Stockroom, Shop,
  Counter), RFC 0025 / 0027 (Approvals)
- Source: [docs/odoo-gaps/README.md](../odoo-gaps/README.md) — the gaps several apps wait on (#1, #4) and the most
  valuable ones in Sales and Accounting

## 1. Why

The comparison with Odoo 19 found that selling in Kosh stops short in places every business meets in its first week:

- **One price per product.** There are no price lists: no customer prices, no quantity breaks, no promotions by
  date, no prices in another currency. RFC 0008 promised them. Sales, the Shop and Counter all wait on this.
- **One invoice per order, for everything.** There are no down payments, and an order can't be invoiced by what was
  delivered, even though Stockroom tracks it (`qtyDelivered`). There's no "to invoice" per line and no batch
  invoicing. Purchase has the same problem with bills and received quantities.
- **No credit control.** A customer's limit is neither warned about nor enforced, and orders carry no payment terms
  and no invoice or delivery address.
- **Pipeline is cut off from Sales.** A won deal can't become a quotation, and a confirmed quotation doesn't win its
  deal.
- **Every quotation starts empty.** There are no templates and no optional products the customer can add from the
  portal.

## 2. Where we go further than Odoo

| | Odoo 19 | Kosh after this RFC |
| --- | --- | --- |
| Price lists | Rules by product, category, quantity, dates; formula | The same, plus **"why this price"** on every line (the rule, the list, the break), like replenishment explains itself; lists per company, partner, Shop and Counter |
| Credit limit | Warn, or block (Enterprise-grade setup) | Warn or block per customer and company default, open orders and unpaid invoices counted, and **an approval to go over** through the Approvals engine instead of a dead end |
| Partial invoicing | Down payments, delivered quantities | The same, plus **purchase bills by received quantity** with the three-way check shown on the bill, and the invoice plan on the order |
| Deals | Quotations from opportunities | The same, plus the deal won on confirmation and **lost when every quotation is cancelled**, with the reason asked |
| Templates | Templates, optional products (Enterprise for some) | Templates with sections, notes and optional lines; the customer adds optional lines in the **portal before signing**, priced by the server |

## 3. Design

### 3.1 Price lists (`product`, with `sales`, `website_sale`, `pos`)

- `product.pricelist`: name, currency, company (empty: every company), active, `sequence`; `rules`.
- `product.pricelist.rule`: applies to a product, a category (and its children) or everything; `minQuantity`;
  `dateFrom` / `dateTo`; `compute`: `fixed` (a price), `discount` (a % off the base), `formula` (base × (1 − %) +
  surcharge, rounded to a step, within a min / max margin). The base is the list price, the cost, or **another
  price list** (no cycles: checked when saved).
- The most specific rule wins: product over category over all, then the highest minimum quantity met, then the
  rule's sequence.
- `priceFor(pricelist, product, quantity, date, uom)` in `@kosh/product` is pure and shared, so Sales, the Shop and
  Counter price the same way on the server. It returns `{ price, rule, explanation }`.
- `res.partner.pricelist` (empty: the company's default list); `sale.order.pricelist` defaults from the customer.
  Lines take `priceUnit` from it on product or quantity change, and show **why** (`priceReason`). A manual price
  stays manual, and is marked as such.
- The Shop prices carts by the visitor's list (signed-in customers) or the Shop's; Counter by the shop's list or the
  sale's customer.
- Who may change prices: `sales.price_override` (a permission). Without it, a line's price and discount are
  read-only, enforced by the server.

### 3.2 Credit control, payment terms and addresses (`contacts`, `sales`, `sale_account`)

- `res.partner.creditLimit` (money, empty: the company default) and `res.company.creditLimitDefault`,
  `creditControl`: `off | warn | block | approval`.
- At confirmation, exposure = unpaid posted invoices + confirmed orders not invoiced + this order. Over the limit:
  - `warn` shows it;
  - `block` refuses;
  - `approval` asks for an approval through the Approvals engine (a shipped policy: an Accounting manager).
  The order waits in `to_approve` and is confirmed on approval.
- `sale.order.paymentTerm` (defaults from the customer, then the company), passed to the invoice. `partnerInvoice`
  and `partnerShipping` (the customer's contacts) on the order, carried to the invoice and the delivery.

### 3.3 Invoicing by what was delivered (`sale_account`, `purchase_account`, with the stock bridges)

- `product.invoicePolicy`: `ordered | delivered`, used for sales and purchases.
- Lines: `qtyInvoiced` (computed from posted and draft invoice lines linked to the line) and `qtyToInvoice` (ordered
  or delivered, minus invoiced).
- **Create invoice** makes an invoice of what is to invoice now, so several invoices per order are possible, and
  marks the order `invoiced` when nothing is left. The same runs in batch from the order list.
- **Down payments**: a % or a fixed amount as an invoice line on a "down payment" product (an account from the
  company's settings). The final invoice deducts it as a negative line, and the order shows the invoice plan.
- **Purchase**: bills by received quantity (`purchase_stock_account`), with **the three-way check** on the bill
  (ordered / received / billed per line, differences flagged before posting).

### 3.4 Deals to quotations (`sale_crm`, a bridge of `crm` and `sales`)

- `sale.order.deal`; on the deal, **New quotation** (customer, salesperson, team and source carried over), its
  quotations as stat tiles, and the amount of confirmed orders.
- When a quotation is confirmed, its deal moves to its won stage (`emitting('sale.order.confirmed')` through the
  outbox). When every quotation of a deal is cancelled, the deal is marked lost and asks for the reason.

### 3.5 Quotation templates and optional lines (`sales`, `sale_portal`)

- `sale.order.template`: name, validity days, terms, lines (product, description, quantity, sections and notes) and
  optional lines. Choosing a template fills an empty quotation.
- `sale.order.line.optional` (or `optional: true` lines kept out of the totals). In the portal, the customer adds an
  optional line before signing; the server prices it and adds it, once, audited.

## 4. Steps

1. Price lists: models, `priceFor` with its explanation, on partners and orders, the price-override permission,
   Shop and Counter pricing.
2. Credit control (warn, block, approval), payment terms, and invoice and delivery addresses on orders.
3. Invoicing by delivered and received quantity: to-invoice per line, several invoices per order, down payments,
   batch invoicing, the three-way check on bills.
4. `sale_crm`: deals to quotations, won on confirmation, lost when all are cancelled.
5. Quotation templates and optional lines in the portal.

Each step: real-PostgreSQL tests (permission tests for price overrides and credit approvals), English and Bangla,
the module standard (`pnpm check:modules`), the business apps' E2E, demo data and docs.

## 5. Not in this RFC

Product variants and attributes (the next RFC: they change product, lines and stock), loyalty and gift cards (one
engine for Sales, the Shop and Counter, after price lists), fiscal positions and follow-ups (with the accounting
RFC: bank statements and reconciliation rules).

## 6. Notes

- **Step 1 (2026-11-07).** `product.pricelist` and `product.pricelist.rule`, `priceFor` (read as the caller: product
  users read lists, so it runs in reads), `res.partner.pricelist` (Sales), `sale.order.pricelist` from the customer
  by onchange, its currency followed. `sale.order.line.priceUnit` is a stored compute with an inverse: the price typed
  in (`manualPrice`, written by the inverse, refused without `sales.price_override`), else the list's, else the list
  price; `priceReason` says why. A migration keeps existing lines' prices as typed in. Creating a line with a price
  needed Shutro to run inverses on create too (request #36, Shutro 0.3.6). The Shop prices carts by the customer's
  list; Counter's shop has a list (the catalogue and lines without a price), and a customer's own list when Sales is
  installed. Not yet: the Shop's product pages at the customer's prices, an order-level "Update prices", the
  discount under the same permission.
- **Step 2 (2026-11-07).** In `sale_account` (the exposure needs invoices): `res.company.creditControl`
  (`off | warn | block | approval`) and `creditLimitDefault` in an app settings section, `res.partner.creditLimit` and
  `customerPaymentTerm`; Sales' `confirm` calls `confirming()` (a hook like Purchase's `submitting()`), which the
  bridge overrides with the check (as the system). Approval mode adds the `credit` state with `askCredit`,
  `creditApprove` (guarded by the approvals, emitting `sale.order.confirmed` like `confirm`) and `creditReject`, and a
  shipped *Credit approvals* policy (Accounting managers, on `creditHeld`). `partnerInvoice` and `partnerShipping` on
  orders; the invoice takes the invoice address and the payment terms. Not yet: the delivery address on Stockroom's
  delivery (sale_stock), amounts in other currencies than the company's in the exposure.
- **Step 3 part 1 (2026-11-07), Sales.** `product.invoicePolicy`; `account.move.line.saleLine` and
  `sale.order.line.qtyInvoiced` (stored, credit notes less, cancelled not counted); `toInvoice()` reads Stockroom's
  `qtyDelivered` when installed (an untyped read: `sale_account` does not depend on `sale_stock`). `invoice` invoices
  what is due and is refused with nothing due; `invoiceState` follows the quantities. Down payments are invoice lines
  marked `downPaymentOf` the order (not order lines: they must not change the order's total), invoiced by the
  `invoiceDownPayment` transition from two fields on the order — a transition, since form buttons run transitions —
  and deducted by the next invoice. Batch invoicing is the lists' bulk transitions. A migration links existing invoice
  lines to their order lines. Not yet: taxes on down payments, credit notes from orders; Purchase (bills by received
  quantity, the three-way check) is part 2.
- **Step 3 part 2 (2026-11-07), Purchase.** The same in `purchase_account`: `account.move.line.purchaseLine`,
  `purchase.order.line.qtyBilled`, `toBill()` (Stockroom's `qtyReceived` read when installed), the `bill` transition
  billing what is due, `billState` by quantities, a migration linking existing bill lines. The three-way check is
  `matchNote` on bill lines (a non-stored compute: ordered, received, billed, flagged beyond received or ordered),
  a column of the invoice form; it warns, it does not block posting. Step 3 complete.
- **Open (2026-11-07).** The Trade Finance overview E2E sometimes renders "Something went wrong!" (the error
  boundary) under parallel load since step 3: it failed in three full runs and passed alone, serially and paired in
  later runs; the cards read `trade.lc` only and no console error was caught in the passing runs. To investigate.
- **Step 4 (2026-11-07).** `@kosh/sale_crm` (a bridge of Sales and Pipeline): `sale.order.deal`,
  `crm.deal.quotations`, tiles on the deal. A deal has no state, so "New quotation" needed a new kind of form button:
  `open` (a new record of another model, filled from `$record` values, through the existing prefill) — the API still
  exposes transitions only; and `append: 'header'` in view extensions (the deal form has no buttons to insert beside).
  Sales emits `sale.order.cancelled`; the bridge's subscribers win the deal on confirmation (the first winning stage)
  and lose it when every quotation is cancelled, with its own lost reason (Pipeline requires one).
- **Step 5 part 1 (2026-11-07).** `sale.order.template` and its lines (optional ones), `sale.order.template` on the
  order with the `fill` transition (lines, options, validity, terms), `sale.order.option` with `offered | added` and
  `add` (a line, once, while the quotation is open). Options are their own model, not lines kept out of the totals:
  nothing that reads lines (taxes, invoicing, deliveries) needs to know about them. Transition names: Shutro wants
  snake_case names and camelCase methods, so only one-word names pass on a model's own state field (`fill`) —
  to raise with Shutro. Part 2: the customer adds options in the portal before signing.
- **Step 5 part 2 (2026-11-07).** Portal documents declare `options` (the one2many, its fields, `offered` on the
  items, `when` on the document, the item's `add` transition), checked at start; the document's page returns the items
  on offer and whether it takes them; `POST …/options/:option/add` checks the document is the user's (as the user)
  and both domains, runs the transition as the system, posts on the thread and audits (`portal.option`), with an
  idempotency key like the actions. `sale_portal` offers a sent quotation's options; the portal app shows them with
  **Add**. RFC 0028 complete.
