# RFC 0021: Business apps, part 2 — eleven apps, named for what they do

- **Status:** Accepted (2026-10-29)
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
| **Counter** | `pos` | Point of Sale | Sells at a shop counter from a browser or a tablet, offline-first (sales queue on the device and sync when back online, RFC 0010's offline queue); barcode and scale input; several payment methods per sale including bKash / cards through the payment providers (RFC 0017); cash sessions with opening and closing counts and differences explained; receipts printed or sent by SMS / email; stock from Stockroom, revenue and VAT (Mushak 6.3 where it applies) to Accounting in one entry per session. |

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
8. **Counter** (+ `pos_account`), after Stockroom: it sells from stock.

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

## Decisions (2026-10-29)

1. **Names** accepted: Stockroom, Production, Agenda, Workforce, Trade Finance, Sites, Hiring, Asset Care, Event Hub,
   Focus, Pipeline.
2. **Order**: Focus and Agenda first, then as §4.
3. **Sites**: content, forms and an API; the public rendering in the Next.js site later.
4. **Point of Sale** added the same day as **Counter** (`pos`), after Stockroom.

## Implementation notes (2026-10-29): Focus, step 1

- **Module** `modules/todo` (`@kosh/todo`), app **Focus** (code `focus`). Access level *User* (`todo.user`): the
  RFC's "for everyone, no app access needed" became an access level like every app's, as CLAUDE.md asks; give it
  to everyone through a role.
- **Models**: `todo.list` (owner, members, colour), `todo.task` (title, list, *For*, due date, priority normal /
  high / urgent, state *To do* → *Done* with *Done* / *Reopen*, notes, a checklist with its progress in percent, an
  optional link to any record by model and id), `todo.item` (a checklist step). Record rules: one's own to-dos,
  and those of lists one owns or is a member of — through Shutro's dotted paths (`'list.members'`); nobody
  else's, administrators aside.
- **Screens**: To-dos as a board by list, a list, a calendar of due dates and a form with the checklist and the
  chatter; Lists with sharing. The home page lists the open to-dos due today or before among *Needs your
  attention*, with *Open* and *Done*.
- **Wiring**: the installer offers Focus (not in the default set), the npm package bundles it, the demo
  installation has it (a shared list, three to-dos), the business apps' E2E server installs it.
- **Tests**: on real PostgreSQL — privacy (own, shared list's owner and members, others refused, people without
  Focus refused), the checklist's progress, Done / Reopen, the demo data. E2E (apps): a to-do due today, listed, on
  the home page, done from there.
- **Next for Focus**: *Add to Focus* from any record's chatter (the record link), repeating to-dos, and a "Due
  today" filter (Shutro domains have no relative date today; the search layer would compute it).

## Design note: Agenda (`modules/calendar`, app code `agenda`)

- **Models**: `calendar.event` (title, start, end, all day, location, video link, description, organizer, privacy
  *public* / *private*, state *confirmed* / *cancelled*, a room, an optional link to any record), `calendar.attendee`
  (a person of the company or a contact from outside, with their answer: *needs action*, *accepted*, *tentative*,
  *declined*), `calendar.room` (name, capacity, location, active).
- **Further than Odoo**: rooms are booked with the event and **a room cannot be double-booked** (checked by the
  server across everyone's events, private ones included); **free / busy** for several people and rooms at once,
  private events shown only as *busy*; answering is one click for the attendee (`respond`) and the organizer sees
  the answers on the event; the end follows the start by the default length set in App settings.
- **Privacy**: public events are seen by every Agenda user; private ones by their organizer and attendees only.
  Rooms are managed by Agenda managers.
- **Step 1**: the models, rules and the room check; calendar (week) / list / form views; respond and free / busy
  routes; the default length setting; demo data. **Step 2**: repeating events with exceptions, email invitations
  with replies routed back (RFC 0006 inbound), each attendee's time zone, and other apps' dates (activities, leave,
  production) on the same calendar.

## Implementation notes (2026-10-29): Agenda, step 1

- **Module** `modules/calendar` (`@kosh/calendar`, export `calendarApp`), app **Agenda** (code `agenda`); access
  levels *User* (own and public events) and *Manager* (every event, rooms).
- **Models** as designed: events (privacy, state *Confirmed* / *Cancelled* with *Cancel* / *Restore*), attendees
  (a person or a contact, with their answer), rooms. An event ends after it starts (database check); **a room is
  never double-booked** — the check reads every confirmed event as the system, private ones included, so nobody
  books over a meeting they cannot see; a cancelled event frees its room.
- **Rules**: public events for every Agenda user; private ones for their organizer and attendees; only the
  organizer changes or deletes an event; an attendee changes their own answer only; managers see everything.
- **Routes**: `POST /api/v1/agenda/events/:id/respond` (accepted / tentative / declined, as the user);
  `GET /api/v1/agenda/busy?users=&rooms=&from=&to=` (at most two months; busy blocks per person — organizer or
  attendee who has not declined — and per room; titles only of the events the caller may see).
- **Setting** (RFC 0020): *Default length (minutes)* for the whole installation, changed by Agenda managers; the
  form's end follows the start by it.
- **Screens**: Calendar (week, by organizer), list and form with attendees and the chatter; Rooms; the home page
  shows *Today's meetings* (confirmed events today that one organizes or is invited to).
- **Fixed on the way**: the REST onchange route passed datetimes as strings, which Shutro refuses — every form with
  a datetime field (this one's start) failed its onchange; it now converts them as create and update do. Tests of
  the business apps navigated away right after *Save* and could cancel the save under load (a new record's title
  shows before it is saved); they now wait for the record's address or the server's answer (Projects' long-standing
  flakiness).
- **Tests**: on real PostgreSQL — privacy, organizer-only changes, answers, the room check against a private event
  and after a cancellation, free / busy with private events as busy only, the default length through App settings,
  the demo data. E2E (apps): a room booked for a meeting today with the end filled in, the same slot refused, the
  meeting on the home page.
- **Step 2**: repeating events with exceptions, email invitations with replies routed back, each attendee's time
  zone, a free / busy picker in the form, other apps' dates on the same calendar.

