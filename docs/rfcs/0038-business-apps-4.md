# RFC 0038 — Business apps, part 4: the apps Odoo has and Shutro ERP does not

Status: **proposed 2026-11-25** (the owner asked for "the necessary modules" to be more featureful than Odoo; step 1
is being built, the order below is his to change)

## 1. Why

`docs/odoo-gaps/` (2026-11-07) ranked the gaps inside the apps both products have. RFCs 0027–0037 closed nearly
all of them. What is left is of another kind: **whole apps** of Odoo — Community and Enterprise — that have no
counterpart here. This RFC lists them, says what each must do to be *better* than Odoo's rather than a copy, and
orders them by what a trading and manufacturing group needs first.

Not listed, because they exist: accounting, assets, budgets, payroll, attendance, leave and accruals, expenses,
approvals, helpdesk, documents, sign, subscriptions, surveys, loyalty, live chat, projects with billing, trade
finance, events, the website and shop, the Counter, maintenance, production with plans and costing.

## 2. The apps, in order

| # | App (module) | In Odoo | What makes it better here |
| --- | --- | --- | --- |
| 1 | **Quality** (`quality`, `quality_stock`, `quality_production`) | Enterprise | Control points by product, operation and vendor; checks of four kinds (pass / fail, a measure within tolerances, a checklist, a photo); a transfer or a production order **cannot be finished** over a failed or missing check — enforced by the server, not a warning; alerts with a root cause and corrective actions; a vendor's and a product's failure rate from the checks |
| 2 | **Fleet** (`fleet`, `fleet_account`) | Community | Vehicles with drivers and documents that expire (registration, fitness, tax token, insurance — reminded); fuel and service logs with cost per kilometre; trips tied to Stockroom's gate transport details; costs to Accounting by cost centre |
| 3 | **Campaigns** (`marketing`) | Community (email), Enterprise (automation) | Lists and segments by a saved filter of any model; emails and SMS / WhatsApp through the providers already there; unsubscribe and bounces honoured by the server; opens, clicks and the orders that followed; A/B subjects |
| 4 | **Repairs** (`repair`) | Community | A customer's item taken in, diagnosed, quoted, repaired with parts from stock and labour, under warranty or invoiced; tied to lots and serial numbers |
| 5 | **Appraisals and skills** (`hr_appraisal`) | Enterprise | Cycles, goals, self and manager reviews, 360° through Surveys, skills with levels; private to the person, the manager and HR by record rules |
| 6 | **Rental** (`rental`) | Enterprise | Products rented by the hour or the day, availability on a calendar, pick-up and return through Stockroom, late fees, deposits |
| 7 | **Knowledge** (`knowledge`) | Enterprise | Articles in a tree with rich text, permissions per article, linked from any record, searched with everything else, read by the AI assistant |
| 8 | **Field service** (`field_service`) | Enterprise | Tasks on a map and a route, worksheets on a phone, parts used, the customer's signature, invoiced |
| 9 | **Restaurant** (`pos_restaurant`) | Community | Floors and tables, orders sent to the kitchen screen, courses, split bills |
| 10 | **Learning** (`elearning`) | Community | Courses with lessons, quizzes through Surveys, completion and certificates |

Smaller, inside existing apps (no RFC of their own): the timesheet grid and timer (Projects), barcode operations
on a phone (Stockroom — the barcodes are drawn already), sales teams with assignment (Pipeline), onboarding
checklists (Workforce), interviews booked in Agenda (Hiring), customer reviews (Shop).

## 3. Rules every app follows

The module standard (RFC 0023) applies unchanged: access levels, search specs, lists and forms, chatter on
documents, print and import templates, named events, Bangla labels, an overview, demo data, and — since
2026-11-25 — the activity log on every record without declaring it. Money is `Decimal`. What blocks another app
(a transfer, a production order) does so through a hook of that app and a bridge module, never by importing it.

## 4. Step 1 — Quality

### 4.1 Models (`quality`)

- `quality.point` — a control point: a title, what is checked (`kind`: `pass_fail`, `measure`, `checklist`,
  `photo`), for which products (a product, a category, or all), on which operation (`receipt`, `delivery`,
  `internal`, `production`, or `any`), from which vendor (optional), how often (`every` operation, or 1 in *n*),
  the instructions, and for a measure its unit and its low / high tolerances; active.
- `quality.check` — one check to do: its point, the product, the lot, the document it is for (`resModel`,
  `resId`, a name), `state` (`todo` → `passed` | `failed`), the measured value, the notes, who checked and when.
  A measure passes by itself when it is within the tolerances and fails otherwise; nobody types the verdict.
- `quality.alert` — a problem found: a number, the product, the lot, the vendor, the check it came from,
  `state` (`new` → `investigating` → `resolved` | `cancelled`), the root cause, the corrective and the preventive
  action, the priority, who is responsible. A failed check proposes one.

### 4.2 Rules

- Checks are **made by the server** for an operation from the points that apply (`checksFor`), once per point and
  document line.
- A check is decided once; a passed or failed check is changed only by a Quality manager, with a reason.
- An alert cannot be resolved without a root cause and a corrective action.
- Access: `quality.user` does checks and raises alerts; `quality.manager` sets control points, redoes checks
  and closes alerts.

### 4.3 Bridges

- `quality_stock`: a transfer's checks are made when it is confirmed; validating it is **refused** while a check
  is to do or failed (a manager may release a failed one with a reason, kept on the check). A Checks tile on the
  transfer. Failure rates by vendor and product on the overview.
- `quality_production` (next): the same for production orders, at start and at finish.

### 4.4 Out of scope for step 1

Statistical process control charts, sampling plans by AQL, measuring devices over IoT, 8D reports.

## Implementation notes — step 1, Quality (2026-11-26)

- **`@kosh/quality`**: `quality.point`, `quality.check` (`QC/{year}/…`), `quality.alert` (`QA/{year}/…`) as §4.1,
  with `checksFor` and `blockingChecks` for the apps whose documents are checked. Roles `quality.user` and
  `quality.manager`; the permission `quality.decide` for release, redo and closing alerts.
- **A measure decides itself** through the guards of *Pass* and *Fail*: the one that disagrees with the value is
  refused, and so is either without a value. There is no third button: the checker writes the value and presses
  the one the value allows.
- **A failed check's alert is made at once** (the RFC said *proposes*): it is a record in state *New*, with the
  product, the lot, the vendor, the document and what was measured; nobody has to copy them.
- **One in n** counts the operations a point applied to (`seen`): the first, then every n-th.
- **`@kosh/quality_stock`**: `routing` (before a draft transfer is confirmed) makes the checks; `validated`
  refuses the validation while one holds it — the stock moved by the validation is rolled back with it — and
  makes the checks a backorder or an older transfer lacks. Receipts, deliveries, internal moves and production
  transfers are checked; adjustments and dropships are not. `stock.picking.form` gained its tiles group.
- **`@kosh/quality_production`** (same day): Production gained two hooks an order calls — `planned` once it is
  confirmed, `producing` before anything is consumed — and the bridge makes the order's checks at the first and
  refuses at the second. Writing it showed a defect in `quality_stock` as first committed: it checked transfers
  of the kind *production* too, and an order makes its output transfer and validates it in one step, so a control
  point *On: Production* would have made a check and refused the transfer in the same transaction — the order
  could never have been produced. `quality_stock` now leaves production transfers alone; the test installs both
  bridges and produces an order under a production control point.
- Tests: the points that apply (operation, product, category, vendor), once; the measure's verdict both ways;
  the photo; release and redo by a manager with a reason and by nobody else; one in two; alerts closed with their
  cause; the bridge with a warehouse user who has no Quality rights — refused, passed, failed, released; two
  browser tests (a point and an alert on screen, the overview).
- **Left out of step 1**: the checklist is its instructions' lines and a verdict — the lines are not ticked one by
  one; lots are a text on the check (the bridge passes none: a check is per product of a transfer, not per lot);
  checks at each work order of a production order (they are the order's, before it is produced); a photo taken from the phone's camera in the form (the picture field uploads a file);
  failure *rates* (the overview counts failed checks by vendor and product, it does not divide by the checks
  made); notifications to the Quality team when a check is made.

## Step 2 — Fleet (design, 2026-11-27)

### Models (`fleet`)

- `fleet.vehicle` — a master: the plate (unique per company), make, model, year, kind (car, pickup, truck, bus,
  motorcycle, other), fuel, the driver (a contact), status (*available*, *in the workshop*, *retired*), when it
  was bought and for how much. Kept by the server from its logs: the **odometer** (the highest reading), the
  fuel and service costs, the distance covered, **kilometres per litre** and **cost per kilometre**, the next
  service due.
- `fleet.document` — a paper that expires: registration, fitness, tax token, insurance, route permit, other;
  its number, the dates, who issued it, what it cost, how many days before the end to remind. Its status —
  *valid*, *expiring*, *expired* — is set by the server every day; the day it starts to expire the event
  `fleet.document.expiring` is emitted, once per paper.
- `fleet.fuel` — a fill: the date, the odometer, the litres, the amount, whether the tank was filled, the station.
- `fleet.service` — a service or a repair: the date, the odometer, the kind, the vendor, the amount, and when the
  next one is due (a date, an odometer reading, or both).
- `fleet.trip` — a trip: the vehicle, the driver, from, to, why; planned → started (the odometer at the start)
  → done (the odometer at the end; the distance is theirs).

### Rules

- **A reading never goes back**: a fill, a service or a trip's end below the vehicle's reading on an earlier date
  is refused.
- **Kilometres per litre by full tanks**: the distance between two fills that filled the tank, over the litres
  put in after the first up to and including the second — partial fills in between count. A pure function.
- **Cost per kilometre**: fuel and service amounts over the distance between the first and the highest reading.
- One trip at a time per vehicle; a retired vehicle takes no trip.
- Access: `fleet.user` logs fuel, services and trips; `fleet.manager` keeps vehicles and papers.

### Implementation notes (2026-11-27)

- Built as designed: `fleet.vehicle`, `fleet.document`, `fleet.fuel`, `fleet.service`, `fleet.trip`
  (`TRIP/{year}/…`); `consumption.ts` is the full-tank arithmetic in whole metres and millilitres.
- The vehicle's figures are **stored computes over its logs** — as Asset Care's meters are —: a new fill reads
  the vehicle's fills again. Right for a vehicle's few thousand logs; not the set-based way of Payroll, which a
  fleet does not need.
- A paper's status is a stored compute on its dates and on `checkedOn`, the day the server last looked: the
  round (every six hours, or `POST /api/v1/fleet/papers/refresh`) writes today on the papers it has not looked at
  today, which brings the status up to date, and announces each paper once per expiry (`remindedFor`).
- The vehicle's model is the field `series` — `model` is a name Shutro keeps for itself.
- Tests: the arithmetic (no full tank, two, a partial fill between, after and before); the figures after three
  fills, a partial one and a service; readings that go back refused both ways; papers by the calendar, announced
  once and again once brought near, not after a renewal; a trip from the vehicle's reading, one at a time, the
  end not below the start, none when retired; managers and users each refused what is not theirs; two browser
  tests.
- **Left out**: the reminder reaches nobody by itself — it is an event for an Automation rule, not a
  notification; a trip's end is not checked against later fills (only fills and services are held in order);
  drivers are contacts, not Workforce's employees, and have no licence with an expiry; fuel by a card or a
  station's statement; tyres; GPS.

### `fleet_account` (2026-11-27)

- **A cost centre per vehicle** (`fleet.vehicle.analytic`), made with the plate the first time something is
  booked. **Book** on a fill, a service and a paper (`booking`: *not booked* → *booked*, the permission
  `fleet_account.book` of the role *Fleet costs in the books*):
  - *Paid from* a cash or bank journal → one posted entry dated the log, the expense (6410 fuel, 6420
    maintenance, 6430 licences and insurance — found by code, made when the chart lacks them) on the cost centre
    against the journal's account;
  - otherwise → a line on the vendor's **draft bill** of fleet costs (`invoiceOrigin` *Fleet*): one bill per
    station or workshop collects its logs until an accountant posts it — a month's statement is one bill, not
    thirty.
- A booked log does not change (vehicle, date, amount, vendor, journal) and is not deleted: its journal line
  points at it with a restricting foreign key. *Take out of the books* reverses the entry, or removes the line
  from the draft bill and cancels a bill left empty; a posted bill refuses it until it is credited.
- **A defect found in Accounting on the way**: `reverseMove` copied a line's account and partner but **not its
  cost centre**, so a reversed entry — and a credit note made from a bill — left its cost on the cost centre for
  ever. Reversals now carry the cost centre; the bridge's test proves the centre returns to what it was.
- Tests: the cash entry with its lines and date; nobody but the role books; locked and not deleted; nothing to
  book; a journal that holds no money; two fills on one bill and the workshop's own; a paper; out of the books
  both ways, booked again at the new amount; refused once the bill is posted.
- **Left out**: taxes on the bill's lines (the accountant adds them); a vehicle's own expense accounts; booking
  many logs in one request (each is one call); the purchase of the vehicle itself as a fixed asset
  (`account_asset` from the bill, as for any asset); no screen test of its own — the buttons are view
  extensions like every bridge's.

### Later steps

The trip of a Stockroom transfer from its gate details, drivers' licences from Workforce, tyres, GPS.

## Step 3 — Campaigns (design and notes, 2026-11-27)

### Models (`marketing`)

- `marketing.list` and `marketing.subscriber` (address once per list by its key — trimmed, lower case —, name,
  phone, contact, language, *subscribed* / *unsubscribed* / *bounced*).
- `marketing.suppression` — the company's never-email list: an address, why (unsubscribed, bounced, complained,
  by hand).
- `marketing.campaign` — subject, subject B, preview text, the message (rich text), the lists and the contact
  tags it goes to, *Send at*; draft → scheduled → sending → sent (or cancelled); its figures.
- `marketing.delivery` — one per recipient and campaign: waiting, sent, not sent or left out; which subject;
  opened, clicked, unsubscribed, when. `marketing.link` — the message's links, numbered, with their clicks.

### Rules

- **Addressing is the server's**, when the campaign starts: subscribed addresses of the lists (one set-based
  read), then the tagged contacts **as the sender** (record rules decide), each address once; the never-email
  list is left out, each on record as *left out*. Recipients alternate A and B.
- **Sending** is a job per batch of 200: in one transaction each message gets a secret (its SHA-256 is kept, the
  secret is only in the message), is composed and marked sent; the batch is handed to the mailer after the
  commit, and what it refuses is marked *not sent*. At most once: a crash between the commit and the mailer
  loses that batch's messages rather than sending them twice.
- **A scheduled campaign** is a job with `runAt`, enqueued by the person who scheduled it: it runs as them.
- **Tracking** is three public routes keyed by the secret: the pixel (always a picture), the click (a redirect to
  link *n* of the campaign, 404 otherwise — no open redirect), the unsubscribe page (GET shows, POST does; the
  one-click post of RFC 8058 is the same route). Counters are incremented in SQL, a person once.
- Access: `marketing.user` writes campaigns and keeps subscribers; `marketing.manager` keeps lists and the
  never-email list and holds `marketing.send` (send, schedule, cancel).

### Implementation notes

- `render.ts` is the message without a database: the key of an address, placeholders (values escaped in HTML),
  the links, the variant, and `compose` — body in a plain frame, links rewritten, pixel, footer, headers.
- `OutboundMail` gained `headers` (`@kosh/mail`), passed to SMTP.
- Deliveries and links are not on the campaign as one-to-many fields: *Duplicate* copies a record's lines, and a
  copy of a campaign must not carry 100 000 messages. They are tiles on the form.
- Unsubscribing runs in the message's own company (`bootstrap({ company })`): a search without a company finds
  nothing of a company-scoped model, which the first version of the route did — the page said nothing happened.
- `marketing.delivery` and `marketing.link` are left out of the activity log (`audit-scope.ts`): they are a log.
- Tests: the rendering (7 cases); on PostgreSQL — who is written to and who is left out, the alternating
  subjects, the batch and the refused address, opens and clicks once per person, the redirect only to its own
  links, the page that asks and the button that does, a one-click post twice, the next campaign honouring it,
  schedule, cancel while sending, the test send, who may send; two browser tests.
- **Left out of part 1**: SMS and WhatsApp campaigns (the `Messenger` adapter is there); bounces read from
  inbound mail (a manager marks them); the orders that followed a click (a bridge with Sales); segments by a
  saved filter of any model (lists and contact tags for now); sending the winning subject to the rest; a
  double opt-in sign-up form on Sites; throttling per hour; opens by clients that fetch pictures themselves
  (Apple Mail's privacy proxy counts as an open); not measured beyond a few thousand recipients yet.

### Part 2 — bounces and the orders that followed (2026-11-27)

- **Bounces.** Inbound email (`@kosh/mail`) now announces every delivery report as the event `mail.bounced`
  — the ids of the messages it answers, and whether it is permanent (`permanentBounce`: an enhanced status of
  class 5 or a 55x reply) — before its own handling of notification emails. Campaigns keeps the mail server's id
  of each message (`providerId`, written after the batch is handed over) and subscribes: the message becomes
  *bounced*, in its company; a permanent one makes its subscriber *bounced* and puts the address on the
  never-email list. *Sent* counts bounced messages too — they went out.
- **`@kosh/marketing_sale`.** `sale.order.campaign`, written by the server only. On `sale.order.confirmed`:
  the latest click, within 30 days, of a message sent to the order's customer or to its address; once per order.
  The campaign's *Orders* and *Ordered* are tiles computed for whoever looks (Sales' rules apply), not counters.
- **One Campaigns module.** `marketingModule(options)` made a second module named `marketing` beside the one the
  bridge depends on, and the server refused to load both. There is one module now, and
  `configureCampaigns({ mailer, baseUrl, workers })` says how it sends before the server starts (tests, the E2E
  server).
- Tests: a soft and a permanent bounce, a report for somebody else's message, the same report twice; an order
  credited by contact and by address whatever its capitals, not without a click, not for someone who did not
  click, the last campaign winning, a click 31 days old, the field refused to a salesperson's PATCH.
- **Still left**: SMS and WhatsApp campaigns; segments by a saved filter of any model; the winning subject sent
  to the rest; credit for Shop and Counter orders (Sales orders only), and a setting for the 30 days; a credit is
  not taken back when the order is cancelled (the tiles count confirmed orders only).

### Part 3 — SMS and WhatsApp campaigns (2026-11-27)

- A campaign has a **channel** (email, SMS, WhatsApp), a **text**, a country code for local numbers and whether
  the way out is added. A text campaign is addressed by **phone number** (`phoneKey`: E.164, `00` as a plus, a
  local number by the country code) — subscribers' phones and tagged contacts' mobile or phone, each number
  once; unreadable numbers are counted as left out, people without a number are simply not its recipients.
- The never-email list takes **a phone number or an email address**, one of the two; a text campaign leaves out
  a number on it, and a person whose email address is on it.
- Sent through the `Messenger` of `@kosh/notify` (Twilio from the environment, a memory one in tests); a channel
  the provider is not set up for is refused at *Send now* with what to set. What the provider refuses is *not
  sent* with its reason.
- The unsubscribe link of a text is the same page: it shows the number masked and puts the number on the list.
- Tests: `phoneKey` and `composeText`; a list with local, international, duplicate, unreadable, refused and
  suppressed numbers and a subscriber without one; the text with its link; unsubscribing by it; WhatsApp without
  a provider refused.
- **Left out**: counting clicks in texts (links are not rewritten — a long address costs SMS segments); *STOP*
  replies (inbound texts); delivery receipts from the provider; WhatsApp templates and their variables; the
  price of a send before it starts.

## 5. Open questions

1. The order of §2 — is Quality first right, or does Fleet or Campaigns matter more now?
2. Restaurant (9) and Learning (10): wanted at all?
