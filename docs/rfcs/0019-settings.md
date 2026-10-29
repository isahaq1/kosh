# RFC 0019: Settings — people, roles, companies and your profile

- **Status:** Accepted (2026-10-29)
- **Depends on:** 0003 (permissions), 0008 (Settings app, App manager), 0015 (portal invitations), 0017 (API keys),
  0018 (Workspace UI)
- **Asked for (2026-10-29):** "user manage, company, role permission", "user profile, switch company and others",
  "settings should be better than Odoo settings".

## 1. Summary

Turn the Settings app into the one place where an installation is run: **People** (users invited by email, their
roles per company, deactivation, two-factor resets, "what can this person do?"), **Roles & permissions** (app access
as toggles, with the full model / field / record / action matrix under *Advanced*, and a preview of who gains or
loses what before saving), **Companies** (several companies, created and switched without leaving the page),
**Security** (the audit log, sessions, the two-factor policy), the **apps' own settings** in the same place, and a
**profile** for every user (name, contact, language, time zone, password, two-factor, sessions, API keys,
notification preferences). Every page is searchable, permission-checked on the server and audited.

## 2. How Odoo does it, and its weaknesses

- **One long settings page** of checkboxes from every installed app, mixing "install a module" with "change a
  value"; scrolling and the search box are the only navigation.
- **Users**: a form with one dropdown or checkbox per app and a *Technical* tab only in debug mode; invitations are
  emails with a reset link; no clear view of what a user can actually do across companies.
- **Access rights** (models, record rules) live in the *Technical* menu behind debug mode, as raw records; changing
  a group shows nothing of its effect before saving.
- **Companies** and their switch are scattered (the company form, the top-bar switcher); a new company starts empty.
- **Profile** ("Preferences") is a small dialog; sessions and devices are not listed.

## 3. Design

### 3.1 The Settings app

```
┌ Settings ──────────────┬───────────────────────────────────────────────────┐
│ ⌕ Search settings      │ People                                [Invite]    │
│ WORKSPACE              │ ⌕ name, email, role…   Active ▾  Role ▾           │
│   Company              │ ┌──────────────────────────────────────────────┐ │
│   Companies            │ │ ● Dina Rahman   dina@…  Accounting manager…  │ │
│ PEOPLE                 │ │   2FA ✓ · last seen 5 min ago     [⋯]        │ │
│   People               │ │ ○ Bob Khan      invited · expires in 6 days  │ │
│   Roles & permissions  │ └──────────────────────────────────────────────┘ │
│ SECURITY               │                                                   │
│   Audit log · Sessions │                                                   │
│ APPS                   │                                                   │
│   Apps · Accounting ·  │                                                   │
│   AI assistant · …     │                                                   │
└────────────────────────┴───────────────────────────────────────────────────┘
```

- **Left list of sections** in four groups (Workspace, People, Security, Apps), each section a page; the sections
  a user may not open are not listed (and the server refuses them).
- **Search settings**: every section and setting declares its words (`Number grouping`, `lakh`, `two-factor`…);
  results jump to the setting and highlight it.
- **Apps' settings** are sections contributed by modules (`registry.registerSettingsSection`): Accounting, the AI
  assistant, notifications, portal… — no more settings pages hidden inside each app (they stay reachable there
  too).
- The App manager is the *Apps* section; installing stays separate from changing values.

### 3.2 People

- A list with status (active, invited, deactivated), roles, two-factor, last activity; filters by status, role and
  company; bulk deactivate.
- **Invite**: name, email, roles per company → an expiring activation link (7 days) emailed when mail is set up,
  and always shown to copy; resend or revoke. Logins are emails by default.
- **A person's page**: details; **roles per company** (checkboxes per company, the company's default); special
  grants with reasons and expiry (RFC 0003); **What can they do?** — the effective access from the server
  (`/admin/users/:id/effective`): apps, per-model rights, hidden and read-only fields, action permissions;
  **reset two-factor**, **deactivate** (sessions revoked at once) and **reactivate**; recent activity from the
  audit log.
- Safeguards from CLAUDE.md: the last active administrator cannot be deactivated or lose the role; administrators
  keep mandatory two-factor; everything is audited.

### 3.3 Roles & permissions

- A list of roles with how many people hold each, the apps they open, *Administrator* marked.
- **A role's page, simple first**: per app, its access level as a choice (*No access · User · Manager …*, from the
  modules' declared levels); roles it includes (inheritance); who holds it.
- **Advanced** (same page, folded): the model rights matrix (read / create / write / delete / export / import per
  model, grouped by app), record rules with the condition builder (RFC 0011's), field security (hidden / read-only),
  action permissions (confirm, approve, post…).
- **Preview before saving**: "3 people gain *Post entries*; Bob loses *Export contacts*" — computed by the server
  from the change, shown with Save.
- New roles from scratch or **copied** from another.

### 3.4 Companies

- **Company** (today's page): name, number grouping, brand colour; plus address, tax ids, logo, currency (read-only
  once there are entries), fiscal year start, localization.
- **Companies**: the list, **New company** (name, currency, country → its localization when installed, defaults
  installed by the apps as `installDefaults` does), who works in each (per-company roles).
- **Switching**: the sidebar's company block opens a switcher with every allowed company and their colours,
  searchable, also from the palette ("Switch to Padma Exports"); the choice is remembered per user (`res.users.company`).

### 3.5 Security

- **Audit log**: the events (sign-ins, permission changes, exports, sensitive actions) with filters by kind, person,
  record and period, and export.
- **Sessions**: active sessions across people (device, address, last use) with revocation.
- **Policy**: two-factor required for everyone or for administrators only (the default), session lifetime.

### 3.6 Your profile (`/me/profile`, from the user menu)

- Name, email, phone, language, time zone, default company; password change; two-factor (set up, recovery codes,
  turn off when allowed); **your sessions** (this device marked; sign out the others); API keys (moved here, RFC
  0017); notification preferences (the existing dialog, as a section).

## 4. Server

- **Users** (`@kosh/settings`, People managers: Administrator or a new *People manager* access level
  `settings.people`): `GET /api/v1/settings/people`, `POST …/people/invite`, `PATCH …/people/:id` (name, email,
  active), `POST …/people/:id/reset-2fa`, `POST …/people/:id/invitation` (resend), activation at
  `POST /api/v1/auth/activate` (an internal-user twin of the portal's). Roles and grants use the existing
  `/api/v1/admin/…` routes (RFC 0003).
- **Role preview**: `POST /api/v1/admin/roles/:code/preview` with the proposed change → the effective differences per
  holder, computed by Shutro as each user (no write).
- **Companies**: `GET / POST /api/v1/settings/companies` (creation runs the apps' company defaults in one
  transaction); the company page grows its fields.
- **Profile and sessions**: `PATCH /api/v1/auth/me` (name, email, phone, lang, tz, default company);
  `GET /api/v1/auth/sessions`, `DELETE /api/v1/auth/sessions/:id`; for managers `GET /api/v1/settings/sessions`.
- **Settings search** is client-side over the sections' declared words (no server index needed).
- Everything goes through Shutro (models, record rules, audit); nothing bypasses the permission system.

## 5. Delivery plan (each step reviewed, with screenshots)

1. **The Settings shell and your profile**: the sectioned layout with search, the apps' sections registry; the
   profile page with sessions; the company switcher in the sidebar and the palette.
2. **People**: the list, invitations and activation, a person's page with roles per company, grants, deactivation,
   two-factor reset, "What can they do?".
3. **Roles & permissions**: the role list and page (simple), Advanced (matrix, rules, fields, actions), the preview.
4. **Companies and Security**: new companies with their defaults, the company page's fields; the audit log and
   sessions pages; the two-factor policy.

## 6. Open questions

1. **Invitations**: email the link when mail is set up and always show it to copy (proposed), or email only?
2. **Who manages people**: Administrators plus a *People manager* access level (proposed), or Administrators only?
3. **Order**: this RFC before RFC 0018 step 4 (lists and the Today home) (proposed), or after?

## Decisions (2026-10-29)

1. **Invitations**: emailed when mail is set up, and the link always shown to copy.
2. **Who manages people and roles**: Administrators, and a *People manager* access level.
3. **Order**: this RFC before RFC 0018 step 4.

## Alignment with CLAUDE.md

Permission-based everywhere (the server checks each route; sections the user may not open are not listed); the
Administrator bypass stays the single explicit one, with the last-administrator and two-factor safeguards; every
change audited; no business logic in React (previews and effective access are computed on the server); English and
Bangla, light and dark, keyboard and screen reader, desktop and phone.

## Implementation notes (2026-10-29): step 1 — the Settings home, your profile, switching companies

- **Overview** (`settings.Overview`, the app's first entry): every section the user may open in its group — menus
  `settings.group_workspace` (Company), `settings.group_apps` (App manager, the AI assistant; modules add theirs
  there), People and Security in the next steps — each with what it is for, and a search over names, descriptions
  and keywords (`settings:overview.about.<action>` messages; "lakh" finds Company). The sidebar shows the same
  groups as headings. Searching inside a section's fields is left for later.
- **Your profile** (`/me/settings.Profile`, first in the user menu; in the overview under *You*): details (name,
  email, phone), language and region (the app follows the language saved; time zone; the default company when there
  are several), password, two-factor sign-in (set up with the key and an authenticator link, recovery codes shown
  once, turned off with the password and a code), signed-in devices (browser and system from the user agent, address,
  last activity; sign one out or all the others). Server: `GET / PATCH /api/v1/auth/profile`,
  `GET /api/v1/auth/sessions`, `DELETE /api/v1/auth/sessions/:id`, `POST /api/v1/auth/sessions/sign-out-others` —
  sessions only (API keys are refused), CSRF-checked, audited (`auth.profile_changed`, `auth.session_revoked`).
- **Switching companies**: the sidebar's company block is a menu of the user's companies (the current one checked),
  and the palette offers "Switch to …" for each other company; "Your profile" is a palette command too.
- **Found on the way**: the web app's Tailwind sources missed eight packages' screens (Settings, Integrations,
  Import, Automation, Mail, Accounting, both localizations), so their unique classes were never generated; the
  sidebar's group headings failed the contrast check (axe) and use the full muted colour now. The starter project
  scans the whole bundle and was not affected.
- **Tests**: profile and sessions on real PostgreSQL (checked values, other companies refused, one device and all
  the others signed out, API keys refused, audit); E2E for the overview's search, the profile's details, this
  device, and two-factor on and off with codes from the shown key.

## Implementation notes (2026-10-29): step 2 — People

- **`settings.invitation`** (private): a hashed one-time token, its expiry (7 days), when it was used, who invited.
  **People manager** (`settings.people`) is a new access level of the Settings app.
- **Routes** (`/api/v1/settings/people…`): the list (search; active, invited, deactivated; portal users and service
  accounts left out) with roles named by their app level ("Purchase · Manager"), two-factor, last activity; the
  catalogue (apps and their access levels, technical modules apart, roles, companies, administrator groups); a
  person with their recent audit events; invite (the login is the email, roles per company, a password nobody knows
  until the link is used, the link emailed after the commit when mail is set up and always returned); change name,
  email, active (deactivation revokes sessions and voids open invitations; not oneself); replace roles (the
  person's companies follow them); a new link; reset two-factor (sessions revoked). Activation at
  `POST /api/v1/auth/activate` (12 characters at least; used, replaced or expired links are 410).
- **People managers** cannot give administrator roles, change their own roles, or change an administrator's account
  (403); Shutro's constraint keeps the last active administrator for everyone. Every change is audited
  (`people.invited`, `people.activated`, `people.deactivated`, `people.reactivated`, `people.changed`,
  `security.assignment`, `auth.2fa_reset`).
- **Screens**: Settings › People (search, status filter, the list), the invite dialog (roles per app as one choice
  each — *No access · User · Manager…* —, per company when there are several, technical access folded, other roles
  as checkboxes; the link with Copy), a person (details, roles, a new link, two-factor reset and deactivation with a
  confirmation, reactivation, recent activity), and the back-office's `/activate` page that signs the person in.
- **Deferred to step 3**: "What can they do?" (the effective access per model and field) joins the role pages,
  which already need the server's effective computation; special grants stay in the permissions API.
- **Tests**: on real PostgreSQL — the catalogue, an invitation emailed and returned, activation once (short
  passwords, reuse refused), roles replaced, the manager's limits, deactivation signing out, a new link voiding the
  old one, two-factor reset, others refused, the audit kinds. E2E: invite with a role, open the link in another
  browser, choose a password, see only that app; deactivate.

## Implementation notes (2026-10-29): step 3 — Roles & permissions

- **Shutro request #30** answered in Shutro (`5e31959`, chosen over reading Shutro's tables): `securityAdmin.describe()`
  returns the runtime roles, model access, record rules, permission grants and field groups as stored, read
  through the transaction, for administrators. Shutro ERP needs a Shutro release with it before its next package.
- **Server** (`@kosh/permissions`, administrators only): the roles list counts holders;
  `GET /api/v1/admin/roles/:code` gives a role in full — label, access levels, holders, per model the rights it
  gets from code and the roles it includes (locked) and its own runtime grants, feature permissions (locked or
  its own), its record rules and field security, the models to choose from (apps first);
  `POST …/roles/:code/preview` takes the role's proposed state and returns, per holder, the app access levels and
  feature permissions they gain or lose — counting their other roles in any company — and the model rights that
  change. Nothing is written. The effective access route now names models and permissions.
- **Screens**: Settings › Roles & permissions (search; all, custom, built-in; the apps a role opens; holders), a
  role (name; per app one access level for custom roles, fixed for built-in ones; Advanced — rights per model with
  the locked ones ticked and greyed, feature permissions, record rules with a JSON condition, field security — then
  *Review the changes* with the preview and *Save*; delete custom roles), a new role from scratch or copied, and
  "What can they do?" on a person (administrators). Record rules use a JSON condition for now; the automation
  condition builder comes to them later.
- **Tests**: on real PostgreSQL — a runtime role in full (locked and own rights, holders, counts), the preview
  (gains for everyone, a loss only for those without another role giving it, nothing saved), administrators only;
  in Shutro — `describe()` inside the transaction and refused to others. E2E: a new role opening Contacts, saved
  after its preview; given to Bob in People, "What can they do?"; the next change previewed as a gain for him.

## Implementation notes (2026-10-29): step 4, part 1 — Companies

- **The company's fields**: base's `res.company` gains address (street, city, postal code), email, phone and website
  (`l10n_in` declared street / city / zip itself; it now takes them from base). The Company page's **Details** are
  every stored simple field (text, long text, number, yes / no, choice) of `res.company` the generated API serves,
  minus those with controls of their own — so a localization's BIN or GSTIN appear without code in Settings. The
  chart template is shown, not changed (its installer sets it). The server accepts only offered fields with values
  of their kind; Shutro checks the rest.
- **Companies**: `GET /api/v1/settings/companies` (Administrator or Settings / Company) lists every company with its
  currency, its people (internal users who may work in it), whether it is the current one and whether the person
  can switch to it; `POST` (administrators) creates one with its currency, adds it to every administrator's and the
  creator's companies, audits it (`settings.company_created`), and after the commit runs the apps' company
  defaults (`installDefaults`, each app in turn, as for the first company). Country and localization at creation
  wait for the localization installer to run per company (RFC 0016); logo and fiscal year start come with them.
- **Screens**: Settings › Company with Details; Settings › Companies (switch, New company). The UI context gains
  `switchCompany` so pages can switch as the sidebar does.
- **Tests**: on real PostgreSQL — details offered, saved, emptied and checked; companies listed with their people,
  creation refused to non-administrators and checked, the new company in the administrator's companies and not in
  others'. E2E: a detail saved; a new company created, switched to and back.

## Implementation notes (2026-10-29): step 4, part 2 — Security

- **The policy** (`auth.policy` in base, one row, private): two-factor sign-in required of `administrators` (the
  default, as before) or `everyone`, and `sessionDays` (1–90, empty: the server's `lifetimeMs`) for new sign-ins.
  The auth service reads it (cached like sessions, forgotten on change). With *everyone*, a session without 2FA
  carries `twoFactorMissing`; the server's request hook then allows only `/api/v1/auth/…` and answers
  `403 two-factor-setup-required` elsewhere; `me` says `twoFactorSetupRequired`, and the shell shows a set-up page
  (key, code, recovery codes once) instead of the back-office. Turning 2FA off is refused (`409`) while the policy
  stands. API keys are not sessions, and portal users (all groups external) are not the company's people: neither
  is concerned.
- **Routes** (`@kosh/settings`, administrators only): `GET / PATCH /api/v1/settings/security` (the policy and the
  people without 2FA; audited `security.policy`); `GET /api/v1/settings/sessions` (every active, verified session
  with the person, device, address and last use; the caller's own marked) and
  `DELETE /api/v1/settings/sessions/:id` (audited `security.session_revoked`; one's own session is refused — sign
  out instead). The audit route (`@kosh/permissions`) gains filters by person, record, period and words, the
  actors' names, and `format=csv` (an audited `data.export`, cells guarded against spreadsheet formulas).
- **Screens**: Settings › Security (the policy with the people it would stop named before saving; signed-in devices
  searched and signed out) and Settings › Audit log (filters, more on demand, Export CSV), under a Security group
  visible to administrators.
- **Not in this step**: sessions for People managers (administrators only for now), a per-company policy, and
  password rules; the audit log's retention.
- **Tests**: on real PostgreSQL — the default policy, *everyone* blocking all but the sign-in routes until 2FA is
  set up and refusing to turn it off, the lifetime of new sign-ins, checked values, administrators only; sessions
  listed, signed out (the person's token stops working), one's own refused; the audit filters, names and the CSV
  with its own event. E2E: *everyone* saved with the people named, a person's set-up page then the back-office, back
  to the default; their device signed out from Security; the audit log filtered and exported.
