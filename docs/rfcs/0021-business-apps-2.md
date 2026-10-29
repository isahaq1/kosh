# RFC 0021: Business apps, part 2 — eleven apps, named for what they do

- **Status:** Proposed (2026-10-29)
- **Depends on:** 0001 (manifest), 0003 (permissions), 0004 (views), 0006 (messaging, activities), 0008 (business
  apps, App manager), 0009 (accounting), 0015 (portal), 0017 (integrations), 0020 (app settings)
- **Asked for (2026-10-29):** "add inventory, manufacturing, calendar, employees, letter of credit, website,
  recruitment, maintenance, event, to do, CRM … with smart names which do not match Odoo's … more standard, more
  flexible, more professional than Odoo apps".

## 1. Summary

Eleven apps, each a module in `modules/` built only on Shutro and Kosh's public APIs, with bridges where two apps
meet (`sale_stock`, `purchase_stock`…), so each can be installed alone. Names say what the app does and avoid
Odoo's: **Stockroom**, **Production**, **Agenda**, **Workforce**, **Trade Finance**, **Sites**, **Hiring**,
**Asset Care**, **Event Hub**, **Focus**, **Pipeline**. Every app: access levels, its settings in Settings › App
settings (RFC 0020), list / kanban / form / pivot / calendar views where they fit, chatter and activities, demo
data, the portal where customers or candidates take part, English and Bangla, E2E tests.

## 2. The apps

Technical names (`stock`, `mrp`…) stay plain for developers; users see the app names.

| App | Module | Replaces (Odoo) | Better than Odoo because |
| --- | --- | --- | --- |
| **Stockroom** | `stock` | Inventory | Moves and quantities in Shutro `Decimal` with units converted exactly; one *Transfer* document for receipts, deliveries and internal moves with a clear state chip; reservations explained ("2 reserved for SO/2026/00042"); lots and serials optional per product; valuation (FIFO / average) posted to Accounting through a bridge; cycle counts from a phone. |
| **Production** | `mrp` | Manufacturing | Bills of materials with versions and effective dates; a production order that shows what is short before it starts; work centres with capacity on a Gantt; by-products and scrap recorded with reasons; cost roll-up (materials + labour + overhead) visible before confirming. |
| **Agenda** | `calendar` | Calendar | One calendar for meetings, activities, leave, events and production slots, from every app; free/busy across people and rooms; time zones shown per attendee; invitations by email with replies routed back (RFC 0006 inbound); recurring events with exceptions. |
| **Workforce** | `hr` | Employees | Employees separate from users (an employee may never sign in); departments and reporting lines as a hierarchy view; contracts with history; documents with expiry reminders; leave balances and requests with approvals (RFC 0003); attendance from the web or a kiosk. Personal data under field security by default. |
| **Trade Finance** | `trade_finance` | — (no Odoo app) | Import and export letters of credit: application, issuance, amendments, document presentation and discrepancies, acceptance, settlement; margin and bank charges posted to Accounting; LC limits per bank; expiry and shipment-date alerts; linked to purchase and sales orders. Built with Bangladesh's banking practice in mind (UCP 600 terms). |
| **Sites** | `website` | Website | Pages built from blocks with a live preview, published per company, multilingual; forms that create records in any app (a lead, an application); product pages from Products; a public site served by the Next.js site later (CLAUDE.md) — this app is the content and its API, not a page builder that locks the design. |
| **Hiring** | `recruitment` | Recruitment | Openings per department, a pipeline of applicants on a kanban, interview scheduling through Agenda, scorecards per interviewer, offers that become Workforce employees in one step; candidates apply and follow through the portal. |
| **Asset Care** | `maintenance` | Maintenance | Equipment with location, warranty and meters; preventive plans by time or meter reading; work orders with checklists, parts drawn from Stockroom and labour time; downtime and MTBF / MTTR reports. |
| **Event Hub** | `event` | Events | Events with sessions, tickets and seats, registrations from Sites or the portal, attendee check-in by QR from a phone, badges as PDF, follow-up emails; revenue to Accounting. |
| **Focus** | `todo` | To-Do | Personal tasks and checklists for everyone (no app access needed), linked to any record, with due dates, priorities and a *Today* list on the home page; shared lists for small teams. |
| **Pipeline** | `crm` | CRM | Leads and opportunities on a kanban with weighted forecast; stage rules (required fields, approvals) from Settings; activities and emails in the chatter; duplicate detection on contacts; won deals become quotations in Sales through a bridge; lead sources and conversion reports. |

## 3. Shared principles

- **Installed alone, joined by bridges**: Stockroom does not need Sales; `sale_stock` adds deliveries to sales
  orders when both are installed (as `sale_account` does today). Same for `purchase_stock`, `stock_account`,
  `mrp_account`, `hr_calendar`, `crm_sale`, `website_crm`, `recruitment_hr`, `maintenance_stock`, `event_account`.
- **Everything permission-based** (CLAUDE.md): each app declares its access levels (user / manager, and more where
  needed); record rules for own / team / company; personal and salary data under field security.
- **Settings in Settings › App settings** (RFC 0020): each app's options (default warehouse, reservation policy,
  leave year start, LC tolerance…) declared once.
- **Money in `Decimal`**, quantities in `Decimal` with exact unit conversion; dates with time zones.
- **No ORM work in Kosh**: anything Shutro lacks (for example unit conversion helpers or valuation layers, if they
  belong in the ORM) is written down in `docs/shutro-requests.md` and asked first.

## 4. Delivery plan (each app its own steps, reviewed)

Order by what others need:

1. **Focus** (small, everyone benefits) and **Agenda** (Hiring, Event Hub and Pipeline schedule through it).
2. **Pipeline** (+ `crm_sale`).
3. **Workforce**, then **Hiring** (+ `recruitment_hr`).
4. **Stockroom** (+ `sale_stock`, `purchase_stock`, `stock_account`).
5. **Production** (+ `mrp_account`), then **Asset Care** (+ `maintenance_stock`).
6. **Trade Finance** (+ its Accounting and Purchase / Sales links).
7. **Event Hub** (+ `event_account`), then **Sites** (+ `website_crm`).

Each app starts with a short design note (its models, screens and tests) appended to this RFC, built in two or three
reviewed steps.

## 5. Open questions

1. **Names**: Stockroom, Production, Agenda, Workforce, Trade Finance, Sites, Hiring, Asset Care, Event Hub, Focus,
   Pipeline — accepted, or others?
2. **Order** (§4): Focus and Agenda first, or another app first (Stockroom is the largest and most asked for in
   ERP)?
3. **Sites**: content, forms and API now, with the public rendering in the Next.js site later (proposed), or a full
   page builder served by Shutro ERP itself?

## Alignment with CLAUDE.md

- Modular monolith with strict boundaries: one module per app, bridges for the joins.
- Metadata-driven: models, views, menus, permissions and settings declared once per app.
- Secure by default: default-deny access levels, record rules and field security per app; server-side checks.
- Money is Shutro `Decimal`; all UI text through i18n (English, Bangla); light and dark; desktop and mobile.
