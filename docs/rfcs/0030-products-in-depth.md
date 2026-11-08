# RFC 0030 — Products in depth: vendor prices, returns, landed costs, variants

- Status: Proposed (2026-11-08)
- Builds on: RFC 0008 (Products, Purchase), RFC 0021 (Stockroom, its valuation and Trade Finance), RFC 0024
  (replenishment, the Shop), RFC 0028 (price lists, billing by received quantity)
- Source: [docs/odoo-gaps/supply.md](../odoo-gaps/supply.md) §3 items 1–4, the cross-cutting gap #2 of
  [docs/odoo-gaps/README.md](../odoo-gaps/README.md)

## 1. Why

Products are the weakest part of Kosh next to Odoo:

- **No vendor prices.** A purchase line starts from the product's cost; a reorder rule has one vendor. Buyers keep
  vendor codes, price breaks and lead times in spreadsheets, and replenishment cannot choose between vendors.
- **No returns.** A customer return or a return to a vendor is a new transfer typed by hand, linked to nothing: the
  stock value, the order's delivered quantity and the credit note do not follow.
- **No landed costs.** Freight, customs duty, insurance and LC charges never reach the stock value; an importer's
  margins are wrong. Trade Finance already knows these charges.
- **No variants.** `product.product` is flat: a shirt in 4 sizes and 3 colours is 12 unrelated products, entered
  line by line. Apparel, garments and retail — the main market for the Bangladesh Shop — cannot use Kosh.

## 2. Where we go further than Odoo

| | Odoo 19 | Kosh after this RFC |
| --- | --- | --- |
| Vendor prices | Vendor, code, min qty, price, dates, lead time; the first that fits wins | The same, and **the choice explained in words** on the line and in Replenishment ("cheapest that arrives in time: 3 days, 480.00 at 100+"); **vendor scorecards** live on the contact (on-time rate, average lead time, price trend) |
| Returns | Return wizard, linked return picking; no reasons | Linked partial returns by lot, valued at the original cost, a **required reason** reported by product and partner, the **credit note or vendor refund proposed** through the bridges, "returned" quantities on order lines |
| Landed costs | Split by quantity, weight, volume, cost onto receipts (Enterprise) | The same in Community, created **from a vendor bill line or a Trade Finance charge**, Bangladesh customs (CD, RD, SD, AIT, AT) as data in `l10n_bd`, the split **previewed** before posting, posted once |
| Variants | Templates, attributes, values, extra prices, exclusions, grid entry (matrix) | The same, with `product.product` kept as the sellable unit so **every existing app keeps working unchanged**, per-variant barcode, cost and picture, a grid on sales and purchase lines, option choosers on the Shop |

## 3. Design

### 3.1 Vendor prices (`product`, used by `purchase` and `stock`)

- `product.vendor.price`: product (or category, for a whole family), vendor, vendor code and name, currency,
  minimum quantity, price, valid from / to, lead days, preferred flag, company.
- `vendorPriceFor(env, product, qty, date, vendor?)` returns the price with a sentence saying why (like
  `priceFor` of RFC 0028): the preferred vendor if one fits, else the cheapest price that fits the quantity and date.
- Purchase lines take their price, vendor code and expected date from it (the typed price kept, as on sales lines).
- Reorder rules and Replenishment (RFC 0024) choose the vendor with the same function, the cheapest that arrives
  before the need date, and say so.
- Scorecards: on-time rate (receipts done by the expected date), average lead days, last and average price, computed
  from receipts and bills, shown as stat tiles on the vendor (RFC 0022 `k.stats`).

### 3.2 Returns (`stock`, with `sale_stock`, `purchase_stock`, `stock_account`)

- **Return** on a done delivery or receipt: the lines with what can still be returned (done minus returned), by lot
  or serial; a reason (`stock.return.reason`, data with defaults: damaged, wrong item, not as ordered, surplus).
- The return transfer is linked (`returnOf`), goes back to the source location (or a chosen one, e.g. a damaged
  stock location), and is valued at the original move's cost (`stock_account`).
- Order lines get **returned quantities** (`sale_stock`, `purchase_stock`); invoicing by delivered or received
  quantity (RFC 0028) then proposes the credit note or vendor refund for what came back.
- A report of returns by reason, product and partner.

### 3.3 Landed costs (`stock_account`, with `purchase_stock_account`, `trade_finance_account`)

- `stock.landed.cost`: date, receipts (transfers), cost lines (product of kind service marked "landed cost",
  amount, split method: quantity, weight, volume, value or equal), state `draft | posted`.
- Created by hand, from a vendor bill line of a landed-cost product (the bill's amount carried), or from a Trade
  Finance shipment's charges.
- **Preview** of the split per receipt line before posting; posting adds the amounts to the receipts' valuation
  layers (still on hand: to stock value; already gone: to cost of goods sold) and posts one entry. Posted once,
  reversible by a reversing landed cost.
- `l10n_bd`: customs duty, regulatory duty, supplementary duty, AIT and AT as landed-cost products with their
  accounts (AIT and AT to receivable tax accounts, not stock).

### 3.4 Variants (`product`, then `sale`, `purchase`, `website_sale`, `pos`)

- `product.attribute` (name, display: list, radio, colour swatch, size), `product.attribute.value` (name, colour,
  sequence, extra price).
- `product.template`: the family — name, category, kind, taxes, units, description, picture; its attribute lines
  (attribute and the values offered) and exclusions (value combinations that do not exist).
- `product.product` stays the sellable, stockable unit; a variant has `template` and `attributeValues`, its own
  code, barcode, cost, picture and active flag; its sales price is the template's plus the values' extras (overridable
  per variant). Products without a template work exactly as today.
- Generating variants creates the missing combinations, archives removed ones (never deletes a used variant).
- **Grid entry** on sales and purchase order lines: pick a template, fill quantities in a size × colour grid, one line
  per variant. The Shop shows option choosers and the variant's price, picture and stock; Counter picks the variant.

## 4. Steps

1. Vendor prices: the model, `vendorPriceFor`, purchase lines, reorder rules and Replenishment, scorecards.
2. Returns: reasons, the Return action, valuation, returned quantities, credit notes proposed, the report.
3. Landed costs: the model, the split and its preview, posting, from bills and Trade Finance, `l10n_bd` customs.
4. Variants part 1: attributes, values, templates, generation and exclusions, prices, variant fields.
5. Variants part 2: the grid on sales and purchase lines, the Shop's choosers, Counter, variant stock in reports.

Each step: real-PostgreSQL tests with permission tests (only buyers set vendor prices, only stock users return,
only accountants post landed costs), English and Bangla, the module standard, E2E for the user-facing flows, docs.

## 5. Not in this RFC

Purchase agreements and calls for tender, repair orders, traceable manufacturing (finished-goods lots), packaging
and units per vendor, product configurator rules beyond exclusions, Shop attribute filters and feeds.
