# Gap analysis: Projects, services and productivity (Odoo 19 Community vs Kosh)

Scope: Odoo `project`, `project_*`, `hr_timesheet`, `hr_timesheet_attendance`, `sale_timesheet(_margin)`,
`project_timesheet_holidays`, `project_todo`, `event*`, `website_event*`, `calendar`, `calendar_sms`, `mail`
(user-facing), `im_livechat`, `survey`, `rating`, `data_recycle`, `digest`. Kosh: `modules/project`,
`project_account`, `project_portal`, `project_purchase`, `sale_project`, `helpdesk`, `todo` (Focus), `documents`,
`sign`, `event` (Event Hub), `event_account`, `calendar` (Agenda), `approvals`, `packages/messaging`,
`packages/notify`. Not in Odoo Community at all: knowledge, documents, sign, helpdesk, approvals, planning,
appointment, timesheet grid, timer.

Each "missing" was checked by grepping the Kosh module sources (`module.ts`, `index.ts`, `routes.ts`) and the RFC
notes ("Not in this step" / "Next for ..." lists).

## 1. Kosh already ahead

- **Programme and portfolio management** (RFC 0026): programmes, phases, work packages, project types, task
  categories, plans with a business case approved through the Approvals engine, baselines and slip days, change
  requests applied to the baseline, risks (probability x impact) and issues, weekly status reports. Odoo has
  milestones and "project updates" only.
- **Scheduling**: critical path, dependency lag, slip propagation (`schedule/apply`), baseline bars on the Gantt.
  Odoo Community has dependencies but no Gantt (Enterprise) and no critical path.
- **Team and workload**: members with roles, allocation % and dates, over-allocation flagged before save, the
  Workload heat map, hourly cost per member/role, labour cost from timesheets. Odoo Community has none of this.
- **Money and health**: project budget lines, actual (booked via cost centre) vs committed (open POs) vs budget,
  health computed from schedule/milestones/cost with thresholds and a reasoned manager override.
- **Helpdesk** (Enterprise in Odoo): SLA in business hours with pause on "waiting on the customer", assignment in
  turn or by load, merging, canned replies, one-time rating link, AI-drafted replies.
- **Documents and Sign** (Enterprise in Odoo): folders with member access, versions, password and expiring share
  links, file requests with reminders; Sign with ordered signers, OTP codes, sealed PDF with certificate and hashes.
- **Approvals** (Enterprise in Odoo): quorum, send back for changes, deadlines with escalation, delegation (Away),
  decide from email, generic requests with outcomes.
- **Event Hub**: per-ticket and per-event seats with an ordered waiting list auto-promoted, QR tickets and badges,
  scanner/camera check-in once, bilingual confirmation/thanks emails, paid places invoiced.
- **Agenda**: rooms that can never be double-booked (checked across private events), free/busy across people and
  rooms.
- **Focus**: shared to-do lists with privacy rules, checklists with progress, link to any record, Today home card.
- **Notifications**: fallback channels, quiet hours, per-user digest, web push, SMS/WhatsApp adapters, signed reply
  addresses, IMAP + webhook inbound, quarantine page (Odoo has none of fallback/quiet hours).

## 2. Gaps

| Odoo capability | Odoo addon | Kosh status | Value | Size |
|---|---|---|---|---|
| Invoice services from timesheets (service policy: prepaid / fixed / milestones / timesheets; delivered qty from hours; invoice wizard by period) | sale_timesheet | **missing** — `sale_project` only creates tasks/projects from service lines (`serviceTracking`); timesheets have no sale line, no invoice link | high | L |
| Billable vs non-billable timesheet types, employee/role sale rates per project (`project.sale.line.employee.map`), remaining sold hours on SO/task, upsell alert when hours exceed what was sold | sale_timesheet | **missing** | high | M |
| Project profitability panel (revenue from SO/invoices vs timesheet cost, expenses, purchases, margin) | sale_timesheet, project_account, sale_timesheet_margin | **partial** — costs side only (budget, booked, committed, labour); no revenue/margin per project | high | M |
| Project privacy (followers only / all employees / portal), private tasks | project | **missing** — rule `all` gives every Projects user every project | high | S |
| Calendar recurring events (RRULE, edit this / following / all, exceptions) | calendar | **missing** — planned as Agenda step 2 (RFC 0021), not built | high | M |
| Calendar invitations by email with ICS and accept/decline links, change/cancel notices, reminders (email / in-app / SMS alarms before the event) | calendar, calendar_sms | **missing** — no mail/notify calls in `modules/calendar`; respond only in-app | high | M |
| Google Calendar / Outlook two-way sync | google_calendar, microsoft_calendar | **missing** (no CalDAV/ICS feed either) | medium | L |
| Activities rendered on the calendar; "schedule meeting" from an activity/record | calendar (mail_activity) | **missing** — `resModel/resId` link exists, but activities and other apps' dates not on Agenda (step 2) | medium | S |
| Project templates (create project from template with tasks, stages, milestones; task templates) | project (`is_template`, template wizard) | **partial** — generic Duplicate (RFC 0023) only; no template flag or "new from template" with date shifting | high | M |
| Per-project task stages and personal ("My tasks") stages | project | **missing** — `project.task.stage` is global, no `project` field, no personal stage | medium | M |
| Project lifecycle stages (kanban of projects by stage) | project (`project.project.stage`) | **partial** — health and programme hierarchy, but no project stage/status field on `project.project` (phases have status) | medium | S |
| Task review states: In progress / Changes requested / Approved / Waiting / Cancelled | project | **partial** — `done` and `blocked` (waiting on dependencies) only | medium | S |
| Customer ratings on tasks per stage, ratings dashboard per project, satisfaction % | rating, project | **partial** — ratings exist only in Helpdesk | medium | S |
| Project sharing: portal collaborators who edit/create tasks, per-project share wizard | project (collaborators, share wizards) | **partial** — `project_portal` lets customers read projects/tasks and comment | medium | M |
| Per-project email alias (task per email into that project, CC kept) | project (mail.alias) | **partial** — one global `support@` alias to one project | medium | S |
| Custom task properties per project (no-code fields scoped to one project) | project (`task_properties_definition`) | **partial** — Studio adds fields per model, not per project | low | M |
| Timesheets from approved leave and public holidays | project_timesheet_holidays | **missing** | medium | S |
| Timesheet vs attendance comparison report | hr_timesheet_attendance | **missing** (Attendance exists, no bridge) | medium | S |
| Timesheet entry in days / half-days per company, remaining and overtime hours on task | hr_timesheet | **partial** — hour step setting, effective vs planned; no day UoM, no remaining/overtime fields | low | S |
| Timesheet validation / lock of past periods (Enterprise in Odoo, expected by services firms) and a weekly grid with timer | hr_timesheet (Enterprise: timesheet_grid, timer) | **missing** — no validation, lock, grid or timer | high | M |
| Timesheets on Helpdesk tickets (and billing them) | helpdesk_timesheet (Ent.) | **missing** — listed as "not in this step" (RFC 0024) | medium | S |
| Expenses on a project and re-invoiced to the customer | project_hr_expense, project_sale_expense | **missing** — `expense` has no cost centre/project field | medium | M |
| Stock moves and manufacturing orders charged to a project (materials cost, landed costs) | project_stock(_account), project_mrp(_account), project_*_landed_costs | **missing** — only purchase commitments via `project_purchase` | medium | M |
| Skills on tasks / assign by skill | project_hr_skills | **missing** (no skills model in Workforce) | low | M |
| SMS on task/project stage change | project_sms, event_sms | **partial** — SMS adapter exists in notify; no stage-triggered SMS templates (automation could, not shipped) | low | S |
| Public event pages and online registration (website_event), sold via cart/payment (website_event_sale) | website_event, website_event_sale, event_sale | **missing** — RFC 0021 promised "registrations from Sites or the portal"; event_account only drafts invoices | high | M |
| Scheduled event communications (X days before start, after registration, after end; per event type) | event (event_mail) | **partial** — confirmation and thanks only, no reminders or schedule | high | S |
| Registration questions (per event / per ticket) and answers report | event (event_question) | **missing** | medium | S |
| Event templates/types (default tickets, mails, seats), stages kanban, tags | event (event_type, event_stage, event_tag) | **missing** — state field only | medium | S |
| Multi-slot (recurring) events | event (event_slot, v19) | **partial** — sessions inside one event, no per-slot seats/registration | medium | M |
| Booths and exhibitors/sponsors (sell booths, booth map) | event_booth(_sale), website_event_booth*, website_event_exhibitor | **missing** | low | M |
| Talks/tracks with call for proposals, speaker profiles, agenda, live stream and quizzes | website_event_track(_live, _quiz) | **partial** — sessions with room and speaker text | low | M |
| Leads from registrations | event_crm, website_event_crm | **missing** (Pipeline exists, no bridge) | medium | S |
| Surveys, forms, quizzes and certifications (scoring, invite, live session, results analysis), used by Hiring and events | survey, survey_crm, hr_recruitment_survey | **missing** | high | L |
| Website live chat with operators, canned responses, chatbot scripts, transcripts, ratings, chat → ticket/lead | im_livechat, website_livechat, crm_livechat | **missing** — internal chat only | high | L |
| Voice/video calls and screen share in Discuss and in chat | mail (discuss RTC) | **missing** — CLAUDE.md says "later (LiveKit)"; Agenda only stores a `videoUrl` | medium | L |
| Activity plans (a set of activities scheduled together, e.g. onboarding) and chained activities (next activity suggested/triggered) | mail (mail_activity_plan, activity type chaining) | **missing** — `mail.activity.type` has name/icon/days only | medium | S |
| Scheduled messages (send later), pinned and starred messages, link previews, message translation | mail | **missing** | low | S |
| Email composer on records with templates, CC and external recipients; follower subscription by subtype | mail (composer, mail_template, subtypes) | **partial** — comments notify followers (users); inbound replies from partners; no outbound composer to the customer with templates, no subtypes | high | M |
| Data cleaning rules (find stale/old records and archive or delete them on a schedule) | data_recycle | **missing** (automation rules could approximate) | low | S |
| KPI digest emails (daily/weekly company KPIs per user) | digest | **partial** — scheduled reports by email and personal notification digest | low | S |
| Focus: repeating to-dos, reminders, convert a to-do into a project task, "add to Focus" from any record | project_todo | **partial** — listed as next for Focus (RFC 0021) | medium | S |

## 3. Recommended next steps (top 8 by value)

1. **`sale_timesheet`: bill services from time.** Add billable type and sale line on timesheets, service policies
   (prepaid hours, fixed price, milestones, time and materials), per-person/role rates per project, delivered
   quantity from approved hours, upsell alerts, and an invoice-by-period action. Surpass Odoo by only invoicing
   *validated* hours and by showing the draft invoice lines with each timesheet behind them.
2. **Timesheet grid, timer and validation.** A weekly grid (TanStack Table) with a start/stop timer on tasks and
   tickets, manager validation per week with a lock of validated periods, plus leave and holidays auto-filled from
   Workforce and an attendance comparison. Odoo puts all of this in Enterprise; Kosh can ship it in the base app.
3. **Project profitability.** Extend `project_account` with revenue (invoiced and to invoice from orders and
   timesheets) next to labour, expenses, purchases and stock, giving margin and forecast at completion on the
   existing health panel; add `project_expense` (expenses on projects, re-invoiced) and stock/production costs on a
   project's cost centre.
4. **Agenda step 2.** Recurring events with exceptions (this / following / all), email invitations with ICS and
   signed accept/decline links routed through inbound mail, reminders through notify (in-app, push, email, SMS
   respecting quiet hours), activities and other apps' dates on the calendar, then an ICS feed and Google/Outlook
   sync behind an adapter.
5. **Surveys and forms app.** Surveys with question types, scoring and certifications, invitations with one-time
   links, anonymous or identified answers, live sessions, results pivot; bridges into Hiring (interview forms),
   Event Hub (feedback) and Pipeline (leads). Make answers first-class records so they flow into automation and
   reporting, which Odoo's survey cannot.
6. **Public events and online registration.** Event pages in Sites (English/Bangla), registration with questions,
   tickets paid through the Shop cart and payment providers (bKash, SSLCommerz), plus event types with scheduled
   communications (before start, after registration, after end, by email/SMS) and leads into Pipeline.
7. **Live chat and customer-facing chatter.** A website chat widget with operator queues, canned replies, an
   assistant-drafted first answer (RFC 0013) instead of a scripted chatbot, transcripts, ratings, and conversion to a
   ticket or deal; alongside an email composer on any record that writes to the customer with templates, CC and
   partner followers.
8. **Project privacy, templates and per-project workflow.** Visibility per project (members only / internal /
   portal) enforced by record rules, project and task templates with date shifting from a chosen start, per-project
   task stages plus personal stages, task review states (changes requested / approved), task ratings and per-project
   email aliases; extend `project_portal` so collaborators can create and edit tasks.
