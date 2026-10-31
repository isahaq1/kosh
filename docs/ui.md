# Views and UI

Screens are data (RFC 0004): modules declare views, actions and searches in their manifests; the server checks them
against the models when it starts and serves them per user; `@kosh/ui` renders them (RFC 0007). Custom React code
plugs in by name where metadata is not enough.

## Declaring views

```ts
import { action, form, kanban, list, search } from '@kosh/views';

export const purchase = defineModule({
  // ...
  actions: { 'purchase.action_orders': action(PurchaseOrder, { label: 'Purchase orders', views: ['list', 'kanban', 'form'] }) },
  views: {
    'purchase.order.list': list(PurchaseOrder, {
      columns: ['name', 'vendor', { field: 'amountTotal', sum: true }, { field: 'state', widget: 'badge' }],
      defaultOrder: ['name asc'],
      inlineEdit: ['vendor'],
    }),
    'purchase.order.kanban': kanban(PurchaseOrder, { groupBy: 'state', card: { title: 'name', subtitle: 'vendor' } }),
    'purchase.order.form': form(PurchaseOrder, (f) => ({
      header: { statusbar: 'state', buttons: [f.button('submit', { primary: true, label: 'Submit' })] },
      sheet: [
        f.group('main', ['name', 'vendor', { field: 'amountTotal', widget: 'money' }]),
        f.notebook('tabs', [f.page('lines', 'Lines', [f.lines('lines', ['product', 'quantity', 'priceUnit'])])]),
      ],
      readonlyWhen: { state: { notIn: ['draft'] } },
    })),
  },
  search: {
    'purchase.order': search(PurchaseOrder, {
      fields: ['name', 'vendor.name'],
      filters: { toApprove: { label: 'To approve', domain: { state: 'submitted' } } },
      groupBy: ['state', 'vendor', 'dateOrder:month'],
    }),
  },
});
```

- Field keys are **compile-time checked** against the model handle (`list(PurchaseOrder, { columns: ['nmae'] })` is a
  type error). Transitions, relation paths, line columns, group-by fields and view ids are checked **when the server
  starts**: a broken view stops the server, it never breaks a screen.
- `readonlyWhen` / `visibleWhen` are Shutro domains. The browser evaluates the ones it can (the record's own values;
  `holds()` / `evaluate()` in `@kosh/views`); the server re-checks every write anyway.
- Every node has an id (fields: their key; groups, pages, buttons: the id given), the anchor for extensions.

## Extending another module's view

```ts
viewExtensions: [{
  view: 'purchase.order.form',
  operations: [
    { insertAfter: 'main', nodes: [{ kind: 'component', id: 'approval_panel', component: 'approvals.Panel' }] },
    { setAttrs: 'vendor', attrs: { label: 'Supplier' } },
    { remove: 'notes' },
  ],
}],
```

Operations: `insertAfter`, `insertBefore`, `append` (into a group, a page or a row of tiles), `replace`, `remove`,
`setAttrs`. They apply in module dependency order; an unknown anchor or a duplicate id fails at startup.
`resolveView()` records the module behind every node and the chain of modules that changed the view.

## Widgets, cards and rows (RFC 0022 §3.3)

Widgets by name on any field node (`{ field: 'email', widget: 'email' }`): `badge`, `email`, `phone`, `url`
(links in display), `progress` (0–100 as a bar), `percentage`, `rating` (0–5 as stars), `priority` (a selection as
stars), `color` (a tinted dot), `daysLeft` ("in 3 days", toned), `tags` (many2many chips), `image` and `avatar`
(an attachment of the record: the browser shrinks the picture and makes its 256 px thumbnail, both uploaded;
`GET /api/v1/attachments/:id/download?w=256` serves the thumbnail). A model gives an image field with
`f.many2one('storage.attachment')` and depends on `storage`.

Kanban cards take `image` (a cover), `avatar`, `progress` and `color` (a tinted edge); lists take
`decorations: { danger: { state: 'cancel' }, success: { state: 'done' } }`, a tone for the rows a condition holds
on. Both are checked when the server starts.

## Guidance on a record (RFC 0022 §3.4)

`GET /api/v1/models/:model/:id/next` says what comes next: the transitions from the record's state the user may
run, each `allowed` or not with the guard's `message` (the guard runs read-only; nothing changes). The form shows
it as a banner — "Next step: Confirm" with the button, or "Before Confirm: …" — and lists the required fields
still empty in the right rail. A field's `help` from the model shows under its input; `k.group(id, children,
{ description })` and `k.page(id, label, children, { description })` put a sentence under a section's title.

## Related records on a record page (RFC 0022 §3.1)

```ts
k.stats('related', [
  { id: 'orders', label: 'Orders', model: SaleOrder, where: { partner: { $record: 'id' } }, action: 'sales.action_orders' },
  { id: 'due', label: 'Due', model: AccountMove, where: { partner: { $record: 'id' }, state: 'posted' },
    measure: { sum: 'amountResidual' }, tone: 'warning' },
]),
```

A row of tiles under the title: a count (the default) or a sum / average over another model, filtered by the record
(`$record` names its fields), computed by the server **as the user** (`aggregate`: their rights and record rules
apply), refetched after every save or transition, and a click opens the tile's action with the same filter. An
app declares an empty row (`k.stats('related', [])`) for other modules to fill: `{ append: 'related', nodes:
[stat({...})] }` from `@kosh/views`. The tile's model, measure, filter fields and `$record` fields are checked when
the server starts.

## What the server serves

`GET /api/v1/views/:id` (or `?model=&type=`) returns the view **for the user**: fields they may not read are
removed, field metadata says what they may not write, header buttons for transitions they may not run (model write
access, the transition's `requires` permission) are dropped. Also the field metadata (kinds, labels, options,
targets), the transitions with their source and target states, the allowed operations and the onchange fields.
`GET /api/v1/search/:model` merges every module's search definition and drops options on unreadable fields.
`GET /api/v1/models/:model/names?q=` / `?ids=` is the name search for many2one pickers and display names.

## Search

`@kosh/search` compiles a search state (text facets, filters, group-by, order, a custom domain) to one Shutro domain
and grouping, used by every view: values of one field OR, filters of the same `group` OR, everything else AND; the
action's `domain` always applies; LIKE wildcards typed by users are literal. The state round-trips through the URL
(`?q=`), so deep links, the back button and saved searches work. Favorites are `kosh.saved_view` records, private
or shared, governed by record rules.

## The app

```tsx
import { registerPermissionsWeb } from '@kosh/permissions/web';
import { createDefaultRegistry, createKoshApi, KoshApp } from '@kosh/ui';

const registry = createDefaultRegistry();
registerPermissionsWeb(registry); // each module's web contribution
createRoot(root).render(<KoshApp api={createKoshApi()} registry={registry} />);
```

- Routes: `/login`, `/` (apps), `/:app`, `/:app/a/:action` (list / kanban, `?view=` and `?q=`),
  `/:app/a/:action/:id` (form, `new`). Apps and menus come from the server, filtered per user.
- **Renderers are registered by name**: `registerView('list' | 'kanban' | 'form' | name, Component)`,
  `registerWidget(name or field kind, Component)`, `registerComponent('module.Name', Component)`. Registering an
  existing name throws unless `{ replace: true }`; a view with `component: 'x'` uses the renderer registered as `x`.
- Node components receive the record, the model, the served view, the API, the record `version` (refetch with it)
  and `reload()`.
- **Client actions** open a page instead of a model's views, for screens such as Settings → Apps. The action is
  `{ type: 'client', page: 'settings.Apps', label: 'Apps' }`, and the page is registered with
  `registry.registerPage('settings.Apps', Component)`. Pages receive the API and the action's label, and call their
  module's routes, which check access again. Menus show client actions like any other action.
- App icons: `AppIcon` maps a manifest's `app.icon` (Lucide names: `book`, `wallet`, `shopping-cart`, ...) to an
  icon, in the launcher and the App manager.
- The list virtualizes rows (TanStack Virtual), orders and pages on the server, shows totals for `sum` columns,
  groups one level (expandable), and edits `inlineEdit` columns with compare-and-set. The form runs onchange,
  saves with `If-Match` (a record changed by someone else asks for a reload instead of overwriting), edits lines
  as Shutro x2many commands. The kanban moves cards by drag-and-drop (pointer or keyboard): between state columns
  it runs the transition that leads there, otherwise it writes the field.

## Design system, themes, languages

- Tokens in `@kosh/ui/styles.css` (CSS variables mapped to Tailwind v4 utilities), light and dark themes (system
  default, remembered per browser), logical properties only (`ms`/`me`, `start`/`end`), so right-to-left needs no
  overrides. Components are owned code on Radix primitives (focus, keyboard, ARIA).
- i18next with the `shutro-erp` namespace in English, Bangla and Arabic (Arabic verifies RTL); modules add namespaces
  with `addMessages()`. The language goes to the server as `Accept-Language`, so model labels come translated.
  Numbers, exact decimals (strings, never floats; South Asian grouping for Bangla, Bengali digits optional), dates
  and datetimes (user time zone) are formatted with `Intl`.

### The Workspace visual language (RFC 0018 step 1)

- **Palette**: neutral surfaces and one accent. The accent is the company's **brand colour** (Settings › Company:
  swatches, any hex colour, a live preview in light and dark; indigo by default). Only its hue and chroma are used —
  each theme fixes the lightness, so text on buttons and links stays readable whatever colour is chosen. A part of a
  page can show another theme or accent with the `light` / `dark` classes and `accentVariables(hex)`.
- **Density**: comfortable (default) or compact, in the display menu next to the theme (and the list toolbar);
  `data-density` on `<html>` sets `--control-h` and `--cell-py`, which controls and list cells use.
- **Type**: 14 px body, Inter's open digits; numbers in tables, amounts and decimal inputs use tabular figures.
- **States** are badges in the tone of what they mean, not of their position: done / paid / posted green, waiting /
  partial / to approve amber, cancelled / failed red, sent / in progress blue, draft neutral (`toneOf(value)`). A
  form's state is **one chip** beside the title that opens the workflow (states passed, the current one, the next
  ones the server's transitions allow) instead of a row of every state.
- **Dates** use the app's date field: shown as the language writes them, typed as ISO or day / month / year in the
  language's order (Bengali digits too), or picked on a calendar (arrows, Page Up / Down, Home / End, Enter; the week
  starts as the language says).

### The Workspace shell (RFC 0018 step 2)

- **Sidebar** (`shell/Sidebar.tsx`): the company (its initial and name, or the switcher with several companies),
  search (the palette), Home, then the user's apps — each a button ("Sales app") that opens its sections, groups
  such as Reporting kept as small headings; the current app opens itself, one at a time — and the user menu at the
  bottom. `Ctrl+B` (or the button beside the user) collapses it to an icon rail, remembered per browser. Below
  64 rem it is a drawer behind the menu button; following a link closes it.
- **Page bar**: where the user is (app › section, in the navigation "You are here"), then the screens' header items
  (chat, notifications, Studio), language and theme. It has a solid background: a backdrop filter would become the
  containing box of fixed panels rendered inside it (the chat dock).
- Landmarks: the sidebar is a `complementary` region with the `Main menu` navigation inside; right-to-left puts it
  on the right (logical properties).

### Record pages (RFC 0018 step 3)

- **Header**: the record's name, its state chip, a *Read-only* mark when locked, and a line of **key facts** — the
  view's `subtitle` fields, else the first many2one, the first date and the total. The page bar says where the user
  is (its section links back to the list); the back arrow keeps the list's filters. The first transition is the
  filled button when none is marked `primary`.
- **Sections as cards**: each group, notebook and table of lines is a card; loose fields share one. Saved records
  read first: their inputs show no box until hovered or focused (`.kosh-quiet`).
- **Right rail** (beside the record from 80 rem, under it below; open by default, hidden with the panel button and
  remembered): **Summary** — the view's `summary` fields, else its group named `totals` — **Details** (created / updated
  by and when, company, when the user may read them) and the **timeline** (the chatter).

```ts
form('sale.order', (k) => ({
  subtitle: ['partner', 'dateOrder', 'amountTotal'], // optional: the key facts
  summary: ['amountUntaxed', 'amountTax', 'amountTotal'], // optional: else the `totals` group
  sheet: [/* … */],
}));
```

### Settings and your profile (RFC 0019)

- **Settings** opens on an overview of its sections, grouped (Workspace, Apps; People and Security next), with a
  search over their names, descriptions and keywords. A module adds a section by a menu under
  `settings.group_apps` and, optionally, `settings:overview.about.<action>.description` / `.keywords` messages.
- **Your profile** (user menu, or "Your profile" in the palette): details, language and time zone, default company,
  password, two-factor sign-in with recovery codes, and signed-in devices to sign out.
- **Company** (Settings › Company): name, number grouping, brand colour, and **Details** — every simple field the
  installed apps add to the company (address and contacts from base; tax ids and the like from localizations),
  shown by kind; the chart template is shown, not changed.
- **Companies** (Settings › Companies): every company with its currency and people; *Switch* for one's own;
  administrators add a company (name, currency) — the apps install its defaults, administrators can switch to it at
  once. With several, the sidebar's company block is a switcher, and the palette offers "Switch to …". Pages switch
  through `useKosh().switchCompany`.
- **People** (Settings › People; Administrators and People managers): *Add or invite* — add someone directly with
  a password you pass on (the login may be a plain name, the email optional; `people.created` in the audit log), or
  invite by email (the link is also shown to
  copy; `SHUTRO_ERP_BASE_URL` is the address it points to, `SMTP_URL` sends it), roles per app and company,
  deactivate, a new sign-in link, reset two-factor; invited people choose their password at `/activate`.
- **Layout**: the home page and the user's own pages have no sidebar or page bar, only the notifications, the chat
  dock and the account menu in the top corner (profile pages, companies, language, theme, density, Sign out). Inside an app, the sidebar lists that app's
  sections under its name, which switches apps; the page bar carries the bell, chat, Studio, language and theme.
- **Photos and logos**: Your profile › Change photo; Settings › Company › the logo. `Avatar` and `ImagePicker`
  (`@kosh/ui`) show and choose them — resized to 256 px in the browser before upload.
- **Lists** (RFC 0018 step 4): saved searches are tabs above the search (*All*, then the saved ones; *More* past
  six); selected rows show a floating bar at the bottom; Ctrl / Cmd + click or the middle button opens a record in a
  new tab; an empty list says what it is for.
- **Today** (the home page): the date, *Needs your attention* (approvals by record, activities due, unread mentions),
  recent records, your saved views and the apps.
- **Security** (Settings; administrators): two-factor sign-in required of administrators only or of everyone — the
  people it would stop are named before saving, and they see a set-up page instead of the back-office until they
  do —, the most days a sign-in lasts, and every signed-in device across people with *Sign out*.
- **Audit log** (Settings; administrators and the *View the audit log* permission): filters by kind, person, period
  and words, more on demand, *Export CSV*.
- **Roles & permissions** (Settings; administrators): a role's apps as access levels, Advanced rights per model,
  feature permissions, record rules and field security; every save is reviewed first — who gains and who loses
  what. A person's page shows "What can they do?", computed by the server as them.
- Every package with screens must be listed as a Tailwind `@source` in `apps/web/src/index.css`, or classes used
  only there are not generated.

## Tests

`apps/web/e2e` (Playwright) runs against a real server (`e2e/server.ts`: PostgreSQL via Testcontainers, a contacts
and a purchase app, users with different roles): sign-in with 2FA, apps and menus per role, Bangla, RTL, themes,
list search / filters / group-by / sort / inline edit, form create / transitions per permission / read-only state,
kanban drag-and-drop, the approval flow through the extension-added panel, and axe accessibility checks (no
serious or critical violations) in both themes. Run `pnpm build && pnpm test:e2e`.

## Everyday speed (RFC 0010)

- **Command palette** (`Ctrl+K` / `⌘K`, or the search button in the header): recent records, every menu by name
  ("purchase ord" finds Purchase › Orders), records by name across the apps the user can open
  (`GET /api/v1/find`, within ACL and record rules), and commands (new record here, home, theme, shortcuts).
  Keyboard first: arrows, Enter, Esc; a combobox for screen readers.
- **Shortcuts**: `/` focuses the search box, `N` creates, `Alt+1…9` switches views, `Ctrl+S` saves, `Esc` goes
  back from a form, `Alt+←/→` moves through records, `?` shows the cheat sheet. Views opt in by marking their
  controls (`data-kosh-new`, `data-kosh-save`, `data-kosh-view="1"`, …); the shell listens once.
- **Forms**: a sticky header with breadcrumbs (app › list), the record's position in the list it was opened from
  with ‹ › buttons (same search and order), and a live save state (unsaved changes, saving, all changes saved).
  Leaving a form with unsaved changes asks first, also when closing the tab.
- **Toasts** (`useToast()` from `@kosh/ui`): quiet confirmations after an action or a delete, errors, and an
  optional action such as Undo; announced to screen readers, `F8` jumps to them.
- Recent records are kept per user in the browser (`localStorage`), a convenience only.
- **Lists**: select rows (click, Shift-click for a range, Space on a focused row, the header box for the page);
  the bulk bar archives (with Undo), deletes (hidden at once, run after a few seconds unless undone), exports,
  and runs any transition every selected record allows. Export to CSV or Excel of the current search (or the
  selection) from the toolbar; a column chooser and a density switch, both remembered per user. Skeleton rows
  while loading; an empty state that names the situation and offers "New" when allowed. Every bulk action is
  one request per record to the existing, permission-checked routes.
- **Kanban**: each column shows its count and, when the view names a `total` field, the sum; empty columns fold
  to a strip (click to open) when there are more than three. A move confirms with a toast that undoes it while
  the reverse is possible.
- **Home**: a greeting, the palette's search box, what needs the user's attention (approvals they may decide,
  activities due, with "Mark done"), recently opened records, and app tiles tinted by category with each app's
  summary. `GET /api/v1/routes` tells the page where records of each model open for this user.
- **Installable**: `public/manifest.webmanifest` and `icon.svg` make the back-office an app on phones and
  desktops (the starter project gets both).

## Lists as grids (RFC 0010 Phase B)

Columns named in a list's `inlineEdit` edit in place, and the list behaves like a spreadsheet: arrows move the
active cell, Shift selects a range, Enter or F2 (or just typing) edits, Enter saves and moves down, Tab saves and
moves right. Ctrl+V pastes a block copied from Excel or Sheets from the active cell, turning texts into the
fields' values (numbers, dates, yes/no, choices by label, related records by name) and saying which cells it
skipped; Ctrl+D fills the selection down from its top cell; Ctrl+C copies the selection as tab-separated text;
Delete clears. Every write goes through the ordinary update route with the row's version, and the toast offers
Undo. Press `?` for the keys.

## Offline (RFC 0010 Phase B)

The Vite plugin `koshPwa()` (`@kosh/ui/vite`, in `vite.config.ts`) builds the service worker: the app opens
without the network, a new build offers a reload, and web push works. Screens opened in the last day (apps,
menus, lists, records) show again offline from the device's cache; the cache goes on sign-out and when another
user signs in on the same browser.

A save that cannot reach the server is kept on the device and the form says so. The cloud in the header shows
what waits; when the network is back the changes are sent in order, each with the version the user edited.
A record someone else changed meanwhile is a conflict: the cloud offers to open it, overwrite with the user's
version, or discard; a refused change shows the server's reason with "Retry" and "Discard". Transitions,
uploads and reports need a connection and say so.

## Notifications

With the `notify` module installed (every installation has it), the header shows a bell with the unread count,
live through the gateway. It lists mentions, approvals waiting for the user, decisions on their requests and
activities assigned to them; opening one marks it read and goes to the record. Each kind can be switched off per
user (`PUT /api/v1/notifications/preferences`). Modules add their own header items with
`registry.registerHeaderItem('module.Name', Component)`; the component receives the API. A **personal page** every signed-in user
opens from the user menu, outside any app (API keys): `registry.registerUserPage('module.Name', Page, { label:
'namespace:key' })`, served at `/me/module.Name` with the page props of client actions.

Users with an email address also get each notification by email when `SMTP_URL` is set (`MAIL_FROM` names the
sender; Mailpit in development), in their language, with a link that opens the record (`/open/<model>/<id>`,
resolved to where that user may open it). Each kind can be switched off per channel.

**SMS and WhatsApp** reach a user's phone (`phone` on their user, E.164) through Twilio when
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_SMS_FROM` and / or `TWILIO_WHATSAPP_FROM` are set: the
sentence and the record's link, one delivery per channel. Both channels are opt-in per user and kind (they cost
money): nothing goes out until the user switches a kind on for the channel in their preferences. Another provider
is a `Messenger` (`notifyModule({ messenger })`): one `send` per message, no module changes.

**Notification settings** open from the bell ("Notification settings"): quiet hours and days off, the hour of the
daily summary, the fallback channel, and a table of what reaches the user where (the bell, push, SMS, WhatsApp on or
off per kind; email at once, in the daily summary, or off). Each switch is saved at once; the schedule with Save.

**Quiet hours and email modes** (RFC 0006 part 8). Each user has settings (`GET` / `PUT
/api/v1/notifications/settings`): quiet hours `quietFrom` – `quietTo` (`HH:MM` in their time zone, `tz` on their
user; may cross midnight), whole `quietDays` off, the `digestHour` and the `fallback` channel. During quiet hours web
push, SMS and WhatsApp are held until the quiet period ends, then sent unless the notification was read in the inbox
meanwhile or the user may no longer read the record; the inbox and email are never held. Email per kind is
`instant`, `daily` (in the digest) or `off` (`PUT /api/v1/notifications/preferences` with `mode`).

```sh
curl -X PUT /api/v1/notifications/settings -d '{"quietFrom":"22:00","quietTo":"07:00","quietDays":["fri"],
  "digestHour":"08:00","fallback":"email"}'
curl -X PUT /api/v1/notifications/preferences -d '{"kind":"mention","channel":"email","mode":"daily"}'
```

**The daily digest**: emails set to `daily` wait, and one email goes out at the user's `digestHour` (their time
zone) with every unread notification since the last one, grouped by record with a link to each; notifications read
in the inbox meanwhile, and records the user may no longer read, are left out, and an empty digest sends nothing.

**Fallback channels**: when a delivery cannot reach the user — the push device is gone, there is no email address
or phone number, the email bounced, or the last retry failed — and no other channel reached them, their `fallback`
channel (email by default; `none` switches it off) takes over, once: a fallback never falls back again.

The `notify` module's version is 0.2.0 (the settings, the email mode, held, digest and fallback deliveries):
existing installations run `shutro-erp apps upgrade notify`.

Push notifications reach a device even with Shutro ERP closed: the bell's footer has "Turn on" when the installation
has VAPID keys (`shutro-erp init` writes them to `.env`) and the browser supports push; it asks the browser's
permission, registers the service worker (`/sw.js`, built by `koshPwa()`) and saves the device's subscription for the user.
Clicking a push notification opens the record. "Turn off" removes the subscription on both sides, and the
server drops subscriptions the push service reports gone.

## Chat (RFC 0006 part 6)

With the `messaging` module installed (every installation has it), users with Messaging get the **Chat** app
(`messaging.action_chat`, a client action: `/chat/a/messaging.action_chat`, `Ctrl+Shift+K` from anywhere) and a
**dock** in the header: the unread count, the recent conversations, and small panels at the bottom corner of any
page for the conversations opened from it (full screen on a phone), so a chat goes on while working on a record.
The app has the sidebar (pinned, public channels, private groups, direct messages, unread badges), the
conversation (day separators, grouped messages, reactions, a thread panel, who is typing) and the composer
(mentions, files, `Ctrl+Enter`). Users without Messaging see neither. Everything is live through the gateway
(`record:mail.channel:<id>`: posts, reactions and edits refetch; typing is relayed), the read receipt follows what
is shown, and conversations read offline from the persisted cache (sending needs the network). Direct messages
and mentions reach the bell (`chat.direct`, `mention`); `docs/messaging.md` has the routes and the rules.

## Automation (RFC 0011)

With the `automation` module installed (every installation has it), automation managers get the **Automation**
app: the rules, opened in the **rule editor** (the model and the trigger; the tracked fields to watch and the
from / to values; a condition built row by row, or as a domain; the ordered actions with the model's fields,
transitions, activity types and module actions; who the actions run as; "Test on a record", a dry run that
shows the rendered actions; "Run pending changes now"), and the run log with "Try again" on a failed run.
`docs/automation.md` describes the triggers, the actions and the templates.

## Email (RFC 0006 part 7)

With the `mail` module installed (every installation has it), email managers get the **Email** app: the log of
inbound messages by state, where a message that matched no record or no known sender is attached to a record by
hand, tried again, or discarded. `docs/messaging.md` describes how replies reach the chatter.

## Live screens (RFC 0006 §5, RFC 0010 Phase B)

With the `realtime` module installed (every installation has it), the app keeps one WebSocket per tab to
`GET /api/v1/realtime`, reconnecting with backoff:

- **Lists and boards** refetch when records of their model change, whoever changed them (`useLiveModel`).
- **Forms** refetch their record when someone else saves it. With unsaved changes, the form says so and offers a
  reload instead of overwriting the user's work (`useLiveRecord`). The header shows who else has the record open
  (initials, names on hover).
- The server announces changes after each commit (`announceChange` in the generated API: create, update,
  delete, transitions, import). A module's own routes call it too for records they write. An announcement
  carries the model, the ids, the operation and the user, never the data: clients always refetch through the API,
  which checks access again.
- A browser may subscribe to a model it can read, or to a record its rules let it read; anything else is refused.
- PostgreSQL `NOTIFY` reaches every server of the database, so a cluster needs no extra message bus. The dev and
  preview proxies (`ws: true`) and the starter's nginx forward WebSocket upgrades.

## Not yet

Code splitting per app (ECharts and MapLibre load on demand; the rest is one bundle), `kosh inspect view` on the
CLI. The chatter is `@kosh/messaging/web` (docs/messaging.md). Performance budgets: docs/benchmarks.md.
