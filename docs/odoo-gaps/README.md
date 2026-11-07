# Kosh against Odoo 19 Community — the gaps, ranked

Compared on 2026-11-07: the 389 non-localization addons of `pg-odoo/odoo/addons` against Kosh's 55 modules and its
packages, one domain per file. Each "missing" was checked by searching Kosh's sources. The domain files list where
Kosh is already ahead, every gap with its value and size, and the next steps:

[accounting](accounting.md) · [sales, CRM, website, shop](sales.md) · [supply chain and production](supply.md) ·
[HR](hr.md) · [projects and productivity](projects.md) · [point of sale](pos.md) · [platform](platform.md)

## Where Kosh is ahead already

Enterprise-only in Odoo, in Kosh: payroll (with Bangladesh rules), fixed assets, budgets with commitments, Helpdesk,
Documents, Sign, Approvals, programme management (plans, baselines, critical path, health), BOM versions. Beyond
Odoo: posted entries locked by the database, exact units, replenishment explained in words, trade finance, VDS / TDS
and Mushak / GSTR, local payment providers and couriers with cash on delivery, offline sales accepted once, geofenced
attendance, meter-based maintenance with reliability, the automation builder, Studio, the AI assistant.

## Gaps that cut across apps (do these first: several apps wait on each)

| # | Gap | Who waits | Size |
| --- | --- | --- | --- |
| 1 | **Pricelists** — by customer, quantity, dates, currency; who may change prices | Sales, Shop, Counter, Purchase (vendor prices) | M |
| 2 | **Product variants and attributes** — size × colour grids on lines | Sales, Purchase, Stockroom, Shop, Counter; garments | L |
| 3 | **Loyalty** — points, gift cards, wallets, promotions, buy X get Y (one engine) | Sales, Shop, Counter | M |
| 4 | **Partial invoicing** — down payments, invoice by delivered / received quantity, bill control | Sales, Purchase, Accounting | M |
| 5 | **Email composer and templates** — send a document with its PDF, editable templates, "sent" | every document | S–M |
| 6 | **Rich-text editor** for `html` fields and the chatter | every app | M |
| 7 | **Shared working calendars** — one model for weekends, hours and holidays | Workforce (holidays in leave), Helpdesk, Attendance, Production | M |
| 8 | **Surveys and forms** | Hiring, Events, Pipeline, Helpdesk ratings | M |

## The most valuable gap in each app

| App | Gap | Size |
| --- | --- | --- |
| Accounting | Bank statements with matching and reconciliation rules; then fiscal positions, credit limits and follow-ups | L |
| Purchase | Vendor price lists (codes, price breaks, lead times), agreements and quote comparison | M |
| Stockroom | Returns linked to their transfer; landed costs (with Trade Finance); barcode operations and labels | M |
| Production | Lots and serials on what is made, with traceability | M |
| Sales / Pipeline | Deal → quotation, teams and assignment, quotation templates | M |
| Workforce | Leave allocations, balances and accruals; holidays not charged as leave; cancelling approved leave | M |
| Hiring | Careers page with an apply form, candidate emails, interviews booked in Agenda | M |
| Projects | Billing from timesheets; the timesheet grid and timer; revenue and margin per project | L |
| Agenda | Recurring events, invitations with ICS, Google / Outlook sync | M |
| Counter | Card and QR payments; restaurant (tables, kitchen); receipt printers | L |
| Sites / Shop | Live chat into deals and tickets; customer accounts; reviews | M |
| Platform | Password reset, sign-in with Google / Microsoft / OIDC, passkeys | M |

## Proposed order

1. Approvals matrix (RFC 0027 — in progress).
2. Commercial core: pricelists, partial invoicing, deal → quotation, quotation templates, credit limits.
3. Accounting: bank statements and reconciliation rules, fiscal positions, follow-ups, sending documents (composer).
4. Products: variants and attributes, vendor price lists, returns, landed costs.
5. People: leave allocations / accruals / holidays, onboarding, careers page.
6. Projects: billing from timesheets, the timesheet grid, profitability.
7. Counter: card / QR payments (already planned), restaurant, loyalty (shared with Sales and Shop).
8. Platform: rich text, password reset, OIDC / passkeys, shared calendars, surveys.

Each becomes an RFC before code, as CLAUDE.md asks.
