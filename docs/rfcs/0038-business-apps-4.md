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

## 5. Open questions

1. The order of §2 — is Quality first right, or does Fleet or Campaigns matter more now?
2. Restaurant (9) and Learning (10): wanted at all?
