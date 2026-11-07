# Point of sale: Odoo 19 Community vs Kosh Counter

Sources: Odoo `addons/point_of_sale` and its 42 `pos_*` addons (manifests, `models/*.py`, `static/src/app`). Kosh: `modules/pos`, `modules/pos_stock` and `modules/l10n_bd_pos` (module.ts, index.ts, routes.ts, web/Register.tsx), plus the Counter notes in RFC 0021 (steps 1 to 4 part 1).

Kosh Counter today has 6 models (shop, payment method, session, order, line, payment) and 7 routes. The register is one page with product tiles, search and a barcode box, a single cart, split payments, refunding the last sale and an offline queue. Each closed session posts one journal entry, and `pos_stock` makes one delivery per session. In Kosh there is no `pos_account` module: the booking code is in `pos/src/accounting.ts`.

## 1. Kosh already ahead

- **The server keeps offline sales from being booked twice.** The SQL rule `unique(session, clientId)` means a sale replayed from the device's queue is accepted only once. Odoo relies on its client-side sync logic for this.
- **Cash differences need a written reason.** The `explainedDifference` constraint refuses to close a session with a difference and no reason. Odoo only has an optional "maximum difference" setting.
- **Cashiers are limited by record rules.** A cashier sees only their own sessions and sales, and the server enforces it. Odoo mostly restricts access in the client.
- **Refunds are controlled.** A reason is required, you cannot refund more than was sold, and refunds are linked to the original sale. Refunding outside your own session needs the `pos.refund_any` permission. The books net refunds within the session.
- **Mushak 6.3 receipts at the till (`l10n_bd_pos`).** The receipt shows the seller's BIN, the buyer's BIN, the VAT on each line and the amount in words, in English and Bangla. Odoo has no Bangladesh POS localization.
- **A localization can change the receipt.** `pos.shop.receiptTemplate()` can be overridden by any module. Receipts are documents from the document engine with a QR code, and they go out by email and SMS from the core module. Odoo needs `pos_sms` for text receipts.
- **Built-in audit and events.** Sessions and orders are tracked, the named events `pos.order.paid` and `pos.session.closed` exist, and outbound webhooks and automation rules work on them with no extra addon.
- **An overview with KPIs and month-on-month comparison, in Bangla.** This is on the same platform as the other apps.

## 2. Gaps

| Odoo capability | Odoo addon | Kosh status | Business value | Rough size |
|---|---|---|---|---|
| Card terminals (Adyen, Stripe, Viva.com, Razorpay, Pine Labs, Mercado Pago, Mollie, QFPay, DPO Pay, Safaricom M-Pesa); payment confirmed by the terminal, auto-validate | pos_adyen, pos_stripe, pos_viva_com, pos_razorpay, pos_pine_labs, pos_mercado_pago, pos_mollie, pos_qfpay, pos_dpopay, pos_safaricom (+ pos_restaurant_adyen/stripe tips) | missing (a payment's `reference` is typed by hand) | high | L |
| Cash machines (automatic cash in and change out) | pos_cashdro, pos_glory_cash, pos_cashmatic | missing | low | M |
| Online or QR payment at the counter: the customer scans and pays on their phone, and the sale completes when the provider confirms | pos_online_payment | missing (the payment providers for bKash, SSLCommerz, Razorpay and Stripe exist, but only as redirect flows for the portal; the RFC lists this as the next step) | high | M |
| Loyalty programmes: points, rewards, eWallet | pos_loyalty (+ loyalty) | missing | high | L |
| Coupons, promo codes, buy X get Y, next-order coupons | pos_loyalty | missing at the counter (`shop.coupon` exists only for the web Shop) | high | M |
| Gift cards sold and redeemed at the till | pos_loyalty | missing | medium | M |
| Pricelists: per customer, quantity breaks, dated, switched on the register | point_of_sale (`use_pricelist`) | missing in Kosh as a whole (no pricelist model) | high | M |
| Order-level discount, discount product, managers-only price changes (`restrict_price_control`) | pos_discount, point_of_sale | partial (discount % per line only, with no restriction on changes) | high | S |
| Invoice from a POS sale (Invoice button, customer required, invoice paid by the sale's payments) | point_of_sale | missing (planned in the RFC design note, not built; `invoice` appears nowhere in pos/src) | high | M |
| Customer picker and quick customer creation on the register | point_of_sale (partner_list screen) | partial (the API accepts `partner`; the register has no picker) | high | S |
| Ticket screen: search past orders, reprint, partial refund of any order, filter by state | point_of_sale (ticket_screen) | partial (the API can refund any order and choose lines; the UI refunds only the last sale in full) | medium | S |
| Several open orders at once (order tabs, park and resume) | point_of_sale (order_tabs) | missing (a single cart) | medium | S |
| Cash in and out during a session, counting by denomination | point_of_sale (cash_move_popup, money_details_popup, pos.bill) | missing | medium | S |
| Cash rounding (only on cash payments as an option) | point_of_sale (account_cash_rounding) | missing | medium | S |
| Several employees on one till with PIN or badge login, rights per employee, a sales report per employee | pos_hr, pos_hr_restaurant | missing (session = one `res.users` cashier) | high | M |
| Restaurant floors and tables (plan editor, seats, merging and transferring tables) | pos_restaurant | missing | high | L |
| Bill printing before payment, splitting the bill (by line or guest), tips (also after payment) | pos_restaurant (iface_printbill, iface_splitbill, set_tip_after_payment), point_of_sale (iface_tipproduct) | missing | high | M |
| Kitchen order printing by category, courses fired in order, line and order notes | pos_restaurant (restaurant_order_course), point_of_sale (pos.printer, pos.note) | missing (only one free-text `note` on the order) | high | M |
| Presets: dine-in, takeaway and delivery with their own pricelist and tax position, time slots by calendar | point_of_sale (pos.preset) | missing | medium | M |
| Self-ordering by QR menu on the phone (read-only menu, order and pay at the table, pay after the meal or before) | pos_self_order, pos_online_payment_self_order, pos_self_order_* terminals | missing | high | L |
| Self-order kiosk (full screen, languages, home images) | pos_self_order (`self_ordering_mode = kiosk`) | missing | medium | M |
| Combos and menus, product configurator (attributes and variants), optional products | point_of_sale (product.combo, combo_configurator_popup, product_configurator_popup) | missing (no variants or attributes in Products) | high | L |
| Customer display (second screen showing the cart and total) | point_of_sale (customer_display) | missing | medium | S |
| Direct printing to ESC/POS or Epson ePOS printers on 80 mm paper, cash drawer, auto-print and skipping the preview | point_of_sale (epos_templates, iface_print_auto, iface_cashdrawer), pos_imin | partial (an A4 document printed through the browser; 80 mm waits on the document engine's paper sizes) | high | M |
| Electronic scale read on the register (scale screen) | point_of_sale (iface_electronic_scale, scale_screen) | partial (typed decimal quantity only; no device integration) | medium | M |
| Lot and serial number choice at the till; ship later; picking policy | point_of_sale (select_lot_popup, ship_later, picking_policy) | missing (Stockroom has lots, but `pos_stock` ignores them) | medium | M |
| Fiscal positions and tax regime selection on the register | point_of_sale (account_fiscal_position, tax_regime_selection) | missing | medium | S |
| Restrict the categories shown per shop, group by category, category images, product info popup (stock and margin) | point_of_sale (limit_categories, iface_group_by_categ, product_info_popup) | partial (tiles and search only, with no categories in the register UI) | medium | S |
| Load and settle quotations and sales orders at the till, down payments, a POS sales team | pos_sale, pos_sale_loyalty, pos_self_order_sale | missing | medium | M |
| Margins and costs on POS orders and lines | pos_sale_margin, point_of_sale (is_margins_costs_accessible_to_every_user) | missing (margins exist only in Sales) | medium | S |
| Selling event tickets at the counter (slots, registration questions, badges) | pos_event, pos_event_sale | missing (Event Hub exists, with no bridge) | medium | M |
| Kits from a bill of materials expanded into stock moves on sale | pos_mrp | missing | low | S |
| Paying for repairs at the till | pos_repair | missing (Kosh has no Repair app) | low | M |
| UBL 2.1 export of POS orders | pos_edi_ubl | missing | low | S |
| Python-coded custom taxes in the POS | pos_account_tax_python | missing (n/a: Kosh taxes are data) | low | S |
| Tracking edits to orders, fast payment buttons on the product screen | point_of_sale (order_edit_tracking, use_fast_payment) | partial (audit tracks only state and total; no fast-pay buttons) | low | S |
| Sales details (Z report) by product, category, tax and payment method; closing entries by product | point_of_sale (report_sale_details, is_closing_entry_by_product) | partial (a session report document and the overview; no Z report by payment, tax and category) | medium | S |

## 3. Recommended next steps (top 8 by value)

1. **Card and QR payments at the counter.** Add a "push to device / QR" flow to the RFC 0017 payment adapters: bKash/Nagad QR first, then a card-terminal adapter interface for Stripe Terminal, Adyen and Razorpay POS. The sale should stay open, update live through the realtime gateway and be accepted once on the provider's callback. That would cover Odoo's 10 terminal addons with one adapter contract, plus the local wallets Odoo lacks.
2. **Restaurant (`pos_restaurant`).** Build floors and tables with a drag-and-drop plan (dnd-kit), table transfer and merge, the pre-bill, splitting by line or guest, and tips. Add courses fired to a kitchen display that updates in real time (Odoo Community has only kitchen printers), with kitchen tickets as documents filtered by category.
3. **Loyalty, coupons and gift cards as a shared engine.** Lift `shop.coupon` into a `loyalty` module of programmes, rules and rewards (points, buy X get Y, next-order coupons, gift cards, eWallet), checked on the server, and use it in Counter, the Shop and Sales. The rewards should post to accounts correctly.
4. **Pricelists and order-level discounts.** Kosh needs a `product.pricelist` platform model (per customer, quantity breaks, dates, currency) that Sales and the Shop also use. Add order-level discounts with a limit per role and an approval through the Approvals engine above the limit. Odoo only offers "restrict to managers".
5. **Invoices from the till and a customer picker.** Add a customer search and quick creation to the register. An "Invoice" toggle should post an invoice paid by the sale's payments, and in Bangladesh it should become a Mushak 6.3 for B2B buyers with their BIN. That session's entry then leaves those orders out.
6. **Several employees on one till (`pos_hr`).** Let employees log in by PIN or badge, reusing Attendance's kiosk PIN and badge, with rights per employee: refunds, discounts, price changes and the cash drawer. Each sale and cash move should record the employee, with a sales and difference report per employee.
7. **Self-order by QR and kiosk.** Build a public menu page per table QR, in English and Bangla, following the Sites public-API pattern. Orders go into the table's open order, payment can come before or after the meal through step 1's QR flow, and the kiosk mode reuses the same page.
8. **Hardware-grade printing and a better register.** Add 80 mm receipts with direct ESC/POS printing (WebUSB or a small local bridge), cash drawer kick, auto-print and a customer display on a second screen. On the register, add order tabs (park and resume), cash in and out with denomination counting, and the ticket screen (search, reprint, partial refunds). This closes most of Odoo's everyday-till advantages.

Also worth planning soon: combos and product variants (they need attributes in Products first), cash rounding, lots and serials at the till, and bridges to Event Hub and to Sales quotations.
