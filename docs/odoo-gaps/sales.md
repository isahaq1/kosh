# Gap analysis: Sales, CRM, marketing, website and eCommerce (Odoo 19 Community vs Kosh)

Scope read: Kosh `modules/{sales,sale_account,sale_portal,sale_project,sale_stock,crm,website,website_crm,website_sale,website_sale_stock,contacts,product,portal}` (models, manifests, routes), RFC 0008/0015/0021/0024; Odoo `sale*`, `crm*`, `sales_team`, `website*`, `delivery`, `loyalty`, `sale_loyalty`, `mass_mailing*`, `marketing_card`, `survey`, `utm`, `link_tracker`, `social_media`, `im_livechat`, `rating`, `product_margin`, `product_matrix` (manifests, model files, `action_*` and `_cron_*` methods).

Each "missing" was checked with a grep over `modules/*/src` and `packages/*/src` (pricelist, variant/attribute, quotation template, optional product, down payment, packaging, team, commission, loyalty/gift card, wishlist, blog, forum, livechat, mailing/campaign, utm, link tracker, survey, scoring, fiscal position, credit limit, invoice/shipping address, incoterm, commitment date, invoice policy, timesheet on sale_project). None of them were found unless the table says so.

## 1. Kosh already ahead

- **Bangladesh-first commerce**: courier adapters with shipments drafted once per order, tracking events, cash on delivery collected and recorded, a COD limit per shop, zone fees (inside Dhaka / outside). Odoo has nothing like this for local couriers.
- **Local online payments**: SSLCommerz, bKash, Razorpay and Stripe, with a shop order confirmed, invoiced and paid **exactly once** from the provider's callback.
- **Stage rules in Pipeline**: a stage can require fields before a deal enters it, checked by the server. Odoo stages only have a free-text "requirements" tip. A lost reason can be required by an App setting.
- **Margins out of the box**: `margin` and `marginPercent` on order lines and orders without an extra module. Odoo needs `sale_margin`.
- **Headless Sites/Shop public API**: rate limited and cached, prices always calculated by the server, carts by token, a sitemap, search titles in English and Bangla. Pages and products are translatable.
- **Portal acceptance**: customers accept with a signature or decline with a reason, and announcements and the thread come through the generic portal-document framework (one declaration).
- **Platform pieces Odoo Community lacks**: the automation builder (rules on any field, webhooks, schedules), the AI assistant (fill a quotation from a pasted PDF or image, summaries, draft replies), app overview dashboards with KPIs, stat tiles, next-step guidance, data import with undo, and Studio-built fields without forking.
- **Event emission**: `sale.order.confirmed` through the outbox, so bridges (sale_project, sale_stock) act exactly once.
- **Coupons with guardrails**: once per customer, use limits, minimums, validity dates and free delivery. Abandoned-cart reminders are sent once, with a recovery code.
- **Bangla/Mushak**: VAT documents, amounts in words and lakh/crore grouping on sales documents.

## 2. Gaps

| Odoo capability | Odoo addon | Kosh status | Value | Size |
|---|---|---|---|---|
| Price lists: per customer, currency, quantity breaks, dates, formula (cost + margin, % off list), price list on the order and the shop | product (pricelist), sale, website_sale | **Missing**: promised in RFC 0008 ("price lists") but not built. Price comes only from `listPrice` plus a manual line discount | high | M |
| Product variants and attributes (size/colour, extra price per value, variant-specific code/barcode/stock), product configurator on the order and shop | product, sale, website_sale, sale_product_matrix, product_matrix | **Missing**: listed as "Not yet" in RFC 0024. `product.product` is flat | high | L |
| Quotation templates with default lines, validity, terms and **optional products** (upsell) the customer can add in the portal | sale_management | **Missing**: only company default validity/terms | high | M |
| Down payments / partial invoicing (% or fixed), invoicing by **delivered quantity** vs ordered, `qty_invoiced` / to-invoice per line, batch "Create invoices" for many orders | sale (sale_make_invoice_advance) | **Partial**: `sale_account` creates one invoice from all lines. `sale_stock` tracks `qtyDelivered` but invoicing ignores it. No down payment, no per-line invoiced qty | high | M |
| Invoice and delivery addresses on the order (child contacts of type invoice/delivery), payment terms on the order and customer | sale, account | **Partial**: payment terms exist in Accounting but not on `sale.order`/`res.partner` for sales. No address types | high | S |
| Sales teams: team leader, members, team pipeline, invoicing target, team dashboards | sales_team, crm, sale | **Missing** (no `team` concept in sales/crm) | high | M |
| Lead to opportunity to **quotation**: "New quotation" from a deal, quotations and their amounts on the deal, deal won on confirmation | sale_crm | **Missing**: `crm.deal` is not referenced by Sales | high | S |
| Lead/opportunity split: leads stage, convert or merge wizard, mass convert | crm | **Partial**: deals only, duplicates found on demand. No merge, no lead stage/convert | medium | M |
| Lead assignment rules: teams with domains and capacity, round robin, cron auto-assign | crm (`_cron_assign_leads`) | **Missing** for Pipeline (Helpdesk has assignment in turn or by load, so it can be reused) | high | M |
| Predictive lead scoring (automated probability from historical frequencies by field values) | crm (crm_lead_scoring_frequency, `_cron_update_automated_probabilities`) | **Missing**: probability comes from the stage or is set by hand | medium | M |
| Recurring revenue on deals (MRR, plans), prorated revenue | crm (crm_recurring_plan) | **Missing** | medium | S |
| Leads from inbound email aliases (email to deal with the sender as the contact) | crm (mail alias) | **Missing** for Pipeline (`@kosh/mail` inbound exists and Helpdesk uses it) | high | S |
| Deal tags, colour, meetings from the deal (calendar link, next meeting shown), activities in kanban | crm, calendar | **Partial**: chatter activities exist. No deal tags, no Agenda link | medium | S |
| Lead enrichment / lead mining / website visitor reveal (IAP) | crm_iap_enrich, crm_iap_mine, website_crm_iap_reveal | **Missing**: paid-service plumbing, could be done with the AI assistant | low | M |
| Partner assignment / resellers (geo-assign leads to partners, partner grades), customer references page | website_crm_partner_assign, website_customer, website_partner | **Missing** | low | M |
| **Email marketing**: mailing lists, contacts and subscriptions, double opt-in, blacklist/opt-out, email designer, A/B testing, scheduling, traces (sent/opened/clicked/replied/bounced), revenue and leads per mailing | mass_mailing, mass_mailing_crm, mass_mailing_sale, website_mass_mailing | **Missing**: notify sends transactional mail only. No campaigns, lists or unsubscribe | high | L |
| SMS marketing and SMS from orders/deals | mass_mailing_sms, sale_sms, crm_sms, website_sms | **Partial**: Twilio SMS/WhatsApp adapters for notifications. No bulk SMS campaigns or "send SMS" on a record | medium | M |
| UTM campaigns / sources / mediums on deals, orders and visitors; short links with click tracking | utm, link_tracker, website_links | **Missing**: deal `source` is a fixed selection. No campaigns, no tracked links | medium | S |
| Marketing cards (dynamic shareable images per contact) | marketing_card | **Missing** | low | M |
| Surveys / quizzes: question types, scoring, certification, live sessions, survey links to leads/applicants | survey, website_slides_survey | **Missing** (only a ticket rating link in Helpdesk) | medium | M |
| Live chat on the website, chatbot scripts, operator routing, chat to lead/ticket, ratings | im_livechat, website_livechat, crm_livechat, website_crm_livechat | **Missing**: internal chat exists (RFC 0006), with no visitor widget | high | L |
| Ratings framework (customer rates a record, published ratings on portal/website) | rating, portal_rating | **Partial**: Helpdesk one-time rating link. No generic rating mixin, no product reviews | medium | S |
| Product reviews and ratings on the shop | website_sale (rating), portal_rating | **Missing** | medium | S |
| Loyalty programs: points, rewards, gift cards, eWallet, buy-X-get-Y, automatic promotions, next-order coupons, generated coupon batches, use in Sales, Shop and Counter | loyalty, sale_loyalty, website_sale_loyalty, sale_loyalty_delivery | **Partial**: `shop.coupon` (single code, % / amount / free delivery, shop only). No points, gift cards, wallet, BOGO, auto promotions or coupons on back-office orders/POS | high | L |
| Shop: wishlist, product comparison | website_sale_wishlist, website_sale_comparison | **Missing** | medium | S |
| Shop: public categories separate from internal ones, product tags/ribbons ("Sale", "New"), multiple images and videos per product, attribute filters, autocomplete, product feeds (Google Merchant) | website_sale, website_sale_autocomplete | **Partial**: internal categories, search, sort, related products, one image. No ribbons, gallery, attribute filters or feeds | medium | M |
| Shop: customer accounts (sign up at checkout, saved addresses, order history, re-order), B2B prices and tax display (incl./excl.), extra checkout steps/fields | website_sale, portal | **Partial**: guest carts by token, portal shows orders. No shop sign-up, address book or re-order | high | M |
| Click and collect (pick up in store/warehouse, pay on site) | website_sale_collect | **Missing** | medium | S |
| Delivery: price rules by weight/volume/price/quantity, zip-prefix and country restrictions, carrier integrations (Mondial Relay, etc.), delivery method chosen on back-office quotations | delivery, website_sale_mondialrelay | **Partial**: fixed, per-kg and inside/outside-city zones, free over an amount, BD couriers. No rule table, zip or country restriction, or back-office "Add shipping" | medium | S |
| Website builder: drag-and-drop snippets (beyond 5 block kinds), menus editor, themes, multi-website, redirects, SEO tools per page, cookie bar, website visitors and page-view tracking | website | **Partial**: sites, pages from 5 block kinds, translations, forms, menu flag. No visitor tracking, redirects or broad snippet library | medium | L |
| Blog | website_blog | **Missing** | medium | M |
| Forum / Q&A, eLearning courses (slides, quizzes, paid courses), mail groups | website_forum, website_slides, website_sale_slides, website_mail_group | **Missing** | low | L |
| Online event pages: public registration, paid tickets through the shop, tracks/agenda, booths and exhibitors | website_event, website_event_sale, website_event_track, website_event_booth* | **Partial**: Event Hub has sessions, tickets, waiting lists, check-in and invoicing, but no public registration page or online ticket sale | medium | M |
| Website job pages, project pages, portal timesheets | website_hr_recruitment, website_project, website_timesheet | **Missing** on Sites (Hiring has no public careers page) | low | S |
| Invoice services from timesheets (time and materials), timesheet margin, re-invoice expenses to the customer | sale_timesheet, sale_expense, sale_expense_margin | **Missing**: sale_project only creates tasks/projects | high | M |
| Sale to purchase (buy service from a vendor on confirmation), make-to-order manufacturing from sales | sale_purchase, sale_mrp | **Partial**: MTO through Stockroom rules exists (RFC 0024 step 6). No subcontracted service purchase | medium | S |
| Pay online from a quotation (prepayment %, require payment to confirm), payment links | sale (payment_link_wizard), sale_management | **Partial**: shop pay-now and portal invoice pay. No "require payment/prepayment" on portal quotations, no payment link wizard | high | S |
| Global discount wizard, fixed-amount discount, "Update prices" | sale (sale_order_discount, action_update_prices) | **Missing** | medium | S |
| Quotation PDF builder (headers/footers/product sheets assembled into the quote) | sale_pdf_quote_builder | **Partial**: print templates and a PDF designer exist, with no per-product datasheets | low | S |
| Customer credit limit warning/block on order confirmation | account / sale (partner credit limit) | **Missing** | high | S |
| Fiscal positions (tax mapping per customer/country) | account / sale | **Missing** (localizations exist, no mapping on orders) | medium | M |
| Commitment date / delivery date, customer lead time, incoterms on the order | sale, sale_stock | **Missing** | medium | S |
| Product packaging and selling in packages | product, sale | **Missing** | low | S |
| Mass cancel of orders, sales digest emails | sale (mass_cancel_orders), digest | **Partial**: bulk actions are generic. No digest of sales KPIs (scheduled reports exist) | low | S |
| Sales EDI (UBL order import/export), print-on-demand (Gelato) | sale_edi_ubl, sale_gelato | **Missing** | low | M |
| Social media links on the company/website | social_media | **Missing** (trivial) | low | S |
| Product margin report (by product, invoiced vs costs) | product_margin | **Partial**: margins on orders and overviews. No per-product invoiced-margin analysis | low | S |

## 3. Recommended next steps (top 8 by value)

1. **Price lists with rules (Sales, Shop, Counter)**: build `product.pricelist` with rules by product, category, quantity, date and currency, as a formula (fixed, % off another list, cost + margin with rounding). Put it on the customer and the order, explain the chosen price on each line ("from Wholesale: 10+ units, 8% off") and add a price simulator. The explanation and one engine shared by Sales, Shop and Counter would beat Odoo's opaque price lists.
2. **Product variants and a configurator**: add attributes and values (extra price, code suffix, barcode per variant), variant generation with exclusions, a grid entry on order lines (the matrix) and option choosers on shop pages, with variant stock in Stockroom. This unlocks apparel and retail, the main market for the BD Shop.
3. **Deal to quotation and Sales teams (`sale_crm` + teams)**: add "New quotation" from a deal, the deal's quotations as stat tiles, the deal won on confirmation, and teams with leaders, members, monthly targets and team forecasts. Add assignment rules (round robin or by load and capacity, reusing Helpdesk's engine) and email-alias intake into Pipeline.
4. **Quotation templates, optional products and smarter invoicing**: templates with default lines, sections and notes, plus optional lines the customer adds in the portal. Add down payments (% or fixed, deducted on the final invoice), invoicing by ordered or delivered quantity with `qtyInvoiced` per line, batch invoicing, and "require online payment/prepayment to confirm" on portal acceptance.
5. **Loyalty, promotions and gift cards across channels**: generalise `shop.coupon` into programs (automatic promotions, buy-X-get-Y, points, gift cards, eWallet, next-order coupons, generated code batches) evaluated by one engine in Sales, Shop and Counter. Add an explanation of why each reward applied and a per-customer balance in the portal.
6. **Email (and SMS) marketing with UTM**: build mailing lists with double opt-in and one-click unsubscribe (RFC 8058), segments from the shared search layer, a block email designer, A/B tests, scheduled sends through the outbox and jobs, and traces with opens, clicks, bounces, revenue and deals attributed. Add UTM campaign, source and medium on deals, orders and site forms, plus tracked short links. Bulk SMS/WhatsApp can reuse the `Messenger` adapters.
7. **Website live chat to deal/ticket**: add a visitor chat widget on Sites through the existing realtime gateway and chat models, with operator routing by load, canned replies, a simple chatbot script, a transcript to a Pipeline deal or Helpdesk ticket in one click, and AI-drafted answers from the assistant.
8. **Time and materials plus credit control**: invoice services from approved timesheets and re-invoice Spend expenses at cost or sales price (`sale_timesheet`/`sale_expense` equivalents, with project margin). Add a customer credit limit with a warning or block at confirmation, approved through the Approvals engine, which improves on Odoo's warning-only behaviour.

Also quick wins (S): invoice/delivery addresses and payment terms on orders, a global discount wizard, deal tags and an Agenda link, product reviews on the generic ratings, wishlist, click and collect, and a delivery price-rule table.
