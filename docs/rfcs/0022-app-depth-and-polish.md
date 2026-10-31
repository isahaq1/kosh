# RFC 0022 — App depth and polish: every app advanced, flexible and premium

- Status: **Draft** (asked by the user on 2026-10-31: "make sure all apps / modules are more advanced, flexible,
  more featureful and most premium to look at")
- Depends on: RFC 0004 (views), 0005 (reporting), 0007 (frontend), 0010 (modern UX), 0018 (workspace), 0021 (apps)

## 1. Summary

The shell, record pages, lists and the home page are premium since RFC 0018. What is not, measured on 2026-10-31,
is the **depth inside the apps**:

| Measured | Today |
| --- | --- |
| Apps with an overview or dashboard page | **0 of 17** (`dashboard(` is used by no module) |
| Actions that are a plain list + form | **41** (of ~70); 9 add a kanban, 6 a pivot, 5 a calendar |
| Form node kinds | 6: group, button, lines, page, notebook, component |
| Related records on a record page | none: no counts, no jump ("3 orders · 2 invoices · 12,000 due") |
| Field widgets | 16, all basic: text, numbers, dates, selection, badge, relations, JSON |
| Kanban cards | title, subtitle, footer, badges; no avatar, image, progress, colour, activity |
| Guidance on a record | a status chip; nothing says what is missing before the next step |

Odoo answers these with stat buttons, dashboards per app, ~60 widgets and kanban cards with avatars and
progress. Kosh does it **once in the platform, declared in TypeScript by each app** — never by hand-written
React in modules — so every app, including the user's own Studio modules, gets the same level.

## 2. Principles

1. **Declared, not drawn**: an app says *what* (the tiles, the KPIs, the widgets); the platform renders it, in both
   themes, both languages, on a phone. Modules keep zero business logic in React (CLAUDE.md).
2. **Server first**: counts, KPIs and charts come from the pivot engine and the metadata API, with the user's
   permissions; nothing is computed in the browser.
3. **Flexible without forking**: every tile, widget and overview can be extended or replaced by another module
   (view extensions, RFC 0004) and from Studio (RFC 0012).
4. **Premium means calm**: the RFC 0018 visual language (zinc surfaces, one accent, semantic tones only for meaning,
   tabular figures, no decoration for its own sake); richness comes from information density done well.

## 3. Step 1 — platform pieces (each app benefits by declaring them)

### 3.1 Related records on record pages: `k.stats([...])`

```ts
k.stats('related', [
  { id: 'orders', label: 'Orders', model: 'sale.order', where: { partner: '$id' }, action: 'sales.action_orders' },
  { id: 'due', label: 'Due', model: 'account.move', where: { partner: '$id', state: 'posted' }, measure: { sum: 'amountResidual' }, tone: 'warning' },
])
```

A row of tiles under the title: a count or a sum (server-side, with the user's rights and record rules), a tone,
and a click that opens that list filtered. Odoo's stat buttons, but live (realtime), typed, and extendable by other
modules (`website_crm` adds *Website submissions* on a deal).

### 3.2 App overviews: `overview({...})`

An action type that renders a page of **KPI tiles** (a measure of a model over a period, with the comparison to the
previous period: "Sales this month 1.2 M · +8 %"), **charts** (reusing graph views), **attention lists** (records
matching a filter, with their main action: "5 quotations to follow up", "3 bills to approve") and **shortcuts**.
Declared in the manifest; the first menu of each app opens it. The user can hide tiles and reorder them (saved per
user); Studio can add tiles from any report.

### 3.3 Widgets

Added to `@kosh/ui`, usable from any view by name: `image` (with upload and thumbnails via storage), `avatar`,
`tags` (many2many chips with colours), `rating`, `progress`, `priority` (stars), `color`, `email` / `phone` / `url`
(clickable, copy), `percentage`, `duration`, `daysLeft` (a date as "in 3 days", toned), `richtext` (a small editor,
sanitized), `handle` (drag to reorder lines), `qr`, `signature`. Lists get **column aggregates** (sum / avg in the
footer, declared per column) and **row decorations** (a tone from a condition: overdue in danger, done muted).
Kanban cards get `avatar`, `image`, `progress`, `color` stripe, the next activity's dot and a card menu.

### 3.4 Guidance

- A **next-step banner** from the status chip: what the next transition is and, from the server's guard, what is
  missing before it ("Add a customer and at least one line before Confirm").
- `help` on fields as hints; `description` on groups and pages as section lead text.
- **Required-field checklist** on draft records (the required fields still empty), compact, in the right rail.

### 3.5 Lists and forms

- Column resizing and pinning, remembered per user; row grouping with collapsible subtotals; a **print** of the
  list and of a record (print stylesheet) as PDF through the reporting engine.
- Attachments and images shown as a gallery on records that have them.

## 4. Step 2 — one pass per app (each a commit with screenshots and an E2E)

Each app gets: an overview, stats on its main records, the richer widgets where they fit, more view types where a
list is the wrong shape, and guidance. The notable additions per app:

| App | Depth added |
| --- | --- |
| Contacts | a 360° page: stats (orders, invoices, due, deals, tickets), avatar, tags, a map of addresses, the timeline |
| Products | images, variants' stock and sales stats, a price history chart, a kanban with images |
| Sales / Purchase | overview (revenue, pipeline of quotations, late deliveries), margin on orders, a calendar of expected dates, delivery and invoice stats |
| Accounting | overview (cash, receivables and payables aging charts, overdue, bank balances), stats on partners, the reconciliation widget |
| Projects | burndown and workload charts, a gantt of tasks, progress on projects, timesheet stats |
| Pipeline | forecast chart by close month, a funnel, activity view, deal stats (meetings, emails) |
| Workforce / Hiring | leave calendar by team, headcount and attrition KPIs, the hiring funnel, scorecard radar |
| Stockroom | stock overview (value, below minimum, expiring), move history on products, a location tree with quantities |
| Production / Asset Care | capacity and OEE tiles, the schedule board, reliability and downtime charts |
| Trade Finance | maturities timeline, limits utilisation gauges |
| Event Hub / Sites / Focus / Agenda | attendance and revenue stats; page analytics (submissions by form, by day); weekly planner |

## 5. Step 3 — flexibility

- **Per-company default views** and **per-user layouts** (columns, density, pinned tiles) through the settings;
- `visibleWhen` / `readonlyWhen` already exist; add `requiredWhen` and `tone` on nodes;
- Overview tiles from any saved report or filter (the user picks it; Studio ships it in a module).

## 6. Delivery

Step 1 in five parts (3.1 → 3.5), each reviewed with screenshots; then step 2 app by app, in the order of the table;
step 3 last. Performance budgets apply (an overview with eight tiles < 300 ms server time on the demo data).

## 7. Open questions

1. Start with step 1 (the platform pieces, so every app inherits them), or with one showcase app end to end
   (Sales: overview, stats, widgets, guidance) to agree on the look first? **Recommended: step 1, part 3.1 and 3.2
   first, with Sales as the first app to use them**, so the look is agreed on real screens within the first part.
2. Images: stored through `@kosh/storage` (S3) as now, with thumbnails made in a job — or only URLs for now?
   **Recommended: storage with thumbnails**, since products and contacts need real images.

## Decisions (2026-10-31)

1. **Start with the platform pieces** (3.1 stats and 3.2 overviews first), with **Sales as the first app** to use
   them, so the look is agreed on real screens early; then the widgets, the guidance, and one pass per app.
2. **Images are files in `@kosh/storage`** (S3-compatible), with thumbnails made in a job; the image widget shows
   them in forms, kanban cards and lists.
