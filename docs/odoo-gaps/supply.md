# Supply chain gap analysis: Odoo 19 Community vs Kosh

Scope: purchase, inventory (Stockroom), manufacturing (Production), maintenance (Asset Care), products.
Odoo addons read: purchase, purchase_stock, purchase_requisition(+_sale/_stock), purchase_mrp, purchase_repair,
purchase_product_matrix, purchase_edi_ubl_bis3, stock, stock_account, stock_landed_costs, stock_dropshipping,
stock_picking_batch, stock_delivery, stock_fleet, stock_maintenance, stock_sms, production, production_account, mrp_subcontracting*,
mrp_repair, mrp_product_expiry, mrp_landed_costs, maintenance, repair, product, product_expiry, product_margin,
product_matrix, uom, barcodes, barcodes_gs1_nomenclature, delivery.
Kosh modules read: purchase, purchase_account, purchase_portal, purchase_stock, purchase_stock_account, stock,
stock_account, sale_stock, production, production_account, maintenance, maintenance_stock, product, approvals_purchase (plus
website_sale for carriers, account_budget, trade_finance_purchase for context).

## 1. Kosh already ahead

- **Exact units everywhere**: every line converts through Shutro `Quantity` (no float rounding drift); stock can
  never go below zero; reservations name what they are for (`stock.reservation.label`).
- **Replenishment explained**: reorder rules (`stock.reorder`) carry a forecast with an `explanation` in words,
  snooze, auto/manual, methods buy / make / transfer / dropship, a Replenishment screen with refresh / order / snooze
  routes. Odoo shows numbers only.
- **Multi-level purchase approvals** on the shared Approvals engine (quorum, delegation, deadlines, email decisions)
  instead of Odoo's single "double validation" amount; `approvals_purchase` turns approved requests into RFQs.
- **Budget control of purchasing** (`account_budget`): committed amounts from POs not yet billed, warn / block lines.
  Odoo Community has no budget commitments.
- **Trade finance** linked to purchase (LCs from POs, shipments against LCs) — nothing in Odoo.
- **Valuation that ties out**: average or FIFO with layers, each transfer posted at once, Inventory account equals
  stock value; receipts at PO price, GRNI clearing and price differences (`purchase_stock_account`).
- **Production costing before start**: `production.order` shows shortages and a cost roll-up before it starts; BOM
  versions with effective dates (`validFrom`/`validTo`) — in Odoo that needs Enterprise PLM; by-products with a
  cost share; WIP posting cleared to the cent.
- **Asset Care deeper than Odoo maintenance**: meters and readings with meter-based plans, checklists per plan and
  per request, downtime, labour hours and cost, spare parts reserved and consumed through Stockroom, a reliability
  API (failures, MTTR, MTBF, availability) over any period.
- **Counts from a phone by barcode scan** (`POST /stockroom/counts/:id/scan`) with expected quantities, applied by
  managers through adjustment transfers; first-expiry-first-out lots by default.
- **Checked module standard**: every document has print and import templates, chatter, named events, Bangla.

## 2. Gaps

| Odoo capability | Odoo addon | Kosh status | Value | Size |
|---|---|---|---|---|
| Product variants and attributes (size/colour matrix, per-variant price extra, exclusions, archived combos) | product, product_matrix, purchase_product_matrix | **missing** — `product.product` is a flat model, no template/attribute models | high | L |
| Vendor price lists (`product.supplierinfo`: vendor, vendor code/name, min qty, price breaks, validity, lead time, preferred vendor) | product, purchase | **missing** — PO line price defaults to `standardPrice`; reorder rule has a single `vendor` | high | M |
| Customer price lists (rules by product/category, qty breaks, formulas, dates) | product | **missing** in product (sales package description mentions price lists, no model found) | high | M |
| Returns of transfers (customer return, return to vendor, linked to the origin, refund/credit) | stock (`stock_picking_return`), stock_account, purchase_stock | **missing** for Stockroom — only POS sessions net negative quantities; no return wizard / `returnOf` | high | M |
| Landed costs (freight, duty, insurance split by qty/weight/volume/value onto receipts, revaluing layers) | stock_landed_costs, mrp_landed_costs | **missing** — no landed cost model; key for importers (and pairs with Trade Finance) | high | M |
| Purchase agreements: blanket orders and calls for tender / alternative RFQs with a comparison screen | purchase_requisition(+_stock/_sale) | **missing** | high | M |
| Bill control policy (bill on ordered vs received qty), "to bill" quantities, bill-to-PO matching | purchase, purchase_stock (`purchase_bill_line_match`, `bill_to_po_wizard`) | **partial** — `purchase_account` has bills and `billState`, GRNI clearing; no per-product control policy or line matching screen | high | S-M |
| Packages: put in pack, package types (dimensions, max weight), packages moved whole, package history | stock (`stock_package*`, `stock_put_in_pack`) | **missing** — Packing step location exists but no package model | medium | M |
| Batch and wave picking | stock_picking_batch | **missing** | medium | M |
| Lot / serial numbers on finished goods, component lots consumed, upstream/downstream traceability report | mrp (`mrp_production_serial_numbers`, stock_traceability) | **partial** — lots in Stockroom with per-lot history; `production` has no lot/serial handling for output or consumption, no traceability tree | high | M |
| Unbuild orders (disassembly back into components) | mrp (`mrp_unbuild`) | **missing** | low | S |
| Kits / phantom BOMs exploded on sale and purchase | production | **missing** — BOM has no type | medium | S-M |
| Subcontracting (BOM type subcontract, components sent to the subcontractor, resupply, receipt of the finished good, subcontractor portal) | mrp_subcontracting(+_purchase/_account/_dropshipping) | **missing** | medium | L |
| Work order execution: start/pause/block, time logs per operator, productivity losses, alternative work centres, OEE, work-centre efficiency / setup / cleanup time, capacity per product | mrp (`mrp_workcenter`, `mrp_workorder`) | **partial** — work orders scheduled forward, Gantt, capacity by day, started/finished times; no pause/block, losses, OEE, alternatives, setup times | medium | M |
| Operation instructions (PDF/text per operation), BOM attachments | production | **missing** (Documents app exists but not linked to operations) | low | S |
| Partial production with MO backorders, split / merge MOs, change quantity to produce | mrp (`mrp_production_backorder`, `mrp_production_split`, `change_production_qty`) | **missing** in `production` (Stockroom backorders exist for transfers) | medium | S-M |
| Consumption control (strict / warning / flexible) and actual vs expected component usage | mrp (`mrp_consumption_warning`) | **partial** — consumption transfer and scrap; no tolerance policy or variance view | medium | S |
| Purchase–manufacturing link (MO raw-material needs creating RFQs, PO showing the MO source; MTO chain) | purchase_mrp | **partial** — reorder rules buy/make and make-to-order routes; no cross-document source links shown | low | S |
| Repair orders (diagnosis, parts added/removed, under warranty, quotation to customer, invoice, return of the repaired product) | repair, mrp_repair, purchase_repair, sale (repair) | **missing** — Asset Care covers own equipment only, not customer repairs | high | M |
| Maintenance teams with members, kanban stages, technician per request, request from email alias, equipment assigned to employee/department, instructions | maintenance | **partial** — `responsible` and `assignedTo` exist; no teams, no email alias intake, no employee/department assignment | medium | S |
| Equipment linked to stock locations / lots, maintenance from work centres (machine breakdown blocks the work centre) | stock_maintenance, mrp_maintenance (Ent.) | **missing** — equipment has a free `location`, no link to `stock.lot` or `production.workcenter` | medium | S |
| Lot expiry dates beyond one date: best-before, removal and alert dates, expiry alerts, blocking expired lots on delivery | product_expiry, mrp_product_expiry | **partial** — `stock.lot.expiryDate` and FEFO; no removal/alert dates, no blocking or alert job | medium | S |
| Removal strategies per location/category (FIFO / LIFO / closest / least packages) and storage categories with capacity | stock (`product_strategy`, `stock_storage_category`) | **partial** — FEFO only; putaway rules without capacity limits | low | S-M |
| Stock at a past date / inventory valuation at date, forecasted stock report per product (incoming/outgoing timeline) | stock (`stock_quantity_history`, forecast report), stock_account | **partial** — reorder forecast only; no "as of date" stock or per-product forecast timeline | medium | S-M |
| Product labels and lot labels (PDF / ZPL), barcode nomenclatures, GS1-128 parsing (lot, expiry, weight in one scan) | stock (`product_label_layout`, `stock_lot_label_layout`), barcodes, barcodes_gs1_nomenclature | **missing** — products have `barcode`; counts scan plain codes; no label printing or GS1 parsing | high | S-M |
| Barcode-driven receiving / picking / packing on mobile (Ent. "Barcode", but Community has the scan model hooks) | stock (`barcode`) | **partial** — only counts are scanned | high | M |
| Product packaging units (box of 12, pallet) on purchase and sale lines | product (packaging via uom in v19) | **missing** | medium | S |
| Product weight, volume, dimensions, HS code, origin country | product, stock_delivery | **missing** on `product.product` (UoM categories exist) | medium | S |
| Combo products and product tags, product documents | product (`product_combo`, `product_tag`, `product_document`) | **missing** (tags exist in contacts, not products) | low | S |
| Vendor statistics: on-time delivery rate, receipt reminders to vendors, PO suggestions from sales history | purchase, purchase_stock (`on_time_rate`, `receipt_reminder_email`, `action_purchase_order_suggest`) | **missing** | medium | S |
| Vendor acknowledgement / delivery date update from the portal | purchase (portal `action_acknowledge`) | **partial** — vendors see RFQs/POs with a thread; cannot acknowledge, confirm dates or upload a bill | medium | S |
| Product margin analysis (per product: sold, bought, margins over a period) | product_margin | **partial** — margins on sale lines/orders (RFC 0022); no per-product period analysis | low | S |
| Delivery carriers on transfers: rate on the delivery, weight-based price rules, tracking ref, packages per carrier | stock_delivery, delivery | **partial** — couriers with adapters, shipments and fees by zone/weight exist in `website_sale` for Shop orders only, not for back-office sale orders or Stockroom deliveries | medium | M |
| Dispatch management: transport batches with vehicles, docks, capacity | stock_fleet | **missing** | low | M |
| Inter-company / multi-step resupply between warehouses with a transit route | stock (resupply warehouses) | **partial** — reorder method `transfer` with `sourceWarehouse`, `transit` location usage; no two-leg transit route | low | S |
| E-documents for purchase (UBL BIS3 order export) | purchase_edi_ubl_bis3 | **missing** (low outside EU) | low | S |
| Low-stock / transfer SMS to customers | stock_sms | **missing** for transfers (notify package has SMS) | low | S |

## 3. Recommended next steps (top 8 by value)

1. **Vendor price lists and vendor scorecards** — add `product.vendor.price` (vendor, vendor code, min qty, price
   breaks, currency, validity, lead days, preferred) used by PO lines, reorder rules and replenishment to pick the
   cheapest-in-time vendor and explain the choice in words; add on-time rate, average lead time and price trend per
   vendor on the contact as stat tiles. Surpasses Odoo by explaining the vendor choice and scoring vendors live.
2. **Returns** — a Return action on done receipts/deliveries producing a linked return transfer (partial, by lot),
   valued at the original layer cost, with an optional credit note / vendor refund through the bridges and a
   "returned" quantity on sale and purchase lines; reasons required and reported (Odoo has no return reasons).
3. **Landed costs** — `stock.landed.cost` from vendor bills or Trade Finance charges (freight, duty, insurance, LC
   charges), split by quantity, weight, volume or value onto receipt layers, posted once, with the Bangladesh
   customs case (AIT/AT/CD) as data in `l10n_bd`. Tied to Trade Finance this goes well past Odoo.
4. **Product variants** — templates with attributes and values, per-variant price extra, barcode and cost, exclusions,
   and a grid entry on sale/purchase lines; keep `product.product` as the variant so all existing modules keep
   working. Largest piece; required for apparel, garments and retail customers.
5. **Purchase agreements and RFQ comparison** — blanket orders (agreed price and quantity, released over time,
   consumed quantities) and calls for tender (one requisition, several vendor RFQs, a comparison grid by line with
   best price / best date, award per line), letting vendors quote in the portal — Odoo vendors cannot quote online.
6. **Repair orders** — customer-device repairs: intake by serial, diagnosis, parts added/removed through Stockroom,
   warranty check from the lot's sale date, quotation approval by the customer in the portal, invoice, and the
   repaired product returned; reuse Asset Care checklists and Helpdesk tickets as a source.
7. **Traceable manufacturing** — lot/serial on finished goods (generate serials), consumed component lots recorded,
   an upstream/downstream traceability tree from any lot (recall in one click: which customers got affected lots),
   plus partial production with backorders and a consumption tolerance with variance report.
8. **Barcode operations and labels** — product/lot/package labels (PDF and ZPL), GS1-128 parsing (GTIN, lot,
   expiry, weight), and phone-first scan flows for receiving, picking, packing and moving, extending the existing
   count scanner; with packages and batch/wave picking as the follow-up. Odoo keeps the Barcode app in Enterprise,
   so a Community-equivalent scan flow is a clear win.

Also worth a small step soon: bill control policy with PO-to-bill line matching (S-M), maintenance teams and
equipment linked to work centres and lots (S), lot removal/alert dates with blocking (S), product weight/volume/HS
code and packaging units (S).
