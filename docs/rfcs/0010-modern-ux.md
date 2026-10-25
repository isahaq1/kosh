# RFC 0010: A modern, fast, friendly back-office (beyond Odoo 18)

- **Status:** Phase A Accepted (2026-10-19; within RFC 0007, no new subsystem). Phases B and C: Draft, waiting for
  approval.
- **Depends on:** 0004 (views, search), 0005 (reporting), 0006 (chatter, realtime), 0007 (frontend), 0008 (apps)

## 1. Summary

Kosh's back-office is correct, accessible and fast. However, the 2026-10-19 screenshots of the launcher, list, form
and kanban show it is **plain**, and it lacks the everyday power tools people expect after Odoo 17/18, Linear or
Notion. This RFC sets the bar ("faster to use than Odoo for the same task, with fewer clicks and no mouse needed")
and plans the work in three phases.

## 2. What is missing today (measured)

| Area | Today | Odoo 18 | Target |
| --- | --- | --- | --- |
| Navigation | App grid; top menu tabs; back arrow | Command palette (Ctrl+K), breadcrumbs, record pager | Command palette with records, actions and "create"; breadcrumbs; ‹ › pager; recent records |
| Keyboard | None beyond focus order | Alt-key hints, some shortcuts | Shortcuts for everything common, with a `?` cheat sheet |
| Feedback | Inline errors only | Toasts (notifications) | Toasts with **Undo** for archive, delete and stage moves |
| Lists | No selection, no export button, fixed columns | Select, bulk actions, export, optional columns | All of those, plus density and remembered columns per user |
| Forms | No save state, no Ctrl+S, raw numbers while editing | Save indicator, Alt+S | Sticky header with save state, Ctrl+S, leave guard, formatted inputs |
| Kanban | No column totals, no quick create | Both | Both, plus folded empty columns |
| Home | Small tiles on an empty page | Tiles | A home page: greeting, search, "needs your attention" (approvals, activities), recent records, app grid |
| Loading | Spinner | Spinner | Skeletons shaped like the content; empty states that say what to do |
| Mobile | Responsive | Responsive + app | Installable PWA (manifest, icons); offline later |

## 3. Phase A: within RFC 0007, built now

All of Phase A works in English and Bangla (and RTL), in light and dark mode, and with the keyboard and screen
readers. It ships with E2E tests and axe checks. The server stays the authority: the palette, bulk actions and
exports only call existing, permission-checked routes.

1. **Command palette** (Ctrl+K / ⌘K, or the search button in the header):
   - jump to any app, menu or action the user can see;
   - search records by name across the models the user can read, through the existing per-model name search;
   - "New …" for every action whose model the user can create;
   - recent records first;
   - fully keyboard-driven, built as a Radix dialog with combobox semantics.
2. **Keyboard shortcuts**, with `?` showing the cheat sheet:

   | Where | Keys |
   | --- | --- |
   | Anywhere | `Ctrl+K` palette, `/` focus search, `?` cheat sheet |
   | Lists and views | `N` new record, `Alt+1…9` switch view |
   | Forms | `Ctrl+S` save, `Esc` back, `Alt+←` / `Alt+→` previous / next record |

3. **Toasts and Undo:**
   - a quiet toast region (`aria-live`) for saves, transitions, bulk results and errors;
   - Undo on archive and delete runs the inverse request (unarchive, or restore within the toast's lifetime by
     deferring the delete);
   - Undo on kanban stage moves.
4. **Breadcrumbs and record pager:**
   - App › Action › Record in the form header;
   - ‹ 3 / 24 › moves through the records of the list the form was opened from (same search, order and filters);
   - Alt+←/→ does the same from the keyboard.
5. **List power:**
   - checkbox selection (shift-click ranges, select all matching);
   - a bulk bar to archive, delete, export, and run any transition the selection allows;
   - export to CSV and XLSX of the current search, through the existing export route;
   - a column chooser that remembers columns per user and view;
   - comfortable or compact density;
   - the record count in the header.
6. **Forms:**
   - a sticky header with a save state ("All changes saved" / "Unsaved changes" / "Saving…");
   - Ctrl+S to save;
   - a guard before leaving with unsaved changes;
   - number and money inputs formatted while not focused.
7. **Kanban:**
   - column totals for a measure the view names (`sum`), shown in the header;
   - "+" quick create in each column (just the title, then open);
   - empty columns fold to a narrow strip.
8. **Home page:**
   - a greeting;
   - the palette's search box;
   - "Needs your attention": the approval inbox and activities due today, each counted and linked;
   - recent records;
   - larger, coloured app tiles (category colour + icon).
9. **Loading and empty states:** skeleton rows and cards instead of spinners; empty lists explain what the list
   is and offer "New …" when allowed.
10. **Installable PWA:** web app manifest, icons, theme colour and standalone display.

## 4. Phase B: needs approval (new subsystems)

- **Realtime presence and live updates:** "Dina is editing this order"; lists and kanban refresh when someone
  else changes a record (WebSocket gateway of RFC 0006).
- **Notifications centre:** a bell with mentions, approvals and assigned activities; web push.
- **Offline-first PWA:** cached views, a queue of writes, conflict prompts (RFC 0007 §7).
- **Spreadsheet-grade list editing:** keyboard grid editing, paste from Excel, fill down.

## 5. Phase C: needs approval (beyond Odoo)

- **Kosh Studio:** a no-code editor for fields, views, menus and approval policies. It produces a reviewable
  module in `modules/` (code, not database magic), so it stays upgrade-safe, unlike Odoo Studio's database
  customizations.
- **AI assistant (Claude):**
  - natural-language search ("unpaid invoices from Dhaka last month" becomes a search domain);
  - record summaries;
  - drafting replies in the chatter;
  - filling a form from a pasted document.

  It works only through the user's own permissions, and every action is shown before it runs.
- **Automation builder:** "when X, then Y" rules on Shutro events, with a run log.

## 6. Performance budgets (CI)

| Measure | Budget |
| --- | --- |
| Palette opens | < 50 ms |
| First results while typing | < 150 ms |
| Route change to content | < 300 ms on a 10k-row list |
| JavaScript per app chunk | < 250 kB gzip |

## Alignment with CLAUDE.md

- **Business logic:** none in React. Palette results, bulk actions and exports are existing server routes,
  checked per request.
- **Every screen:** works in English and Bangla, light and dark, with the keyboard and a screen reader, and in
  E2E tests.

## Implementation notes (2026-10-25): Phase A, part 1

Built: the command palette (§3.1), shortcuts and the cheat sheet (§3.2), toasts (§3.3, Undo wired for the next
part), breadcrumbs and the record pager (§3.4), and the form's save state, Ctrl+S and leave guard (§3.6).

- `GET /api/v1/find?q=` (server, `Navigation.find`): one request searches every model the user can open from a
  visible menu whose action has a form, at most 5 per model, through the user's own environment (ACL and record
  rules apply); wildcards in the query are literal. Tested in `packages/server/test/views.integration.test.ts`.
- The shell listens for shortcuts once; screens mark their controls with `data-kosh-*` attributes, so no view
  knows about keys and modules get the shortcuts for free.
- The record pager uses the ids of the page the list last showed (in memory, per model); the form reads its
  position and neighbours from there.
- The leave guard is TanStack Router's `useBlocker` reading a ref, so a save that navigates to the new record is
  never blocked by the state it just cleared.
- `apps/web/e2e/productivity.spec.ts` covers the palette (records, menus, recent, axe), the shortcuts, the pager,
  Ctrl+S, the leave guard and a toast.

Next (part 2): list selection and bulk actions with Undo, export and the column chooser (§3.5); kanban totals and
quick create (§3.7); the home page (§3.8); skeletons and empty states (§3.9); the PWA manifest (§3.10).
