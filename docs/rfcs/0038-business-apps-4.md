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

### Later steps

`fleet_account` (fuel and service costs to Accounting by cost centre), the trip of a Stockroom transfer from its
gate details, drivers' licences from Workforce, tyres, GPS.

## 5. Open questions

1. The order of §2 — is Quality first right, or does Fleet or Campaigns matter more now?
2. Restaurant (9) and Learning (10): wanted at all?
