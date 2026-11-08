# RFC 0031 — Production in depth: planning, schedules, two-stage production, formulas, overheads, and the explain popovers

- Status: Accepted (2026-11-08)
- Builds on: RFC 0021 (Production: BOMs with versions, work centres, orders, work orders, the Gantt; `mrp_account`),
  RFC 0025 / 0027 (the Approvals engine), RFC 0030 (vendor prices for procurement), RFC 0022 (tiles, guidance)
- Source: Paragon's Odoo "Feed Production" app, shown in `D:\pg-soft\PG\odo\production-ebs.mp4` (14 min, watched
  frame by frame). What Kosh builds is generic: **any product, in any unit** — feed in kg, paint in litres, garments
  in pieces —, never feed-specific.

## 1. What the video shows

Paragon runs production in two stages on top of Odoo Manufacturing, with eight screens:

| Screen | What it holds |
| --- | --- |
| **Production plans** | A period, the production location and machine lines; plan lines (finished product, formula and version, quantity, machine slot start / end, the bag BOM of the bagged product); the **ingredient** and **bagging material forecast** (required, on hand, shortage, procurement required); approvals; states Draft → Forecast generated → Waiting approval → Approved → Schedules generated; a **Gantt by machine line** coloured by state |
| **Production schedules** | One batch: product, formula and version, plan, batch number, costing mode, machine line, target / produced / remaining quantity; **pre-flight ingredients** (required, available, deficit / surplus); Draft → Load inventory → Closed → Confirmed → In progress → Done; its MOs |
| **Feed BOMs (formulas)** | Reference, finished product, breed and formula type, version with validity, total quantity and **ratio %**; ingredients with **loss %** and net quantity; **nutrients**; approval history; **overhead costs**; Draft → Under review → Active → Inactive; Create revision; costing history |
| **Bag BOMs** | A packed product (a 50 kg bag) made of the bulk product and the empty bag; packaging unit weight, **expected bagging loss %**, **tolerance ±%** |
| **MOs** | The bulk MO and the bagging MO, linked: feed schedule, mill role (bulk / bagging), **source bulk MO and lot**, consumed and produced quantity, **process loss / gain** and %, **yield status** (within tolerance), costing mode, actual start / end, operator, shift; **batch & labelling** (batch number, manufacturing date, expiry date, **MRP value** printed on the bag) |
| **Overhead & costing** | A **costing master** (on products or categories, valid dates, overhead lines: account, fixed / percentage / per kg); a rate change log; **month-end overhead reconciliation**, closed months, **allocation runs** (debited, allocated, unallocated, produced quantity), distribution rules |
| **Configuration** | Machine lines (work centres with **max / min batch size**, OEE target, setup and cleanup time, cost per hour, expense account, alternatives); **ingredient eligibility** (which product groups may be ingredients, per company); **shifts** |
| **Developer mode** | Every field label and button shows, on hover, a **black popup** with its technical facts: label, field, model, type, widget, domain, required, readonly (and when), the **relation** (the model it points to), the selection's values; a button's object, type, method and when it is hidden |

## 2. Where Kosh goes further

| | Paragon / Odoo | Kosh after this RFC |
| --- | --- | --- |
| Products | Feed in kg, hard-wired | **Any product in its own unit**; loss and yield measured in the unit's category (weight, volume, count) |
| Stages | Bulk then bagging, two custom flows | **Stages as data**: a BOM of kind *packaging* turns a made product into packs; any number of stages chain by **source order and lot** |
| Forecast | Ingredients and bags | Every level of the BOMs (made components included), on hand **and on order**, the shortage turned into requests for quotation with the **vendor chosen and explained** (RFC 0030) |
| Approvals | Fixed reviewers | Plans and formulas through the **Approvals engine** (levels, amounts, delegation, decisions from email) |
| Capacity | Batch limits as fields | Plans **refuse** a slot beyond the machine's batch limits or hours and say why; batches split by the maximum size |
| Developer popups | Debug mode, raw Python domains | **Explain popovers** in plain words on every field, column, button, tile and menu — what it is, where it comes from (the module), what it points to, who may change it, what a button does — for developers and administrators, and the model's **relations both ways** |

## 3. Design

### 3.1 Explain popovers (platform: `@kosh/server` metadata, `@kosh/ui`)

- A **Developer mode** switch in the user menu, for administrators and a new group `base.developer`; off by default.
- With it on, hovering or focusing a field label, a list column, a button, a stat tile or a menu opens a **dark popover**
  (`bg-neutral-950`, white text, keyboard reachable, Escape closes):
  - field: label, key, model, kind, **relation** (the target model, and for one-to-many the inverse field) as a link
    that opens the target's list, required / readonly / required when / readonly when / visible when, stored or
    computed (and from what), default, help, selection values, **the module that defined it and the ones that extend
    it**;
  - button: the transition, its states from and to, its guard's message, the event it emits, who may run it;
  - tile and menu: the model and the domain, the action;
  - the page title: the model with **every relation in and out** (which models point here, through which field).
- Served by `GET /api/v1/meta/explain/:model` (developers only; the plain metadata stays as it is).

### 3.2 BOMs in depth (`mrp`)

- `mrp.bom.kind`: **standard**, **formula** (lines are shares of a batch: ratio %, scaled to any quantity; the ratios
  add up to 100) or **packaging** (a pack of the made product: pack size in the product's unit, expected loss %,
  tolerance ±%).
- Lines get **loss %** and **net quantity**; formula lines a **ratio %**.
- **Specifications** (generic "nutrients"): parameter, minimum, maximum, unit, the value the formula reaches.
- **Approval**: Draft → Under review → Active → Inactive through the Approvals engine; only active BOMs are used;
  **Create revision** copies to the next version; the cost of each version kept (**costing history**).
- **Component eligibility**: per BOM kind and company, the product categories allowed as components; refused lines
  say why.
- Work centres get **max / min batch size**, OEE target, setup and cleanup minutes, expense account, alternatives;
  `mrp.shift` (name, start, end).

### 3.3 Production plans (`mrp`, with `purchase_stock` for procurement)

- `mrp.plan`: period, warehouse, work centres; lines (product, BOM and version, quantity, work centre, start / end,
  the packaging BOM for a second stage); state Draft → Forecast → Waiting approval → Approved → Scheduled → Cancelled.
- **Generate forecast**: explodes every line through every level (packaging included) into materials — required, on
  hand, on order, shortage —, with **Procure** making requests for quotation (the vendor price's choice, RFC 0030).
- **Capacity**: a slot beyond the work centre's batch limits or its hours is refused with the reason.
- Approval through the Approvals engine; **Gantt by work centre** coloured by state.

### 3.4 Schedules and two-stage production (`mrp`, `stock`)

- `mrp.schedule` from each approved plan line, split into batches by the work centre's maximum size: product, BOM and
  version, batch number (a sequence), costing mode, work centre, shift, target / produced / remaining quantity;
  **pre-flight** (each component's required, available, deficit or surplus); Draft → Stock checked → Closed →
  Confirmed → In progress → Done.
- Confirming makes the **production orders**: the make order, then for a packaging BOM the **pack order** consuming
  the make order's output by its **lot** (source order, source lot).
- Production orders get the **stage**, source order and lot, consumed and produced quantity, **process loss / gain**
  (quantity and %), **yield status** against the BOM's expected loss and tolerance, actual start / end, operator,
  shift.
- **Batch & labelling** on the produced lot: batch number, manufacturing date, expiry date (from the product's shelf
  life), **MRP value** (maximum retail price); a label print template.

### 3.5 Overheads and costing (`mrp_account`)

- **Costing master**: on products or categories, valid dates, lines (overhead name, account, fixed amount, percentage
  of material cost, or per unit produced); applied to each production order's cost (an *overhead* part beside
  materials and operations), with the rate changes in the audit log.
- **Month-end allocation**: the month's actual overhead (the accounts' debits) against what orders absorbed; the
  difference allocated to the month's produced quantity by a distribution rule, posted once; closed months locked.

## 4. Steps

1. Explain popovers: developer mode, the explain metadata, the popover on fields, columns, buttons, tiles, menus and
   the page title, with relations both ways.
2. BOMs in depth: kinds (formula, packaging), loss and ratios, specifications, eligibility, approval and revisions,
   costing history; work centre limits; shifts.
3. Production plans: lines, the multi-level forecast with procurement, capacity checks, approval, the Gantt by work
   centre.
4. Schedules and two-stage production: batches, pre-flight, make and pack orders linked by lot, loss / gain and yield,
   batch labelling, traceability.
5. Overheads: the costing master on order costs, month-end allocation and closed months.

Each step: real-PostgreSQL tests with permission tests, English and Bangla, the module standard, E2E for the
user-facing flows, docs. Demo data: a feed mill (bulk feed and 50 kg bags) and a non-feed example (paint in litres and
4 L cans) to prove products of any kind.

## 5. Not in this RFC

Quality checks on batches (a quality RFC), nutrient optimisation (least-cost formulation), maintenance-driven machine
availability beyond the work centre's hours, OEE measured from the shop floor.
