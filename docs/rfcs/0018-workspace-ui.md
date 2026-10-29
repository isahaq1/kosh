# RFC 0018: The Workspace back-office

- **Status:** Accepted (2026-10-28)
- **Depends on:** 0004 (views), 0006 (chatter), 0007 (frontend architecture), 0010 (modern back-office)
- **Chosen direction:** "Workspace" (asked 2026-10-28, over "split view" and "refine the current layout")

## 1. Summary

Give the back-office a layout of its own, closer to Linear, Stripe and Notion than to Odoo: a **left sidebar** for
apps and their sections instead of a top app menu, **document-style record pages** (a title, one status chip, the
main action, content on the left and a **right rail** with the summary, details and timeline), calmer **lists** with
saved views as tabs, a **Today** home, and a refreshed **visual language** (type scale, neutral palette with one
accent, density, semantic status colours). Modules change nothing: the same view definitions render in the new
shell; two optional hints (`subtitle`, `summary`) make record pages better.

## 2. Problem

Screenshots of the current back-office (2026-10-28) show a clean but generic UI whose structure is Odoo's:

- **Top menu per app** (Sales › Quotations · Sales orders · Customers), the app grid behind an icon, the state as a
  row of pills top right, the chatter stacked under the form.
- **Record pages have no hierarchy**: every field is a boxed input even when read-only, totals are a list of
  label/value pairs, the customer and amount are not visible at a glance, the timeline sits far below.
- **Defects** found on the way, fixed already: saved records showed no lines (the form never asked for one2many
  fields), "Total Total" in list footers, state badges coloured by position (Posted in red). Still open: dates in
  forms use the browser's `mm/dd/yyyy` while lists show `28 Oct 2026`.

## 3. How Odoo does it, and its weaknesses

- One horizontal menu per app with dropdowns: deep sections hide behind hover menus; switching apps goes through a
  full-screen grid.
- The status bar (all states as arrows) takes room on every form and says little about what to do next.
- Forms are sheets of boxed fields; the chatter below (or beside on wide screens) is a long undifferentiated log.
- Visual density is fixed; the palette is grey with purple accents; numbers are not aligned in tabular figures.

## 4. Design

### 4.1 Shell

```
┌──────────┬───────────────────────────────────────────────────────────┐
│ ◆ Padma ▾│ Sales orders › SO/2026/00001          ⌘K   🔔   ◐   (D)  │  page bar
│ ⌕ Search │───────────────────────────────────────────────────────────│
│ ⌂ Home   │                                                           │
│ ✉ Inbox 3│                       page content                        │
│ ───────  │                                                           │
│ Sales   ▾│                                                           │
│   Quotes │                                                           │
│   Orders │                                                           │
│   Custom.│                                                           │
│ Accounting│                                                          │
│ Purchase │                                                           │
│ Projects │                                                           │
│ ───────  │                                                           │
│ ⚙ Settings│                                                          │
└──────────┴───────────────────────────────────────────────────────────┘
```

- **Sidebar** (15 rem; collapses to a 3.5 rem icon rail with `Ctrl+B`, remembered per user): the company switcher at
  the top, search (opens the palette), Home, **Inbox** (notifications and the user's activities, with a count), then
  the user's apps — each expands to its menu sections (one open at a time; the current one opens itself), then
  Settings. Order: the user's most used apps first (from the recent-records memory), then the rest.
- **Page bar**: breadcrumbs (app › action › record), the page's own actions on the right, presence avatars on
  records, notifications, theme, the user menu. The top app menu goes away.
- **Phones and tablets** (< 64 rem): the sidebar is a drawer behind a menu button; the page bar keeps breadcrumbs
  short (the last two).
- Keyboard: `Ctrl+K` palette (as now), `Ctrl+B` sidebar, `g h` Home, `g i` Inbox, `[`/`]` previous / next record.

### 4.2 Record pages

```
SO/2026/00001  ● Sales order  ▾                     [Create invoice]  [⋯]
Bengal Steel · 28 Oct 2026 · Rahim Uddin · 2,300.00 BDT
┌ Details ─────────────────────────────────┐  ┌ Summary ─────────────┐
│ Customer      Bengal Steel               │  │ Untaxed     2,000.00 │
│ Currency      BDT                        │  │ VAT 15 %      300.00 │
│ Order date    28 Oct 2026                │  │ Total       2,300.00 │
└──────────────────────────────────────────┘  ├ Details ─────────────┤
┌ Lines ───────────────────────────────────┐  │ Created by Rahim     │
│ Product     Qty   Price    Taxes   Amount│  │ Company Padma        │
│ Steel beam  2     1,000    VAT 15% 2,000 │  ├ Timeline ────────────┤
│ + Add a line                             │  │ ● Confirmed · 4:50 pm│
└──────────────────────────────────────────┘  │ ○ Created · 4:50 pm  │
                                              │ [Write a note…]      │
                                              └──────────────────────┘
```

- **Header**: the record's name; **one status chip** in its semantic tone, which opens a small popover with the
  whole workflow (where the record is, what comes next) instead of a row of pills; the main transition as the one
  filled button, the others and the record's tools (duplicate, print, archive, history) in a `⋯` menu; the pager.
- **Subtitle**: a line of key facts under the title (the customer, the date, the owner, the total), from the view's
  optional `subtitle` hint, else from the first many2one, date and monetary fields of the first group.
- **Sections as cards** with headings (the view's groups and notebook pages); fields **read first**: a read-only or
  not-yet-edited value is plain text in a label-beside-value row, and becomes an input on focus or click (edits are
  still saved with Save, and the dirty state shows as now). Required fields keep their mark; errors stay inline.
- **Lines** as a proper table with right-aligned tabular amounts and a footer under the amount column.
- **Right rail** (20 rem, ≥ 80 rem wide; under the content as tabs below that): **Summary** (the totals: the view's
  optional `summary` hint, else a group named `totals` moves there), **Details** (created / updated by and when,
  company, external id), **Timeline** (the chatter: messages, notes, activities and the change log, compact, with
  the composer at the top; "Send message" and "Log note" as tabs of one composer). The AI tools (summarize, draft)
  stay in the composer.
- Date fields get the app's own **date picker** (formatted per the user's language, a popover calendar, typing
  allowed); money inputs are right-aligned with tabular figures.

### 4.3 Lists

- **Saved views as tabs** above the list (All · the user's favourites · shared ones), the search with filter chips
  under them; group-by and columns in a toolbar menu.
- Comfortable or **compact density** (a user setting); sticky header; amounts right-aligned in tabular figures;
  states as semantic badges; row hover shows quick actions (open in a new tab, duplicate).
- Selecting rows shows a **floating action bar** at the bottom (count, bulk actions, export) instead of toolbar
  changes.
- **Empty states** say what the list is for and offer the main action ("No quotations yet — Create one").

### 4.4 Home: Today

- **Needs your attention** (activities due, approvals waiting, payments failed, mentions) as a list with actions.
- **Recent** records (from the existing memory) and **pinned** dashboards and reports.
- The apps grid becomes an **All apps** page reachable from the sidebar.

### 4.5 Visual language

- **Palette**: neutral (zinc) surfaces, one accent (indigo by default; a company may set its brand accent, checked
  for contrast), semantic tones (success, warning, danger, info) used only for meaning. Light and dark tuned
  separately, WCAG AA for text.
- **Type**: Inter and Noto Sans Bengali; a scale of 12 / 13 / 14 / 16 / 20 / 24 px; amounts and numbers in
  tabular figures; headings semibold, body regular.
- **Space and shape**: an 8 px grid, radius 10 px for cards and 6 px for controls, 1 px borders, almost no shadow
  (only popovers and the floating bar), focus rings always visible.
- **Motion**: 120–180 ms for popovers, the sidebar and the rail; none under `prefers-reduced-motion`.
- **Density**: comfortable (default) or compact, applied to lists, forms and the sidebar.

## 5. Compatibility

- **Modules change nothing**: view definitions (RFC 0004) render as before in the new shell; custom components
  keep their props. Two optional form hints: `subtitle: string[]` (fields of the key-facts line) and
  `summary: string[]` (fields of the rail's Summary). Studio offers both later.
- The portal (`apps/portal`) moves to the same tokens and components (its layout stays phone-first).
- E2E tests find elements by role and name; menu links keep their names in the sidebar. Tests that open the app
  grid or the top menu change with step 2.
- No new dependency: the sidebar, popovers and the date picker are built on the Radix primitives already used.

## 6. Delivery plan (each step reviewed, with screenshots)

1. **Visual language**: tokens, type scale, density setting, semantic tones (badges done), the status chip, the
   date picker and money inputs — in the current layout.
2. **Shell**: sidebar with apps and sections, page bar with breadcrumbs, mobile drawer, Inbox, `Ctrl+B`; the top app
   menu removed; the All apps page.
3. **Record pages**: header with the status chip and its workflow popover, subtitle, section cards, read-first
   fields, lines table, right rail with Summary, Details and Timeline; the `subtitle` and `summary` hints.
4. **Lists and Home**: saved views as tabs, floating selection bar, empty states, density; the Today home.
5. **Portal** on the same tokens; screenshots in `docs/ui.md`; visual regression baselines in CI.

## 7. Open questions

1. **Brand accent per company** (the company's colour as the accent, contrast-checked): yes, or one accent for all?
2. **Default density**: comfortable or compact?
3. **The right rail**: open by default on wide screens (proposed), or collapsed until opened?

## Decisions (2026-10-28)

1. **Accent**: each company's brand colour (indigo by default), contrast-checked for light and dark.
2. **Density**: comfortable by default; compact as a user setting.
3. **Right rail**: open by default on wide screens, collapsible and remembered per user.

## Alignment with CLAUDE.md

Every component works in light and dark mode, in English and Bangla, by keyboard and screen reader (landmarks for
the sidebar, the page and the rail; a skip link; focus management in popovers); no business logic moves into React —
the workflow popover reads the transitions the server serves, the summary reads fields the server returns.
"Customizable without forking": the hints are optional and the renderers stay replaceable per view.

## Implementation notes (2026-10-28): step 1 — the visual language

- **Defects fixed first**: forms now ask for the one2many and many2many fields their layout shows (saved orders and
  invoices showed no lines); sums no longer say "Total Total"; state badges take the tone of what the state means.
- **Tokens**: neutral (zinc) surfaces; the accent from `--accent-h` / `--accent-c` with a lightness fixed per theme
  (light 0.5 with white text, dark 0.7 with dark text), so any brand colour keeps AA contrast; radius 6 px for
  controls and 10 px for cards; 14 px body; tabular figures for numbers. `:root, .light` and `.dark` both declare the
  tokens, so a part of a page can preview the other theme or another accent.
- **Brand colour**: `res.company.accentColor` (`#rrggbb`), served with the user's details (`accents`, like
  `groupings`); the shell sets the two variables for the current company. **Settings › Company** (Administrator or
  the new *Company settings* access level, `settings.company`): name, number grouping, brand colour with swatches, a
  hex field, the system picker and previews in light and dark; `GET / PATCH /api/v1/settings/company`.
- **Density** is one setting for the whole app (`data-density`), in the display menu and the list toolbar.
- **Status chip** beside the title with the workflow popover (`StatusChip`), replacing the row of state pills; the
  transition buttons stay as a toolbar.
- **Date field** (`DateField`) replacing the browser's date input: formatted per language, typed (ISO or the
  language's order, Bengali digits), a calendar in a table with keyboard moves; `Popover` added to the primitives
  (from the Radix package already used).
- **Tests**: typed dates, accents, tones and sum labels (unit); the company settings API with its checks and the
  accents in the user's details (integration); E2E: the brand colour applied, the state chip's workflow, a date
  typed and picked by keyboard, lines shown on a saved order.

## Implementation notes (2026-10-29): step 2 — the shell

- **Sidebar** with the company block, search, Home, the apps as disclosure buttons named "<App> app" (distinct from
  screens' own buttons such as Chat or Studio) whose sections are links in the `Main menu` navigation, groups as
  headings, and the user menu at the bottom; collapsed to a rail with `Ctrl+B` (in the shortcuts list) or its
  button, remembered per browser; a Radix dialog drawer below 64 rem. The top app menu and the launcher button are
  gone; the company switcher and the user menu moved into the sidebar.
- **Page bar**: "You are here" (app › section), header items, language, theme; solid background (a backdrop filter
  made the bar the containing block of the chat dock's fixed panels and hid the bell behind them).
- **Deviations from §4.1**, kept for later steps: the bell stays the inbox (no separate Inbox entry yet); apps keep
  their declared order (most used first needs usage counts); the home page's app grid is the "All apps" page until
  step 4 brings the Today home.
- **Escape**: shortcuts already leave keys to open popovers and menus (step 1's fix), so closing the drawer or a
  menu never navigates.
- **Tests**: E2E for the sidebar (an app's sections and the current one marked, the page bar, `Ctrl+B` remembered
  across a reload, the drawer at phone width closing on navigation); the right-to-left test now finds the user menu
  on the right with the sidebar.

## Implementation notes (2026-10-29): step 3 — record pages

- **Header**: title, state chip, a *Read-only* mark, the key facts (`subtitle` hint, else the first many2one, date
  and the total); the form's own breadcrumbs are gone (the page bar's section now links to the list, Back keeps
  the list's state); the first transition is the filled button unless one is marked `primary`.
- **Cards** per group, notebook and lines; loose fields share one. **Read first** is done with quiet inputs (no box
  until hover or focus, an unlayered rule so Tailwind's borders do not win) rather than swapping text for inputs on
  click: the same controls, labels and keyboard order, nothing to activate first.
- **Right rail** with Summary (`summary` hint or the `totals` group, moved out of the main column), Details (the
  magic fields the user may read) and the chatter as the timeline; open by default, toggled and remembered
  (`kosh.rail`); under the record below 80 rem (RFC §4.2 said tabs: one column reads better on phones).
- **View hints** `subtitle` and `summary` on form views, validated against the model's fields.
- **Tests**: E2E for the key facts, the rail's Summary with the total, hiding the rail and its memory; tests that
  read the totals group or the form's breadcrumbs follow the rail and the page bar.

## Implementation notes (2026-10-29): step 4 — lists and Today

- **Saved views as tabs**: above the search, *All* and the saved searches of the model for the current view type
  (the user's own and shared ones, marked), the one matching the search (its order aside) current; more than six go
  into a *More* menu. Saving and the full list stay in the favorites menu; with nothing saved there are no tabs.
- **Floating selection bar**: selected rows show the bar (count, clear, transitions, archive, delete, export) at the
  bottom of the screen with the only shadow besides popovers; the list's toolbar no longer changes.
- **Rows**: Ctrl / Cmd + click, Ctrl + Enter or the middle button opens the record in a new tab (a hover button
  would have added a column the spreadsheet keys count); "duplicate" waits for a copy operation on the server.
- **Empty states** name the list ("No contacts yet") and keep *Create the first one*.
- **Fixed on the way**: the record count followed the fetch, not the data, so going back to a search answered from
  the cache (the *All* tab) kept the previous count.
- **Today**: the date over the greeting; *Needs your attention* as one list — each approval waiting for the user by
  record (*Review*), activities due (overdue or due today; *Open*, *Mark done*), unread mentions (*Open* reads them) —
  with its count; recent records; **your saved views** across apps, one click back to the list, pivot or chart
  with its search (this is §4.4's "pinned": saved views are what users already keep); the apps as a compact grid.
- **Deviations**: the apps stay on Today rather than an *All apps* page (the sidebar lists them too, and a page of
  its own would be one click more); failed payments join *Needs your attention* when the payment app exposes them per
  user.
- **Tests**: E2E for a saved view as a tab (current, back to All with the right count, back again), the floating
  bar (fixed at the bottom; cleared), Ctrl+click opening the record in a new tab, Today's date and saved view.

## Change (2026-10-29, asked by the user): a home page without chrome, an app's own sidebar

- **Home and the user's own pages** (`/`, `/me/<page>`): no sidebar and no page bar — only the account menu in the
  top corner (name and login, the user's pages such as Your profile and API keys, the companies when there are
  several, language, theme and density, Sign out), and a link Home on the user's pages. The notification bell, the
  chat dock are there too (asked the same day; a header item opts in with `home: true`); Studio lives in an app's
  page bar.
- **Inside an app**: the sidebar shows only that app's sections, under its name — a menu that switches to another
  app — with the company, search and Home above; the page bar is back. Ctrl+B, the rail and the phone drawer as
  before.

