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

## Design note: Pipeline (`modules/crm`, app code `pipeline`)

- **Models**: `crm.stage` (name, order, probability, *won*, folded, **required fields** to enter it),
  `crm.lost.reason`, `crm.deal` (title, customer or prospect company and contact details, salesperson, stage,
  expected revenue and close date, probability from the stage, weighted revenue, source, priority, *lost* with its
  reason, status *open* / *won* / *lost* computed from the stage and *lost*).
- **Further than Odoo**: **stage rules** — a stage names the fields a deal must have to enter it (a proposal needs
  its revenue and close date), enforced by the server with the missing fields named; **won by stage, lost with a
  reason** (required unless switched off in App settings), reopened in one step; **duplicates** of a deal — other
  deals and contacts with the same email, phone or company — on demand; the **weighted forecast** by salesperson
  and month in a pivot.
- **Rules**: salespeople see their own deals and unassigned ones; managers see all.
- **Step 1**: the models, rules, stage rules and the lost-reason check, the board / list / form / pivot views, lose
  and reopen, duplicates, the default stages and lost reasons, the setting, demo data. **Step 2**: the `crm_sale`
  bridge (a won deal's quotation in Sales, the deal linked to it), activities and email from the deal, lead
  capture from Sites' forms.

## Implementation notes (2026-10-30): Pipeline, step 1

- **Module** `modules/crm` (`@kosh/crm`, export `crm`), app **Pipeline** (code `pipeline`); access levels
  *Salesperson* (own and unassigned deals) and *Manager* (every deal, stages, lost reasons).
- **Models** as designed. Expected and weighted revenue are Shutro decimals (exact: 1 250 000 × 60 % = 750 000);
  the status (*open* / *won* / *lost*) is computed and stored from the stage and *lost*, so it filters and groups.
  The default board: New 10 %, Qualified 30 %, Proposal 60 % and Negotiation 80 % (both needing the expected
  revenue and close date), Won 100 %; four lost reasons. Priority is *normal* / *good* / *very good* /
  *excellent* (Shutro's selection keys start with a letter).
- **Stage rules**: a stage lists the fields it requires (`expectedRevenue closeDate`, from a fixed set of deal
  fields); the server refuses a deal in that stage without them. The check reads the stages itself (Shutro's
  constraints depend on the model's own fields only).
- **Lost**: *Lost* with a reason — required unless *A lost deal needs a reason* is switched off in App settings ›
  Pipeline; `POST …/lose` and `…/reopen`, or the form's *Lost* and *Lost because*.
- **Duplicates**: `GET /api/v1/pipeline/deals/:id/duplicates` — deals and contacts with the same email, the same
  last eight digits of the phone, or the same company name, as the user (only what they may read).
- **Screens**: Deals as a board by stage, a list with totals, the form with the chatter, a pivot; Forecast (weighted
  and expected revenue by salesperson and month); Stages and Lost reasons in Configuration.
- **Tests**: on real PostgreSQL — who sees which deals, the stage's probability (onchange), the weighted revenue,
  the stage rule refusing then accepting, won by stage, lost with and without a reason (the setting), reopened,
  duplicates by phone, email and company, the demo data. E2E (apps): a deal created, refused at Proposal until its
  details are there, lost only with a reason.
- **Step 2**: the `crm_sale` bridge (a won deal's quotation), *Lose* / *Reopen* buttons and a duplicates panel on
  the form, lead capture from Sites' forms and inbound email, activities due per deal on the board.

## Design note: Workforce (`modules/hr`, app code `workforce`)

- **Models**: `hr.department` (a tree, with its head), `hr.job` (positions), `hr.employee` (separate from users:
  an employee may never sign in; work contact details, department, position, manager; personal details — birthday,
  national id, address, emergency contact — under field security), `hr.contract` (dates, type, wage under field
  security, state *draft* → *running* → *ended* / *cancelled*), `hr.leave.type` (days per year, whether a balance
  applies), `hr.leave` (employee, type, from / to, working days, state *draft* → *submitted* → *approved* /
  *refused*).
- **Further than Odoo**: **working days by the company's week** — the weekend is a setting (Friday–Saturday in
  Bangladesh by default; Saturday–Sunday; Friday only) and a leave's days count only working days, checked by the
  server, not trusted from the form; **the balance is enforced** (a request beyond the year's days for that type is
  refused, the remaining days shown on the request); **no overlapping leave** for the same person; **decisions by
  the line manager** (or HR), never by the requester, through one checked route; personal data and wages hidden from
  everyone but HR managers by default; an **org chart** from the managers.
- **Access**: *Employee* (the directory's work details, their own leave and contract, their team's leave when they
  manage people) and *HR manager* (everything, personal data, contracts, leave types).
- **Step 1**: the models, rules, field security, the weekend setting, the leave checks and decision route, the
  directory / org chart / form views, leave requests with a calendar, demo data. **Step 2**: documents with expiry
  reminders, attendance, allocations per person, public holidays in the working-day count.

## Implementation notes (2026-10-30): Workforce, step 1

- **Module** `modules/hr` (`@kosh/hr`, export `hr`), app **Workforce** (code `workforce`); access levels
  *Employee* (the directory's work details, their own leave and contract, their team's leave) and *HR manager*
  (everything, personal data, contracts, leave types, the decision permission `hr.leave_decide`).
- **Field security**: birthday, national id, home address, emergency contact and the wage are visible to HR managers
  only; employees see each other's work details. A user is at most one employee (checked across archived ones).
- **Leave**: working days by the weekend of App settings › Workforce (*Friday and Saturday* by default; *Saturday
  and Sunday*; *Friday only*), counted by the server and refused when the form says otherwise or no working day is
  covered; no overlap with the same person's other leave; the year's days per type (Casual 10, Sick 14, Earned 20,
  Unpaid: no balance) for what is waiting and approved. **Never decided by the person asking**: *Approve* /
  *Refuse* need the permission and a guard refuses one's own request (HR managers included); the line manager decides
  through `POST /api/v1/workforce/leaves/:id/decide`, recorded in the audit log under their name.
  `GET /api/v1/workforce/balance` gives each type's allowed, taken, waiting and remaining days.
- **Screens**: Employees (list, org chart by manager, form with the chatter), Leave (list, calendar, form with
  Submit / Approve / Refuse / Back to draft), Contracts (Start / End / Cancel), Departments (with their tree),
  Positions, Leave types.
- **Fixed on the way**:
  - Forms applied every onchange answer, so an earlier answer arriving late undid what was typed since (the leave's
    *To* reset to its *From*); only the latest answer applies now.
  - Dates read from PostgreSQL are local midnights; the leave check reads their local date (`toISOString()` moved them
    a day back east of UTC).
  - The forms of Focus, Agenda and Workforce declared no workflow buttons (Done / Reopen, Cancel / Restore, Submit /
    Approve…); they do now, with the status bar.
- **Tests**: on real PostgreSQL — working days by the weekend, field security, one employee per user, the leave
  checks (days, a weekend only, overlap, balance), decisions by the manager and never by the requester (route and
  transition, HR managers included), the balance route, the weekend setting, contracts seen by their employee
  without the wage, the demo data (also in the Dhaka time zone). E2E (apps): HR adds an employee (national id hidden
  from them), the employee asks for a week's leave counted as five working days and submits it, HR approves it.
- **Step 2**: documents with expiry reminders, attendance, allocations per person, public holidays in the count,
  *Approve* / *Refuse* buttons for line managers (their route exists), the balance on the leave form.

## Design note: Hiring (`modules/recruitment`, app code `hiring`)

- **Models**: `hiring.opening` (a position to fill: the Workforce position and department, the hiring manager, the
  headcount, *open* / *closed*), `hiring.stage` (the board, one stage *hired*), `hiring.applicant` (contact details,
  the opening, the stage, source, expected salary under field security, *refused* with a reason, the average rating,
  the employee once hired), `hiring.scorecard` (an interviewer's score 1–5, recommendation and notes).
- **Further than Odoo**: **independent scorecards** — an interviewer sees only their own, so the first opinion does
  not steer the next; the applicant's average shows to everyone; **hire in one step** — the applicant becomes a
  Workforce employee (name, email, position, department) linked to the applicant, and the opening **closes by itself
  when its headcount is filled** (a hire beyond it is refused); **no duplicate applications** — one email per
  opening.
- **Access**: *Interviewer* (applicants and openings, their own scorecards) and *Hiring manager* (everything,
  salaries, hiring, stages).
- **Step 1**: the models, rules, field security, the checks, the hire route, the board / list / form views, demo
  data. **Step 2**: interviews booked through Agenda (a `recruitment_calendar` bridge), candidates applying through
  Sites and the portal, offer letters as documents, email to candidates from the chatter.

## Implementation notes (2026-10-30): Hiring, step 1

- **Module** `modules/recruitment` (`@kosh/recruitment`, export `recruitment`, web `@kosh/recruitment/web`), app
  **Hiring** (code `hiring`), depending on Workforce; access levels *Interviewer* and *Hiring manager*.
- **Hire**: `POST /api/v1/hiring/applicants/:id/hire` (hiring managers) makes the Workforce employee (name, work
  email and phone, the opening's position and department, joined today), links it, moves the applicant to the hired
  stage, and closes the opening when its headcount is reached; refused for a refused applicant, twice, on a closed
  opening, or beyond the headcount (also after a reopen). Recorded in the audit log. The employee link is set by this
  step only: a constraint refuses it outside the audited superuser scope, so nobody marks an applicant hired by hand.
  The applicant form shows a **Hire** button (with what will happen) to hiring managers.
- **Scorecards**: a record rule shows interviewers their own; hiring managers see all; the applicant's stored rating
  is the average to one decimal. Scores are 1 to 5 (a database check).
- **Other checks**: one application per email and opening (case-insensitive, checked across every application);
  a refusal says why; expected salaries are visible and writable by hiring managers only.
- **Screens**: Applicants (board by stage, list, form with scorecards and the chatter), Openings (Close / Reopen),
  Scorecards, Stages.
- **Tests**: on real PostgreSQL — duplicates, refusals, salary field security, own scorecards and the average, the
  hire step (not by hand, not by interviewers, the employee made, the opening closed, never twice or beyond), the demo.
  E2E (apps): Dina opens a position and adds an applicant, Rahim (interviewer) sees neither Hire nor the salary, Dina
  hires and the opening closes.


## Design note: Stockroom (`modules/stock`, app code `stockroom`)

- **Models**: `stock.warehouse` (name, short code, company, its locations), `stock.location` (a tree through
  Shutro's hierarchy — `childOf` finds what is inside a location — with a usage: *internal*, *vendor*, *customer*,
  *adjustment*, *transit*; the vendor, customer and adjustment locations are shared), `stock.quant` (what is in an
  internal location: on hand, reserved and available, in the product's unit; written only by validated transfers),
  `stock.picking` — the **Transfer**, one document for receipts, deliveries and internal moves — with its
  `stock.move` lines (product, quantity and unit), and `stock.reservation` (which quant is held for which line).
- **Units converted exactly**: a line may be in any unit of the product's unit category (a dozen of a product kept in
  units); Shutro's `Quantity` converts it exactly, and quants are kept in the product's unit.
- **One clear status**: *Draft*, *Waiting*, *Ready* (everything reserved), *Done*, *Cancelled* — one chip, where Odoo
  shows a state and a separate availability.
- **Reservations explained**: every reservation names its transfer and origin ("2 Units reserved for
  TR/2026/00042 (SO/2026/00017)"); a product shows on hand, reserved and available.
- **Never below zero**: a transfer out of an internal location is validated only when all of it is reserved, and
  reservations take only what is available, so quantities never go negative (Odoo allows negative stock by default).
- **Access**: *Stockroom user* (transfers, reading stock) and *Stockroom manager* (warehouses, locations, everything).
  Quantities change only through validated transfers, never by editing them.
- **Settings** (App settings › Stockroom): reserve when a transfer is confirmed (on by default).
- **Step 1**: the models, the default warehouse of every company (`WH`, `WH/Stock`), transfers with confirm, check
  availability, unreserve, validate and cancel, product quantities, the screens (transfers list / board / form,
  stock by location, warehouses, locations), demo data. **Step 2**: `sale_stock` (deliveries from confirmed orders) and
  `purchase_stock` (receipts), partial validation with backorders, counts from a phone, lots and serial numbers.
  **Step 3**: `stock_account` (valuation, FIFO / average, posted to Accounting).

## Implementation notes (2026-10-30): Stockroom, step 1

- **Module** `modules/stock` (`@kosh/stock`, export `stock`), app **Stockroom** (code `stockroom`), depending on
  Products, Contacts and Messaging; access levels *User* and *Manager*.
- **Main warehouse**: the `defaults` hook gives every company without one its `WH` warehouse and `WH/Stock`
  location — at install, at `kosh init`, and when Settings › Companies makes a company. The shared *Vendors*,
  *Customers* and *Inventory adjustment* locations come as data. Location names are built from four levels of
  stored names (Shutro refuses a computed field that depends on itself; deeper levels start with `…`).
- **Transfers**: *Confirm* (reserves when the setting is on; the lines are checked as a draft first), *Check
  availability*, *Unreserve*, *Validate* (refused with 409 unless everything leaving an internal location is
  reserved; it consumes the reservations, adds to the destination's quant and dates the transfer), *Cancel*
  (releases), *Back to draft*. Lines change only in a draft. Receipts, Deliveries and Transfers open new transfers
  of their kind with the locations filled in.
- **Reservations** take only what is available in the source location and the locations inside it (Shutro's
  `childOf`), oldest stock first; each one reads "24 Units reserved for TR/2026/00005 (SO/2026/00017)". Quants are
  read-only to every user and checked `quantity >= 0` in the database.
- **Products** show on hand, reserved and available (the product form and list, through view extensions).
- **Fixed on the way** (`@kosh/ui` forms): a new record opened from an action with defaults (Customer invoices and Vendor bills, Deliveries)
  was saved without them, so the server's own default applied; it is now created with them, and their onchanges
  run when the form opens (a new receipt's locations).
- **Tests**: on real PostgreSQL — the main warehouse and the location names, receipts in dozens and grams converted
  exactly, services and other unit categories refused, a delivery partly reserved and explained, validation refused
  until everything is reserved, stock found on a shelf inside the stock location, two deliveries competing and
  cancelling releasing, lines fixed once confirmed, quantities never edited by hand, access by role, the setting,
  the demo data. E2E (apps): a receipt validated, a delivery reserved, explained and validated, the stock on hand.
- **Step 2** as planned: `sale_stock`, `purchase_stock`, partial validation with backorders, counts from a phone,
  lots and serial numbers. **Step 3**: `stock_account`.

## Implementation notes (2026-10-30): Stockroom, step 2 part 1 — the Sales and Purchase bridges

- **`sale_stock`** and **`purchase_stock`** (proposed whenever Sales or Purchase meets Stockroom): confirming an
  order makes its transfer through the outbox — Sales' `sale.order.confirmed`, and Purchase's new
  `purchase.order.confirmed` (also offered to webhooks) — exactly once, after the confirmation committed. The
  delivery or receipt has a line per goods line in the line's own unit (services are not moved), comes from or goes
  to the company's main warehouse, carries the order as its source document, and is confirmed (a delivery reserves
  its stock). A receipt is expected on the order's arrival date.
- **Made in an audited superuser scope**: a salesperson or buyer without Stockroom rights still gets the transfer
  made for the warehouse; the order's company, not the user's current one, picks the warehouse.
- **On the orders**: each line's delivered / received quantity from validated transfers, the order's *Delivery* /
  *Receipt* status (nothing, to do, partly, done) on the form and the list; the transfer links back to its order.
- **Tests**: the bridge proposed, the transfer made once (a replayed event adds nothing), goods lines only, units
  kept (a dozen stays a dozen on the line, 12 in stock), partial availability, validation completing the order,
  users without Stockroom rights, an order of services only.

## Implementation notes (2026-10-30): Stockroom, step 2 part 2 — partial validation and backorders

- **Done quantities**: each line of a waiting transfer takes what was actually moved (*Done*, in the line's unit;
  empty means all of it). *Validate* moves what is done — refused when nothing is done, or when more is done out of
  stock than is reserved — and releases the rest of the reservations; the lines keep their quantity and record what
  was done.
- **Backorders**: lines done in part leave the rest to a new transfer, *Backorder of* the first, with the same type,
  contact, places, company, source document, date and note, confirmed at once (a delivery's backorder reserves again).
  What a backorder copies is the `backorderValues` method of transfers and lines; `sale_stock` and `purchase_stock`
  override it so a backorder stays with its order and its lines with their order lines (Shutro's method overrides,
  traceable in the registry, instead of copying fields by reflection).
- **The orders** count what was done: a sales order is *Partly delivered* after a partial delivery and *Delivered*
  when its backorder is; the same for receipts.
- **Fixed on the way** (`@kosh/ui` forms):
  - after a workflow button (Confirm, Validate…) the form showed the transition's answer, which has no lines: the
    lines disappeared until a reload (sales and purchase orders too); the record and its lines are fetched again;
  - saving an edited line sent all its columns, read-only ones and its id included (refused by the server); only the
    edited columns of a saved line are sent now, new lines send their writable columns.
- **Tests**: on real PostgreSQL — six of ten received with a ready backorder of four, the source document and places
  kept; a delivery done in part within what is reserved (more refused), its backorder reserved again; a negative or
  nothing-done validation refused; a sales order partly then fully delivered through its backorder, the order line
  kept. E2E (apps): six of ten beams received from the form, the backorder ready in Receipts.

## Implementation notes (2026-10-30): Stockroom, step 2 part 3 — counts from a phone

- **Counts** (`stock.count`, Stockroom › Counts): a location and the locations inside it. *Start counting* lists
  every product it holds (and those added by hand) with what is expected; counters fill in what they find, or scan.
- **Scanning**: `POST /api/v1/stockroom/counts/:id/scan` (`{ barcode, quantity? }`) adds one — or the quantity sent —
  to the product's line, making the line (with what is expected) for a product that was not listed; as the user, on
  a count that is counting. The count form has a scan box: a barcode scanner or the keyboard types into it and Enter
  adds; where the browser reads barcodes (`BarcodeDetector`, Chrome on Android), the phone's camera scans.
- **Apply** (managers only, the `stock.count_apply` permission): what was found is compared with what is on hand
  *now* (moves made while counting are not lost), in one validated *Inventory adjustment* transfer for the gains and
  one for the losses — quantities still change only through validated transfers. A loss held by other transfers'
  reservations is refused and the reservations are named ("8 Units reserved for TR/… (SO/2026/00099)"); products not
  counted stay as they are.
- **Tests**: on real PostgreSQL — the listing with what is expected, scans adding up, a product not listed, an
  unknown barcode, a negative quantity, scanning before the start, counters unable to apply, gains and losses as two
  validated adjustments, uncounted products untouched, a reserved loss refused with its reservation named and applied
  once released. E2E (apps): a count started, an unknown barcode reported, a line counted, applied, stock following.
- **Then** (step 2 part 4): lots and serial numbers.

## Implementation notes (2026-10-30): Stockroom, step 2 part 4 — lots and serial numbers (step 2 complete)

- **Tracking** per product: *Not tracked*, *By lot* (a batch, with an expiry date), *By serial number* (one unit
  each). Lots and serial numbers (`stock.lot`) belong to a product and a company; quants hold a lot (one stock line
  per product, location and lot).
- **In**: a receipt (or a count's gains) lists its lots in *Lots and serial numbers* — an existing lot, or the name
  of a new one, made at validation. Validation checks that the lots cover what is done, product by product ("Router:
  2 of 3 have a lot or serial number"), that a serial number is one unit, listed once and never already in stock.
- **Out**: reservations take the lots that **expire first** (then the oldest stock); a line may take one lot only
  (*Lot to take*). Validation records which lots left on the transfer, so each lot's page shows its stock by location
  and its **history** — every transfer that moved it, from the vendor's receipt to the customer's delivery. A
  reservation names its lot ("4 Units of L-OLD reserved for …").
- **Counts by lot**: a count lists each lot with what is expected; scanning a lot or serial number counts it (a
  phone's camera reads it); stock found needs its lot; a missing lot is taken out by its lot.
- **Tests**: on real PostgreSQL — serials missing, listed twice, received twice, then received; lots with expiry
  dates reserved first expiry first, the lots that left recorded, a lot's history, a line taking one lot; a count
  listing serial numbers, one scanned, a missing one taken out by its lot. E2E (apps): a product tracked by serial
  number received with two serials from the forms, listed in Lots and serial numbers.
- **Step 3** next: `stock_account` — the stock's value (FIFO / average) posted to Accounting.


## Design note: Stockroom step 3 — `stock_account` (decided 2026-10-30: perpetual, per product)

- **Bridge** `stock_account` (Stockroom ↔ Accounting), proposed when both are installed.
- **Cost method per product** (with a category default): *Average cost* (each receipt re-weighs the product's cost)
  or *FIFO* (deliveries take the cost of the oldest receipts still in stock). Not tracked by value: services.
- **Valuation layers** (`stock.valuation.layer`): one per product per validated transfer — quantity, unit cost and
  value (Shutro `Decimal`), and for FIFO what is left of each incoming layer. The stock's value at any date is the
  sum of the layers up to it; the valuation report reads them (by product, location and date).
- **Posted at once**, one entry per validated transfer in a *Stock* journal:
  - receipt: Dr *Inventory* (1200) / Cr *Goods received not billed* (a new interim account);
  - delivery: Dr *Cost of goods sold* (5000) / Cr *Inventory*;
  - count gain / loss: Dr *Inventory* / Cr *Stock adjustment* (gain), and the reverse (loss);
  - internal moves post nothing (the value stays).
  The accounts come from the product's category, else from the company's defaults (Settings › App settings ›
  Stockroom), and the chart gains the interim and adjustment accounts.
- **Vendor bills** for goods (with `purchase_account`) debit *Goods received not billed* instead of the expense
  account, so receipt and bill meet in the interim account; a price difference between the receipt's cost and the
  bill goes to a *Price difference* account. The receipt's cost is the purchase line's price when the receipt comes
  from an order (`purchase_stock`), else the product's cost.
- **Never edited after the fact**: entries are posted through Accounting's rules (lock dates, immutability); a
  correction is a new transfer.
- **Tests** (planned): average and FIFO on receipts at different prices, deliveries valued, entries balanced and
  posted, count adjustments valued, the bill clearing the interim account with a price difference, the stock value
  at a date equal to the Inventory account's balance.

## Implementation notes (2026-10-30): Stockroom, step 3 part 1 — `stock_account`

- **Module** `modules/stock_account` (`@kosh/stock_account`, export `stockAccount`), the Stockroom ↔ Accounting
  bridge; access level *Stock valuation (read)*; Stockroom › Valuation (pivot by product, list of layers).
- **Hook**: Stockroom's transfers have a `validated()` method, empty, called at the end of a validation in its
  superuser scope; the bridge overrides it (Shutro's method overrides) — Stockroom knows nothing of Accounting.
- **Cost**: per product, else its category, else average. Average re-weighs the product's cost on each receipt;
  FIFO takes the oldest incoming layers' remaining value, and the product's cost beyond them (stock from before the
  bridge). The incoming cost is the `incomingUnitCost` method of transfer lines — the product's cost here; the
  Purchase bridge (part 2) gives the order's price.
- **Entries**, posted at once in the *Stock* journal (`STJ`) with Accounting's posting rules: receipt Dr 1200
  Inventory / Cr 2150 Goods received not billed; delivery Dr 5000 Cost of goods sold / Cr Inventory; count gains and
  losses against 5100 Stock adjustments; internal moves nothing. The bridge adds 2150, 5100 and 5110 Price
  differences to the company's chart and points the company's defaults at them (on install, after a chart is
  installed, and before the first valuation); a category may name its own Inventory and Cost of goods sold accounts.
- **Valuation at a date**: `GET /api/v1/stockroom/valuation?date=` sums the layers by product; the tests check it
  equals the Inventory account's balance. Layers are read-only to everyone (written by validations only).
- **Tests**: the bridge proposed; receipts valued and posted; FIFO across two costs (10 × 100 + 5 × 130 delivered,
  5 × 130 left); average cost delivered; a count loss to Stock adjustments; internal moves unposted; the value
  equal to the Inventory balance; layers not editable, not readable by stock users.
- **Part 2**: `purchase_stock_account` — receipts at the purchase order's price, vendor bills for goods clearing
  Goods received not billed, the difference to Price differences.

## Implementation notes (2026-10-30): Stockroom, step 3 part 2 — `purchase_stock_account` (Stockroom complete)

- **Module** `modules/purchase_stock_account`, the bridge of Purchase, Stockroom and Accounting (proposed when the
  three apps are installed; it depends on `purchase_stock`, `stock_account` and `purchase_account`).
- **Receipts at the order's price**: it overrides the lines' `incomingUnitCost` — the purchase line's price per
  product unit (a dozen at 2,400 is 200 a unit), in the company's currency at the day's rate (without a rate, the
  product's cost).
- **Two extension points in Accounting**, both empty by default: `productLineAccounts()` (the account of a
  document's product lines that name none; the journal's default otherwise) and `posted()` (run after posting). The
  bridge points vendor bills' goods at *Goods received not billed* and, once a bill from an order is posted, posts
  the difference between what the bill says and the value received for the billed quantity to *Price
  differences* — the interim account is cleared.
- **Tests**: the bridge proposed; a receipt valued at the order's price (the average cost follows), a dozen's price
  per unit; the bill's goods on 2150; a price 5 higher on 10 units: 50 in 5110; 2150 back to zero; Inventory at the
  received value.
- **Stockroom is complete** (steps 1–3). Later: landed costs, valuation of returns, foreign-currency price
  differences at the bill's rate.


## Design note: Production (`modules/mrp`, app code `production`)

- **Bills of materials** (`mrp.bom`): the product made and how many one bill yields, its components
  (`mrp.bom.line`: product, quantity, unit) and its operations (`mrp.bom.operation`: work centre, minutes per
  yield). **Versions with effective dates**: a bill has a version and *valid from / until* dates; a production
  order takes the bill valid on its date (the latest that starts on or before it), so a new recipe can start on a
  given day without touching the running orders.
- **Work centres** (`mrp.workcenter`): hours available per day and a cost per hour (labour and overhead).
- **Production orders** (`mrp.production`, MO/2026/00001): product, quantity, bill, date, warehouse. Their
  component lines say what is **required, available and short — before the order starts** — and the order shows
  its **cost roll-up** (materials at cost, operations at their centres' rates, the total and the unit cost) while
  still a draft. One status: Draft, Waiting (short), Ready, Done, Cancelled.
- **Through Stockroom**: *Confirm* makes the consumption transfer (components from stock to the new *Production*
  location, reserved); *Produce* validates it and the output transfer (the finished product from Production into
  stock) — quantities change only through transfers, as everywhere. *Cancel* cancels them.
- **Stockroom gains** a *Production* location usage and transfer type; `stock_account` values them against a new
  *Work in progress* account (1250) instead of Cost of goods sold or Goods received not billed.
- **Access**: *Production user* (orders) and *Production manager* (bills, work centres, everything).
- **Step 2**: by-products and scrap with reasons, the work centres' Gantt with capacity, `mrp_account` (the finished
  product's cost from what was consumed and the operations, so Work in progress clears exactly).

## Implementation notes (2026-10-30): Production, step 1

- **Module** `modules/mrp` (`@kosh/mrp`, export `mrp`), app **Production** (code `production`), depending on
  Stockroom; access levels *User* (orders; Production users are Stockroom users) and *Manager* (bills, work centres).
- **Bills of materials** with components (in any unit of the component's category) and operations (work centre,
  minutes per yield), versions and *valid from / until* dates; an order takes the bill valid on its date (the latest
  started), proposed when the product or the date changes. Checks: a component is never the product itself, the
  bill belongs to the order's product, quantities are positive, a version ends after it starts.
- **Orders**: *Check components* lists what is required (in the product's unit), available in the warehouse and
  short, with the cost: materials at the components' cost and operations at their centres' rates, total and unit
  cost — all before anything starts. *Confirm* reserves the components in a *Production* transfer (stock → the new
  Production location); *Check availability* reserves what came in; *Produce* is refused while anything is short,
  then validates the components' transfer and the output transfer (Production → stock); *Cancel* releases.
- **Stockroom** gained the *Production* location and transfer type; `stock_account` posts them against 1250 *Work in
  progress* (components in, the product out), not Cost of goods sold or Goods received not billed.
- **Tests**: on real PostgreSQL — the version valid on a date; the needs, shortages and cost roll-up (650 of
  materials, 1,000 of operations, 330 a unit); confirmation reserving in part, production refused while short, then
  made with the stock following; cancelling releasing; the checks and access by role; the demo. `stock_account`:
  production in and out of Work in progress. E2E (apps): a bill made from the forms, an order with its bill chosen,
  its components checked with the cost, confirmed with its transfer.
- **Step 2**: by-products and scrap with reasons, the work centres' Gantt with capacity, `mrp_account` (the
  finished product valued at what it consumed plus its operations, so Work in progress clears exactly).

## Implementation notes (2026-10-30): Production, step 2 part 1 — `mrp_account`

- **Module** `modules/mrp_account`, the Production ↔ Accounting bridge (proposed when both are installed; it builds
  on `stock_account`).
- **The product made** enters stock at what its order consumed (the components' valuation layers) plus its
  operations (minutes at the work centres' rates), per unit: it overrides the lines' `incomingUnitCost` for the
  output transfer (Production links the order's output transfer before validating it, so the bridge finds the
  order). With average cost, the product's cost follows.
- **The operations** are posted into 1250 *Work in progress* against 5200 *Production labour and overhead* (added to
  the chart when missing), through Stockroom's `validated()` hook — so Work in progress clears with each order.
- **Tests**: the bridge proposed; 5 fixtures from 650 of components and 1,000 of operations enter at 1,650 (330 a
  unit, the product's cost after); Work in progress back to 0.00; 5200 −1,000; Inventory 1,650.
- **Then** (Production step 2 part 2): by-products and scrap with reasons; then the work centres' Gantt.

## Implementation notes (2026-10-30): Production, step 2 part 2 — by-products and scrap

- **Scrap** (`stock.scrap`, Stockroom › Scrap — for any stock, not only production): a product, a quantity, where
  from (the main stock by default), a lot, and **a reason** (damaged, defective, expired, spilt or broken in
  handling, other) with a note. *Scrap* moves it to the new *Scrap* location in a validated adjustment transfer,
  reserved first — what other transfers hold is not scrapped, and more than is available is refused; with
  `stock_account` it is a loss to Stock adjustments. Reports group scrap by reason and product.
- **On a production order**: scrap recorded with the order (`production` on the scrap) is listed on it.
- **By-products** on bills of materials (`mrp.bom.byproduct`): a product, a quantity per yield, a unit and a **share
  of the cost**; producing puts them in stock with the product made, and `mrp_account` splits the order's cost by
  the shares (the product made carries the rest). A by-product is never the product itself; the shares stay under
  100 %.
- **Tests**: scrap with its reason to the Scrap location, more than available refused; its loss to 5100; scrap on an
  order listed there; a by-product of itself or shares of 100 % refused; 1,650 split 1,485 / 165 between 5 fixtures
  and 10 offcuts at 10 %, Work in progress still cleared.
- **Then**: the work centres' Gantt with capacity (Production step 2 part 3).

## Implementation notes (2026-10-30): Production, step 2 part 3 — work orders, the Gantt, capacity (step 2 complete)

- **Work orders** (`mrp.workorder`): made when an order is confirmed, one per operation of its bill, with the minutes
  for the quantity ordered; **scheduled forward** at their work centre, after what the centre already has planned
  and after the order's previous step, from the order's date: a centre works its hours a day from 08:00, and what
  does not fit continues the next day. *Start* and *Finish* record when, and the minutes it took; *Produce* closes
  what is left; *Cancel* cancels them.
- **The Gantt**: Production › Work orders opens on the work centres' timeline (rows by centre); the order's form
  lists its steps with their planned times.
- **Capacity**: `GET /api/v1/production/capacity?from=&to=` gives each centre's planned hours and load (percent of
  its hours) day by day, counting only the hours inside each day's working window (a step running overnight does
  not count the night).
- **Fixed on the way**: an order whose bill has operations but no components (labour only) made an empty
  components transfer, refused by Stockroom; it makes none now. Minutes taken are computed from whole
  milliseconds (Shutro refuses fractional JavaScript numbers as decimals, by design).
- **Tests**: the scheduler's day spill; two orders at a 4-hour paint shop queued 16th 8–12 and 17th 8–9, then 17th
  9–12 and 18th 8–10; capacity 100 % / 100 % / 50 %; a step started and finished with its minutes; cancelling
  cancels; an inverted period refused. E2E (apps): Work orders open on the Gantt.
- **Production complete** (steps 1–2). Later: rescheduling by dragging bars, routings with parallel steps,
  quality checks.


## Design note: Asset Care (`modules/maintenance`, app code `assetcare`)

- **Equipment** (`maintenance.equipment`): name, asset tag, category, where it is, vendor, bought on, **warranty
  until**, responsible; its **meters** (`maintenance.meter`: hours, km, cycles) with **readings** that never go
  backwards; a status — *Operational*, *Down* while a breakdown is open, *Retired* when archived.
- **Preventive plans** (`maintenance.plan`): **by time** (every N days from a start date or the last time done) or
  **by meter** (every N units of a meter from the last reading done at), each with a **checklist**. When a plan is
  due — within the lead time of App settings › Asset Care (7 days by default) — its maintenance order is made with
  the checklist, once (a plan with an open order gets no other). Plans are run hourly by the server and on demand
  (`POST /api/v1/assetcare/plans/run`).
- **Maintenance orders** (`maintenance.request`, MT/2026/00001): *Preventive* (from a plan) or *Breakdown*
  (reported by anyone with access, the equipment down from the report); assigned, scheduled; *Start*, *Finish* —
  refused while the checklist is not ticked — with labour hours; downtime from report to finish. A preventive
  order done moves its plan on (the date, the meter value).
- **Reliability** (`GET /api/v1/assetcare/reliability?from=&to=`): per equipment over a period — failures, downtime
  hours, MTTR (mean time to repair), MTBF (mean operating time between failures) and availability.
- **Access**: *Technician* (orders, readings, reporting breakdowns) and *Manager* (equipment, plans, everything).
- **Step 2**: parts drawn from Stockroom on an order (`maintenance_stock`), labour cost, the plans' calendar.

## Implementation notes (2026-10-30): Asset Care, step 1

- **Module** `modules/maintenance` (`@kosh/maintenance`, export `maintenance`), app **Asset Care** (code
  `assetcare`); access levels *Technician* and *Manager*. It needs only Contacts: parts from Stockroom come with the
  `maintenance_stock` bridge (step 2).
- **Equipment** with asset tags unique per company, warranty, vendor, responsible, meters; the status
  (*Operational* / *Down* while a breakdown is open / *Retired* when archived) is computed, never set by hand.
- **Meters count up**: a reading below an earlier one (or above a later one) is refused; the meter shows its latest.
- **Preventive plans** by time or by meter with checklists; `runPlans` makes each due plan's order once (none while
  one is open), with the checklist and the equipment's responsible as technician; hourly in the server (off with
  `KOSH_SCHEDULES=off`), and on demand for managers (`POST /api/v1/assetcare/plans/run`). Orders of plans by time
  come within the lead time of App settings › Asset Care (7 days).
- **Maintenance orders**: *Finish* is refused until the checklist is ticked; a preventive order done moves its plan
  on (the date, the meter's value); downtime is counted from the report to the finish when the equipment stopped
  (breakdowns by default), from whole milliseconds.
- **Reliability**: `GET /api/v1/assetcare/reliability?from=&to=` — failures, downtime, MTTR, MTBF and availability
  per equipment over the period.
- **Tests**: on real PostgreSQL — readings never backwards; a plan by meter made once past its interval with its
  checklist, finish refused until ticked, then moved on; a plan by time within the lead time and not past it once the
  setting is lowered; a plan without its interval refused; a breakdown putting equipment down until done, three hours
  of downtime, MTTR 3, MTBF 69 and availability 95.8 % over three days; access by role; the demo. E2E (apps): a press
  added, reported down by a technician, repaired, operational again.
- **Step 2**: `maintenance_stock` (parts drawn from Stockroom on an order), labour cost, the plans' calendar.

## Implementation notes (2026-10-30): Asset Care, step 2 — spare parts, labour cost, the plans' calendar (complete)

- **`maintenance_stock`** (Asset Care ↔ Stockroom, proposed when both are installed): maintenance orders list their
  **spare parts** (product, quantity, unit, cost at the product's cost). *Start* reserves them in a transfer from the
  main stock to the new *Maintenance* location; *Finish* consumes them — **refused while some are short**, naming
  them ("Parts are short: Filter (1)"); *Cancel* releases them. All in an audited superuser scope, so technicians need
  no Stockroom rights. With `stock_account`, parts leave Inventory as a stock adjustment.
- **Hooks in Asset Care**, empty by default: `started()`, `finishing()` (throwing refuses the finish) and
  `cancelled()` on maintenance orders — the bridge overrides them.
- **Labour cost**: App settings › Asset Care gains *Cost of an hour of work*; a finished order's labour hours are
  costed at it (*Labour cost*). The order shows its parts cost too.
- **The plans' calendar**: preventive plans by their next due date.
- **Stockroom**: counts find the *Inventory adjustment* location by name (Scrap and Maintenance are adjustment
  locations too).
- **Tests**: the bridge proposed; parts reserved at the start by a technician without stock rights, the finish
  refused while one filter is short, then both consumed to Maintenance; 1.5 hours at 500 costed 750; cancelling
  releasing the reservation.
- **Asset Care complete** (steps 1–2). Later: a maintenance expense account for parts and labour, mobile checklists
  with photos, meter readings by scanning the equipment's tag.


## Design note: Trade Finance (`modules/trade_finance`, app code `tradefinance`)

- **Letters of credit** (`trade.lc`, LC/2026/00001 inside, the bank's LC number beside it): *import* (we are the
  applicant, the vendor the beneficiary) or *export* (the customer's bank opens it for us); the issuing bank (a
  contact), the counterparty, the currency and amount with a **tolerance** (± %, UCP 600 art. 30 "about"); payment
  **at sight** or **usance** (days after acceptance); the Incoterm; the **latest shipment date**, the **expiry date
  and place**; partial shipments and transshipment allowed or not; the documents required; the margin (%). States:
  *Draft* (application being prepared) → *Applied* → *Issued* → *Settled* (all drawn and paid, or closed) /
  *Cancelled*.
- **Amendments** (`trade.lc.amendment`): new amount, expiry or shipment date, and a note; **applied to the LC only
  when accepted** (UCP 600 art. 10), refused ones change nothing.
- **Presentations** (`trade.lc.presentation`): the documents presented for an amount drawn, the discrepancies found;
  *Accept* (a discrepant set only once the discrepancies are waived) sets the **maturity** — the acceptance date at
  sight, plus the usance days otherwise; *Pay* settles it; *Refuse*. What is drawn never passes the amount plus the
  tolerance; an LC whose drawings are paid in full is settled.
- **Limits per bank** (`trade.lc.limit`: a bank, a currency, an amount): what its issued LCs leave outstanding is
  shown, and **issuing an LC beyond the limit is refused**.
- **Alerts**: `GET /api/v1/trade/alerts` lists issued LCs whose shipment or expiry date falls within the window of App
  settings › Trade Finance (15 days by default), and the LCs list filters them.
- **Access**: *User* (LCs, presentations) and *Manager* (limits, issuing, accepting, everything).
- **Step 2**: margin and bank charges posted to Accounting (`trade_finance_account`), LCs linked to purchase and sales
  orders, shipments against the LC.

## Implementation notes (2026-10-30): Trade Finance, step 1

- **Module** `modules/trade_finance` (`@kosh/trade_finance`, export `tradeFinance`), app **Trade Finance** (code
  `tradefinance`); access levels *User* (users see contacts: the banks and counterparties of their LCs) and
  *Manager*; the feature permission `trade_finance.issue` (recording an LC issued, accepting amendments) is the
  managers'.
- **LCs** with the checks: goods ship on or before the LC expires, which is after it is applied for; usance needs its
  days; positive amounts; tolerance and margin between 0 and 100 %. *Issued by the bank* is refused beyond the bank's
  limit in the LC's currency (what its other issued LCs leave outstanding plus this one).
- **Amendments** apply their new amount, expiry or shipment date to the LC only when accepted; only issued LCs are
  amended.
- **Presentations**: a discrepant set is accepted only once waived; acceptance sets the maturity (at sight: the day;
  usance: so many days after); what is drawn (refused sets aside) never passes the amount plus the tolerance, nor is
  drawn after the expiry; when what is paid reaches the amount, the LC is settled. The LC shows what can be drawn,
  drawn, paid and outstanding.
- **Alerts**: `GET /api/v1/trade/alerts` — issued LCs' shipment and expiry dates within App settings › Trade Finance
  (15 days by default), with the days left. (Reading the setting is an audited superuser read, so the route runs in
  a read-write transaction.)
- **Tests**: on real PostgreSQL — the dates, usance and amount checks; issuing within the limit (80,000 of 100,000
  issued, 30,000 more refused), not by users; an amendment to 90,000 applied once accepted (94,500 drawable with 5 %),
  a refused one changing nothing; a discrepant presentation accepted once waived with a 90-day maturity, 100,000
  drawn refused, 94,500 drawn and paid settling the LC; alerts at 5 and 10 days, none with a 3-day window; access; the
  demo (which makes US dollars when an installation has none). E2E (apps): an LC applied, issued, documents
  presented and accepted with their maturity.
- **Step 2**: margin and bank charges posted to Accounting (`trade_finance_account`), LCs linked to purchase and sales
  orders, shipments against an LC, alerts on the home page and by notification.

