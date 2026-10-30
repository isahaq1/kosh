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
- **Next** (step 2 part 4): lots and serial numbers.

