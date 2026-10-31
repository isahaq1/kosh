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

## Implementation notes (2026-10-31): step 1, part 3.1 — related records on record pages

- **`k.stats(id, tiles)`** in `@kosh/views`: a `stats` node of `stat` tiles (`label`, `model`, `where` with
  `$record` placeholders, `measure` — the count by default, or `{ sum }` / `{ avg }` —, `action`, `tone`,
  `visibleWhen`). `stat(...)` builds a tile for extensions; `{ append: '<row id>', nodes: [stat(...)] }` adds to
  another module's row. Load-time checks: the tile's model is installed, its measure and filter fields exist on it,
  and `$record` names fields of the page's model. `resolveRecord(condition, values)` fills the placeholders.
- **The UI** (`StatsRow`) computes each tile through `POST /models/:model/aggregate` as the user — their rights
  and record rules apply, nothing is computed in the browser —, refetches with the record's version (so a
  transition updates the tiles), formats sums per locale with the currency when the measure is monetary, and opens
  the tile's action (or the model's default) with the same filter as a custom search chip labelled by the tile.
  The row stands under the title, outside the cards, four tiles wide on a desktop and two on a phone.
- **Rows and tiles shipped**: Contacts declares an empty row `related` on the contact; Sales appends *Sales orders*
  and *Sales* (the total, in green), Purchase *Purchase orders* and *Purchases*, Accounting *Invoices*, *Due from
  them* (posted customer invoices not paid, in amber) and *Bills*. Sales orders and purchase orders declare a row;
  `sale_account` / `purchase_account` append *Invoices* / *Bills* and the posted total, `sale_stock` /
  `purchase_stock` *Deliveries* / *Receipts*.
- **E2E**: the accounting flow checks the order's *Invoices 1* tile after *Create invoice* and that it opens the
  invoices filtered to that order.

## Implementation notes (2026-10-31): step 1, part 3.2 — app overviews

- **Declared in the manifest**: `overview: { cards: [...] }` — KPI (with `comparison: { field, mode }` for this
  month against the previous one or last year), chart, pivot and list cards, each a report query the viewer's
  rights and record rules apply to (`OverviewCardSpec` in `@kosh/modules-sdk`). `defineModule` checks it (an app,
  a dependency on `reporting`, unique snake_case card ids, `count` or `op:field` measures) and generates the action
  `<module>.action_overview` (the page `reporting.Overview`) and the menu `<module>.overview` first under the app's
  root menu.
- **Installed as a dashboard**: `report.dashboard` gained a `key` (the module; one overview per app) and reporting's
  `defaults` hook creates the app's shared dashboard once, from the cards (a dashboard a user later changes is left
  alone). `GET /api/v1/reports/overview?app=` returns the label and the cards for any signed-in user — the dashboard
  record itself needs the reports' access, which app users may not have, so the route reads it as the system; the
  cards then query as the user.
- **The page** reuses the dashboards' cards (`CardFrame`, the drill-down to records) read-only: the layout belongs
  to the app; personal layouts come with step 3.
- **Sales** is the first app with one: sales and orders this month against last month, open quotations, the
  average order, sales by month, top customers, by salesperson, the biggest open quotations.
- **Tests**: the SDK's generation and checks; Sales' route on real PostgreSQL; E2E (apps): the Overview menu of
  Sales opens the page with its cards and no Edit.

## Implementation notes (2026-10-31): step 1, part 3.3 — widgets, cards and rows

- **Widgets** added to `@kosh/ui`, usable from any view by name: `email`, `phone`, `url` (links in display, the
  text input to edit), `progress` (0–100 as a bar), `percentage`, `rating` (0–5 as stars, click to set),
  `priority` (a selection as stars, its options in order), `color` (a dot tinted by the value), `daysLeft` (a date
  as "in 3 days" / "2 days late", toned), `tags` (many2many chips tinted by name), `image` and `avatar`.
- **Images are attachments** (decided: files in storage): an `image` field is a `many2one('storage.attachment')`.
  The widget shrinks the chosen file in the browser (at most 1,600 px) and makes its 256 px thumbnail, uploads
  both to the record — the thumbnail with `X-Variant-Of` and `X-Width`, kept on `storage.attachment` as
  `variantOf` / `width` — and the field holds the image; `GET /api/v1/attachments/:id/download?w=256` serves the
  variant when there is one. Variants stay out of a record's attachment list. Thumbnails come from the browser,
  not a job: no native image dependency on the server, and the avatar already works this way; a job (with `sharp`)
  can make variants for imported images later.
- **Kanban cards** take `image` (a cover), `avatar` (a person's initials), `progress` (a bar) and `color` (a
  tinted edge from a selection or text); **lists** take `decorations: { danger: { … }, success: { … } }`, a
  tone for the rows a condition holds on (the browser evaluates it on the row), checked at load like the rest.
- **Shipped**: contacts get a photo (`image`), their email, phones and website as links, the avatar on the list;
  products a picture on the form, the list and the cards; Pipeline's deals show their priority as stars, the
  salesperson on the card, the stage as the card's tint, won deals in green and lost ones muted; locked sales
  orders in green, cancelled ones muted. Contacts and Products now depend on `storage`.

## Implementation notes (2026-10-31): step 1, part 3.4 — guidance on a record

- **The next step** — `GET /api/v1/models/:model/:id/next`: the transitions from the record's state the user may
  run (write access, the `requires` permission), each with whether its **guard** lets this record go and the
  guard's `message` when not. The guard runs read-only on the record (Shutro guards return the records that may
  not go); nothing is changed. The form shows a banner above the actions: "Next step: Confirm" with the button
  when it may run, or "Before Confirm: Add at least one line…" in amber when the guard refuses; refetched with
  the record's version. `before` hooks that throw are not predicted (their error still shows when tried).
- **Hints**: a field's `help` (Shutro) is served with the field metadata and shown under the input when the view
  gives none; groups and pages take a `description` shown under their title or tab.
- **The checklist**: the required fields of the form still empty, counted in the right rail ("3 things to fill
  in"), from the field metadata; nothing is sent.
- **Tests**: Sales on real PostgreSQL — a quotation without lines: Confirm refused with its message, Send allowed;
  with a line, Confirm allowed; a manager-only transition hidden from a user. E2E (apps): the banner on a new
  quotation, then the next step offered and taken.

## Implementation notes (2026-10-31): step 1, part 3.5 (part 1) — columns resized and pinned

- A handle at each header cell's end resizes the column by dragging (double-click resets), or with the keyboard
  (the arrows by 16 px, Home resets; RTL-aware); the Columns menu pins columns at the start (sticky while the rest
  scrolls, after the selection column) and resets the widths. Widths and pins are remembered per user and view in
  the browser, like the hidden columns and the density. Grouped lists share the layout.
- E2E (chromium): a column widened with the keyboard keeps its width after a reload; pinned, it is sticky.
- Next (part 2): printing a list and a record as PDF through the reporting engine; attachment galleries.

## Implementation notes (2026-10-31): step 1, part 3.5 (part 2) — printing

- **A list as PDF**: *Export › Print as PDF* sends the columns shown and the filter to
  `POST /api/v1/models/:model/export/pdf` (export access, audited like the other exports, up to 2,000 rows): the
  rows the XLSX export builds — many2one names, dates, money — laid out as a table with the header repeated on
  every page, numbers right-aligned, landscape beyond six columns, rendered by the document engine (Playwright).
- **A record's documents**: the *Print* menu of the record's templates (`reporting.Documents`) now appears with
  the record's actions on every form when reporting's web is registered, without each module placing it.
- **Galleries**: the chatter already shows a record's image attachments as thumbnails; the image widget covers the
  record's own picture. No separate gallery block for now.
- Tests: the PDF export on real PostgreSQL (a PDF back, the filename, export access); E2E: *Print as PDF*
  downloads from a list; the *Print* button on a posted invoice.

## Implementation notes (2026-10-31): step 2 — Contacts

- **Tags** (`res.partner.tag`, shared across companies, kept by managers from *Contacts › Tags*): set on contacts,
  shown as tinted chips on the list, the board and the form, searched (`tags.name`).
- **The board** (`kanban` by city): the photo as the avatar, the company, the email as a link, the tags; kanban
  cards now show an attachment field's picture as the avatar. **The map**: `latitude` / `longitude` on contacts
  (decimal degrees, under *Address › On the map*), the Map view of those that have them.
- **The Overview**: contacts, customers, vendors, new this month against last month, by country, companies by city.
  Contacts now depends on `reporting`.
- Demo: three tags (Bengal Steel a key account, the two-way partners "Both ways"), Bengal Steel and Acme on the map.
- Tests: Contacts on real PostgreSQL (tags by managers only, one name once, set on a contact and searched; the
  overview to a user; the action's kanban and map; the Tags menu to managers only). E2E (apps): the overview, a
  tag made and set on a contact, its chip on the board, the map view.

## Implementation notes (2026-10-31): step 2 — Products

- **Tiles on the product** (`related`, empty in Products itself): Sales appends *Sold* (the quantity of confirmed
  order lines) and *Sales* (their subtotal), Purchase *Bought*, Stockroom *On hand* (the quants in internal
  locations, opening the Stock list). Filters through relations (`order.state`, `location.usage`).
- **The Overview**: products, goods, services, the average sales price, by category, the highest sales prices.
  Products now depends on `reporting`. Pictures, the board with them and the avatar on the list came with 3.3.
- Tests: Products on real PostgreSQL (the overview to a user; the empty row served on the form); Sales' test
  checks the tiles it appends. E2E (apps): the overview; a product's *Sold*, *Bought* and *On hand* tiles.

## Implementation notes (2026-10-31): step 2 — Sales and Purchase

- **Margin** on sales: each line earns its untaxed amount less its product's cost (`margin`), the order sums it
  and shows the percentage; in the totals, on the list (summed) and as *Margin this month* on the overview.
- **Calendars**: quotations by the day they expire (*Quotations › Calendar*), purchase orders by their expected
  arrival (*Purchase orders › Calendar*).
- **The Purchase overview**: purchases and orders this month against last month, open requests, waiting approval,
  purchases by month, top vendors, by buyer, the biggest open requests. Purchase now depends on `reporting`.
- Tests: Sales on real PostgreSQL (the margin of a line and the order, 40 %); Purchase (the overview to a user).
  E2E (apps): the Purchase overview, the arrivals calendar, the margin on an order.
