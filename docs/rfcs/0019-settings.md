# RFC 0019: Settings — people, roles, companies and your profile

- **Status:** Proposed (2026-10-29)
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

## Alignment with CLAUDE.md

Permission-based everywhere (the server checks each route; sections the user may not open are not listed); the
Administrator bypass stays the single explicit one, with the last-administrator and two-factor safeguards; every
change audited; no business logic in React (previews and effective access are computed on the server); English and
Bangla, light and dark, keyboard and screen reader, desktop and phone.
