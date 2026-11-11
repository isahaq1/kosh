# RFC 0033 — A fluid back-office: faster to read, faster to act, alive

- Status: **Accepted** (2026-11-12, with the proposed defaults: autosave on for masters and drafts, peek by default on desktop)
- Builds on: RFC 0007 (design system), RFC 0010 (palette, shortcuts, live updates, offline), RFC 0018 (sidebar,
  record pages, saved views as tabs, Today), RFC 0022 (tiles, overviews, widgets, guidance)
- Asked for: "the UI should be the most modern and more dynamic than Odoo"

## 1. Why

The back-office is already ahead of Odoo's in structure — one search layer, saved views as tabs, live lists, a
command palette, record pages with a rail, overviews. What it is not yet is **fluid**: most screens still behave
like pages that load, show, and wait. A list click replaces the screen; a save blocks; a status change redraws the
form; a number changes with no sign that it did. Odoo's own web client has the same stiffness, plus its own
(full reloads between apps, modal dialogs for most things, a form that is either "edit" or "view"). Being better
means the common paths take fewer clicks and less waiting, and the screen shows what changed without being asked.

One rule decides what goes in: **it must save a click, save a wait, or show a change** — never decoration.

## 2. What Odoo does, and what we do instead

| | Odoo 18 | Kosh after this RFC |
|---|---|---|
| Open a record from a list | The list is replaced by the form; Back reloads the list | A **peek panel** slides in beside the list: read, edit, run the next step, arrow to the next row — the list stays, its scroll and selection too |
| Save | A button, then a reload of the record | **Autosave** of valid changes after a pause and on leaving a field, with "Saved" beside the title; Undo in the toast; conflicts shown per field |
| A change by someone else | Seen after a reload | The changed field **flashes once** and shows who changed it; lists move the row; kanban cards slide to their column |
| Status changes | The page redraws | The status chip and the buttons **animate to the next step**; the next-step banner (RFC 0022) updates in place |
| Lists | Paged, 80 rows | Already virtual; adds **inline quick-add** as the last row, **quick filters as chips** from any cell (click a value → filter by it), totals that count up when they change |
| Finding things | Search view, menus | The palette (RFC 0010) gains **actions on the current record** ("confirm", "print", "assign to…") and **go to related** ("its invoices") |
| Editing many | Select, then an action menu | Select, then **edit a column for all selected** in place, previewed, undone in one step |
| Empty and loading states | Spinners, "No records" | **Skeletons shaped like the view**; empty states that offer the one useful action (RFC 0018), with sample data on first use |
| Dashboards | Static until reloaded | Tiles and charts **update live** from the same change feed as lists; a tile pulses when its number moves |
| Phones | A reduced layout | Record pages with a **bottom action bar** (the next step always under the thumb), swipe between records, pull to refresh |
| Motion | Almost none | A small **motion system**: 120–200 ms, one easing, only for what moved; off with "reduce motion" |

## 3. Design

### 3.1 The motion and feedback system (`@kosh/ui`)

- Tokens: `--motion-fast` 120 ms, `--motion` 180 ms, `--motion-slow` 260 ms, one easing; every animation uses them
  and is disabled under `prefers-reduced-motion`.
- Primitives, each a few lines of CSS on owned components (no new dependency): `Flash` (a field or cell that
  changed), `CountUp` (a number that moved), `Slide` (panels, cards between columns), `Skeleton` shaped per view.
- **Optimistic updates** in the API client's mutations: the screen changes at once, the server confirms or the
  change rolls back with a toast that says why (the server stays the authority — CLAUDE.md §Coding rules).

### 3.2 The peek panel

- A list, kanban, calendar or Gantt row opens the record in a panel at the right (a sheet on phones); `Enter` /
  click opens it, `Esc` closes it, `J` / `K` or the arrows move to the next record without closing it,
  `Ctrl+Enter` opens the full page.
- The panel is the form's own renderer in a compact layout: key facts, the next-step banner with its button, the
  fields, lines, chatter — nothing a second code path could get wrong. Views opt out with `peek: false`.
- The URL carries the peeked record (`?peek=42`), so a link, Back and a reload land in the same place.

### 3.3 Autosave and conflicts

- A form saves its valid changes 800 ms after the last keystroke and when a field loses focus; the title shows
  *Saving… / Saved / Not saved: 2 fields need a value*. New records save once their required fields are filled.
- Documents past draft keep the explicit **Save** (a posted invoice is not edited by accident): autosave is per
  model, on by default for masters and drafts, declared off with `autosave: false` on the form.
- Compare-and-set stays (RFC 0002): when someone else changed the record, the fields that differ show both
  values with *Keep mine / Take theirs* — per field, not a whole-form error.
- Every autosave is undoable from the toast for 10 seconds (the Undo of RFC 0010).

### 3.4 Lists that act

- **Quick add**: a blank last row on lists whose model has few required fields; `Tab` through, `Enter` saves and
  starts the next. Declared by the list (`quickAdd: ['name', 'partner']`), refused by the server like any create.
- **Click to filter**: hovering a cell offers "only this" / "not this"; the chip appears in the search bar.
- **Edit the selection**: with rows selected, a column header offers "Set for N rows"; a preview lists what
  changes; one request, one audit entry per record, one Undo.
- **Totals** in the footer count up when they change; a row that another user changed flashes.

### 3.5 Live everywhere

- The change feed of RFC 0010 already drives lists, forms and boards. It is extended to **dashboard tiles and
  overview cards** (a card refetches when a model it reads changes, throttled to once a second) and to the
  **record page's tiles** (RFC 0022).
- Presence: the avatars of who else has the record open (already on forms) appear on list rows and kanban cards.

### 3.6 The palette acts on what is open

- With a record open, the palette lists its transitions (those the user may run — the same `…/next` call as the
  banner), its print templates, "Send", "Duplicate", "Archive", and its related tiles as "Go to …".
- `Ctrl+K`, type "conf", `Enter` confirms the order: no reaching for the mouse.

### 3.7 Phones

- Record pages get a bottom bar: the primary next step, then "More". Lists get pull to refresh and swipe actions
  declared by the list (`swipe: { start: 'archive', end: 'assign' }`).

## 4. What it does not do

- No new UI library, no animation library: the primitives are CSS on the components we own.
- No client-side business rules: optimistic updates only predict what the server will answer and roll back when
  it disagrees.
- No theme change: the tokens and the look of RFC 0018 stay.

## 5. Steps

1. **Motion and feedback**: the tokens and primitives; skeletons shaped per view; flashes for live changes on
   lists, forms and boards; count-up totals; reduced motion. (Every screen feels it at once.)
2. **The peek panel** on lists and boards, with the URL, the keyboard and the phone sheet.
3. **Autosave** with the status line, per-field conflicts and Undo; `autosave: false` on posted documents.
4. **Lists that act**: quick add, click to filter, edit the selection.
5. **Live dashboards and tiles**; presence on rows and cards.
6. **The palette on the open record**; the phone action bar and swipe actions.

Each step: typed end to end, unit tests for the pieces, an E2E for the flow, English and Bangla, light and dark,
desktop and phone widths, keyboard and screen reader (every animation has a non-animated equivalent), and the
performance budget unchanged (a 10k-row list still under 300 ms API time; no layout shift from skeletons).

## 6. Open questions

1. **Autosave by default** on masters and drafts — or opt-in per model at first? (Proposed: default on; it is the
   single biggest "feels modern" change, and the Undo and conflicts make it safe.)
2. **The peek panel as the default click** on a list row — or the full page by default with peek on `Space`?
   (Proposed: peek by default on desktop, full page on phones.)
3. Is the order of steps right for you, or should a later step (for instance autosave) come first?

## Implementation notes

- **Step 1 (2026-11-12).** `packages/ui/src/motion.tsx`: `useChanged` / `Flash` (a value that changes for the same
  record flashes once; a recycled list row does not), `CountUp` (exact decimals, the last frame is the exact
  value, a jump under reduced motion), `FormSkeleton`; the `--motion-*` tokens and `kosh-flash` in the styles.
  Wired into list cells, list totals, form fields (the saved value changing) and the form's loading state. Not
  yet: kanban cards sliding between columns, count-up on stat tiles and overview KPIs, skeletons for boards and
  dashboards.
- **Step 2 (2026-11-12).** The peek panel in `packages/ui/src/app.tsx` (`PeekPanel`): a row of a list or a board
  opens the record's own form in a panel beside the view (`?peek=<id>` in the URL, so a link, Back and a reload
  land there); Previous / Next and `Alt+↑` / `Alt+↓` follow the list's order (`onListRemembered` keeps the panel
  in step with the list beside it), `Ctrl+Enter` and a button open the full page, `Esc` closes. On by default on
  screens 1024 px and wider; new records, narrower screens and the other view types open the full page; a browser
  switches it off with `localStorage['kosh.peek'] = 'off'` (the specs written before it run that way). Not yet: a
  switch for it in the user's preferences, the bottom sheet on phones, `peek: false` per view, calendar and Gantt.
- **Step 3 (2026-11-12).** Autosave in `FormView`: a saved record that is not past its first status and is not
  locked saves its changed fields 800 ms after the last change (after any pending onchange), with *Saving… / All
  changes saved / Not saved: N fields need a value* beside the title and **Undo** for ten seconds (the replaced
  values written back). A stale save (someone saved first) no longer blocks the form: their record is taken,
  fields changed only here are saved again, and a field both changed shows *Yours / Theirs* with **Keep mine** /
  **Take theirs**. Narrower than the RFC's design, on purpose: **new records and line edits keep the Save button**
  (a half-typed line or a record without its required fields must not be sent), and there is no save on blur. Not
  yet: `autosave: false` per form, a switch in the user's preferences (a browser turns it off with
  `localStorage['kosh.autosave'] = 'off'`, as the earlier specs do).

