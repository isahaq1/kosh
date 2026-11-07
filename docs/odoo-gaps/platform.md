# Platform gap analysis: Odoo 19 Community vs Kosh (Shutro ERP)

Scope: framework capabilities every app uses. Odoo addons read: web, web_hierarchy, web_tour, web_unsplash, mail (+ mail_bot,
mail_group, mail_plugin), auth_* (ldap, oauth, passkey(+portal), password_policy(+portal, +signup), signup, timeout,
totp(+mail, +portal)), base_automation, base_import(+module), base_geolocalize, base_vat, base_iban,
base_address_extended, base_install_request, spreadsheet(+dashboard*), html_editor, portal, iap, sms, snailmail, digest,
google_* / microsoft_* (account, calendar, gmail, outlook, address autocomplete, recaptcha), cloud_storage(+azure, +google),
bus, privacy_lookup, data_recycle, phone_validation, onboarding, barcodes, resource.
Kosh read: packages/* (20 packages), docs/*.md, CLAUDE.md roadmap, docs/comparison.md. Every "missing" below was grepped
in packages/, modules/, apps/ and docs/ (excluding node_modules, dist, playwright-report).

## 1. Kosh already ahead

- **Typed end to end** (model → views → REST → OpenAPI → generated client → UI); views checked against models at start. Odoo: untyped Python/JSON-RPC.
- **Security in one SQL engine** for reads, writes, aggregates, exports, reports; generated 403 test matrix; per-company roles; permission-change preview ("who gains and loses what"); admins' rights withheld until 2FA; last 2FA admin protected. Odoo: groups global, `sudo()` anywhere.
- **API platform**: REST + RFC 9457 + OpenAPI 3.1, idempotency keys, ETag/If-Match concurrency; API keys **with scopes** and service accounts; **OAuth 2.0 provider** (PKCE, rotating refresh tokens, consent, connected apps) — Odoo CE has unscoped API keys and no OAuth server.
- **Webhooks**: signed outbound deliveries with retries, log and replay; inbound endpoints verified, de-duplicated by event id, run as jobs. Odoo: one unsigned webhook action in base_automation.
- **Automation** (vs base_automation): typed module actions instead of Python code in the DB, cron + date + event triggers, dry run, run-now, a run log, rules shipped in modules, rules on any field via change events.
- **Jobs**: transactional outbox and jobs (exactly-once with the transaction, run as the causing user) vs `ir.cron`.
- **Notifications** (vs mail/sms/bus): one pipeline to inbox, email, web push, SMS/WhatsApp with per-user per-kind channel preferences, fallback channels, quiet hours, daily digests, delivery and bounce tracking.
- **Chatter & chat**: change log is the audit trail read as the user (uneditable, field security applied); channels, groups, DMs, threads, reactions, read receipts, typing, presence; inbound email with signed reply addresses, catch-all aliases, quarantine UI.
- **Import** (vs base_import): all errors at once per cell, upsert by any unique key, background runs to 1M rows, rejected-rows file, **undo for 7 days**, saved mappings and module templates.
- **Reporting**: server-side pivot with GROUPING SETS (1M rows ~0.5 s), per-currency totals, period comparisons, streamed exports with an `export` permission and audit, scheduled reports; Chromium PDF with a drag-and-drop designer (vs QWeb/wkhtmltopdf).
- **Studio and AI in the box** (Odoo: Enterprise only): Kosh Studio generates real modules with diff/SQL review and Git PR proposals; AI assistant for NL search, chatter summaries/drafts, records filled from PDFs/images — as the user, budgeted, logged.
- **Approvals engine** shared by all apps (quorum, delegation, deadlines/escalation, decide-by-email) vs per-app logic.
- **Back-office UX**: command palette, keyboard shortcuts, spreadsheet-grade list editing with paste from Excel, toasts with Undo, offline PWA with queued saves and conflict resolution, live lists/forms, saved views as tabs, RTL + dark mode, axe-checked.
- **Settings**: app settings declared in manifests with history per setting, copy between companies, JSON export/import; enforced 2FA policy; audit log filtered and exported.
- **Portal**: portal users can only reach the portal API; documents declared in manifests (only declared fields leave); signature hashes; separate phone-first app.

## 2. Gaps

| Odoo capability | Odoo addon | Kosh status | Business value | Size |
|---|---|---|---|---|
| Rich-text (HTML) editor for `html` fields: formatting, tables, images, links, `/` commands, AI rewrite, paste from Word | html_editor, web_unsplash | **missing** — `html` fields render as a plain `TextWidget` (packages/ui/src/views/widgets.tsx:836); chatter is a small markdown subset | high | M |
| Self-service **password reset** ("Forgot password?") for internal and portal users | auth_signup | **missing** — Login.tsx has login/password/2FA only; reset only by an admin / CLI; portal has invitation activation only | high | S |
| **Sign in with Google / Microsoft / any OIDC** (SSO) | auth_oauth, google_account, microsoft_account | **missing** — RFC 0017 explicitly defers OIDC; no OIDC/SAML code | high | M |
| **Passkeys / WebAuthn** sign-in | auth_passkey, auth_passkey_portal | **missing** — only "later" mentions in docs | high | M |
| **Send document by email** to the customer/vendor: composer with editable, per-model **email templates**, placeholders, CC, attached PDF, sent copy in chatter | mail (mail.template, mail_composer_mixin, mail_render_mixin) | **partial** — portal "announcements" email a fixed message with a link when a record enters a domain; chatter "Send message" goes to user followers; no user-editable email templates, no composer to external partners; automation has no "send email to partner" action | high | M |
| Full **spreadsheet**: ~400 functions, pivot/list/chart insertion from views, global filters, XLSX import/export, real-time collaborative editing; spreadsheet dashboards | spreadsheet, spreadsheet_dashboard* | **partial** — `report.spreadsheet` has ~9 functions + `REPORT()`; dashboards are card grids (good) but no spreadsheet-based dashboards | high | L |
| **Working-time calendars** shared by all apps: hours per weekday, breaks, public holidays per company/country, resource leaves, timezone, flexible hours; used for SLA, planning, MRP capacity, leave days | resource | **partial** — each app has its own: Workforce weekend setting (modules/hr), Helpdesk business hours, Attendance public holidays/rosters, MRP work-centre capacity; no shared `resource` package | high | M |
| **Calendar sync** with Google Calendar and Outlook (two-way), ICS invites/attachments | google_calendar, microsoft_calendar | **missing** — no ICS (`VEVENT`) generation or sync in modules/calendar | high | M |
| **OAuth2 (XOAUTH2) for SMTP/IMAP** with Gmail and Microsoft 365 (basic auth is being disabled by Microsoft) | google_gmail, microsoft_outlook | **missing** — `SMTP_URL` / `IMAP_URL` with password only | medium-high | S |
| **Multiple outgoing mail servers** (per company / from-address filters), per-company alias domains | mail (ir_mail_server, mail_alias_domain) | **partial** — one `SMTP_URL` + `MAIL_FROM` per installation; one inbound domain | medium | S |
| **Password policy** (minimum length/strength meter configurable in settings) | auth_password_policy(+portal,+signup) | **partial** — fixed length check when a manager sets a password; no policy setting, no strength meter, no breached-password check | medium | S |
| **Re-authentication / inactivity lock**: ask for password/2FA again after inactivity or before sensitive actions | auth_timeout | **partial** — 12 h idle session timeout only; no step-up auth for sensitive actions (e.g. role changes, API key creation) | medium | S |
| **Email 2FA codes and trusted devices** ("don't ask again on this device for 30 days"); invite users to enable 2FA | auth_totp_mail | **missing** — TOTP + recovery codes only | medium | S |
| **LDAP / Active Directory** authentication and user provisioning | auth_ldap | **missing** | medium | M |
| Public **self sign-up** (B2C portal / shop accounts) with email verification | auth_signup | **missing** — portal is invitation-only by design | medium | S |
| **Guided tours** and per-app **onboarding checklists** ("set up your company, invite people, configure taxes…") | web_tour, onboarding, mail_bot | **missing** — demo data and next-step banners exist; no tours/checklists | medium | M |
| **Scheduled messages** ("send later"), message **translation**, **link previews**, starred/pinned messages, voice messages | mail (mail_scheduled_message, mail_message_translation, mail_link_preview) | **missing** in chatter and chat | medium | M |
| **Voice/video calls** and screen share in Discuss | mail (discuss, mail_ice_server) | **missing** — CLAUDE.md lists WebRTC/LiveKit as later | medium | L |
| **Activity plans** (a set of activities scheduled at once, e.g. onboarding plan), chained "next activity", activity matrix view across records | mail (mail_activity_plan*, activity view) | **missing** — single activities only; no `activity` view type | medium | S |
| Follower **subtypes** (follow a record only for some events), CC on threads, time-in-stage tracking | mail (mail_message_subtype, mail_thread_cc, mail_tracking_duration_mixin) | **partial** — per-kind notification preferences per user, not per record; no time-in-stage | low-medium | S |
| **Data retention / recycle rules**: find stale records and archive or delete on a schedule | data_recycle | **missing** — also no cleanup of orphaned attachments (docs/messaging.md "Not yet") | medium | S |
| **Privacy lookup / GDPR erasure**: find every record mentioning a person's name/email/phone, anonymise or delete, logged | privacy_lookup | **missing** (RFC 0006 mentions "GDPR erasure" only as a future policy) | medium | M |
| **Address geocoding** (lat/long from address) and **address autocomplete** | base_geolocalize, google_address_autocomplete | **missing** — map view needs coordinates typed by hand | medium | S |
| **VAT number validation** (format checks for ~80 countries + EU VIES online check), IBAN validation | base_vat, base_iban | **partial** — BIN/TIN/GSTIN/PAN validated in l10n_bd / l10n_in only; no generic VAT/IBAN validator | medium | S |
| **Phone validation/formatting** per country (E.164 on save, display formatting, phone blacklist) | phone_validation, sms (blacklist) | **partial** — E.164 normalisation only inside notify's messenger | low-medium | S |
| **Barcode nomenclatures** (GS1 / EAN-13 with embedded weight, price, lot, expiry) and a global scan service (scan anywhere to open a record/product) | barcodes | **partial** — barcode scans in Stockroom counts and Event Hub check-in only; no GS1 parser or global scanner | medium | M |
| **SMS composer and SMS templates** to contacts, SMS in automation, SMS opt-out list | sms | **partial** — SMS/WhatsApp exist only as notification channels to users (Twilio) | medium | S |
| **Email/SMS opt-out (blacklist)** and unsubscribe links on bulk email | mail (mail_blacklist, mail_thread_blacklist) | **missing** | low-medium | S |
| **Languages beyond en/bn without code**: install a language, translation editor for UI strings and field values, PO import/export | base (ir.translation, res.lang) | **partial** — module dictionaries in code (`pnpm i18n:extract`); translated fields exist in Shutro; no in-app language install or translation editor | medium | M |
| **Mail client plugins** (Outlook / Gmail add-ins: create leads/tickets, log emails to records) | mail_plugin | **missing** | medium | M |
| Captcha on public forms (reCAPTCHA / Turnstile) | google_recaptcha, website_cf_turnstile | **partial** — honeypot + rate limiting on Sites forms | low | S |
| Attachments in Azure Blob / Google Cloud Storage natively, with migration between stores | cloud_storage, cloud_storage_azure, cloud_storage_google, cloud_storage_migration | **partial** — S3-compatible + local dir, pluggable `Storage`; no Azure adapter or store-to-store migration | low | S |
| Periodic **KPI digest** emails to managers (company KPIs, configurable) | digest | **partial** — scheduled reports by email and notification digests cover most of it; no ready-made KPI digest | low | S |
| **Mailing lists** (email groups with moderation) | mail_group | **missing** | low | M |
| **Postal letters** (send invoices by post) | snailmail | **missing** | low | S |
| Users **request an app install** from admins | base_install_request | **missing** | low | S |
| Paid in-app services (credits, partner enrichment, OCR) | iap | not applicable — Kosh's AI assistant uses budgets instead | low | — |

## 3. Recommended next steps (top 8 by value)

1. **Rich-text editor (`@kosh/editor`)** — a TipTap/ProseMirror editor for every `html` field and the chatter, with server-side allow-list sanitising, tables, images stored as attachments, mentions, `/` commands and the assistant's rewrite; surpass Odoo with Bangla-aware input, accessibility checks and collaborative cursors over the existing realtime gateway.
2. **Self-service account recovery** — "Forgot password?" for back-office and portal (one-time signed link, rate limited, audited, sessions revoked), plus a configurable password policy with a strength meter and a breached-password check; a small step that removes a daily support burden.
3. **Single sign-on** — OIDC client (Google, Microsoft Entra, Okta, Keycloak) with domain-based auto-provisioning into roles per company, then SAML; go past Odoo by also making Kosh an OIDC provider on top of the existing OAuth 2.0 server.
4. **Email composer and templates** — user-editable, per-model email templates (typed placeholders validated against the model like print layouts, en/bn variants), a "Send by email" composer with the document PDF, CC and the portal link, an automation action "email the partner", and SMS templates on the same engine; sent copies and delivery status in the chatter.
5. **Passkeys + trusted devices** — WebAuthn registration and passwordless sign-in for users and portal users, "remember this device" for 2FA, and step-up re-authentication before sensitive actions (roles, API keys, payments) — stronger than Odoo's auth_passkey + auth_timeout split.
6. **Shared working-time calendars (`@kosh/resource`)** — one model of working hours, breaks, public holidays per country (seeded by localizations, e.g. Bangladesh) and resource leaves, consumed by Helpdesk SLAs, Workforce leave, Attendance, Production capacity and Project scheduling, replacing today's per-app settings.
7. **Calendar and mailbox integrations** — two-way Google Calendar and Microsoft 365 sync plus ICS invites for Agenda events, and XOAUTH2 for SMTP/IMAP (Gmail, Microsoft 365) with multiple outgoing servers per company; built on the Integrations platform's OAuth plumbing.
8. **Spreadsheet depth** — a real spreadsheet engine (e.g. HyperFormula, GPL-compatible licence check) with insertable live pivots/lists/charts from any view, global filters, XLSX round-trip and multi-user editing, and spreadsheet-based dashboards — all queries still under the viewer's record rules, which Odoo's spreadsheets do not guarantee for shared dashboards.

Honourable mentions (cheap, medium value): data retention rules + GDPR lookup/erasure on the audit trail; geocoding + address autocomplete for the map view; generic VAT/IBAN/phone validators; guided tours and per-app onboarding checklists; activity plans.
