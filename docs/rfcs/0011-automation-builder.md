# RFC 0011: Automation builder

- **Status:** Accepted 2026-10-26 with the proposed answers (run as the actor by default, templates without logic, managers = administrators); step 1 implemented (`@kosh/automation`, `docs/automation.md`)
- **Depends on:** 0001 (manifests), 0003 (permissions, approval policies), 0004 (search domains), 0006 (chatter,
  notifications, outbox and jobs), 0008 (apps); Shutro RFC 0013 (audit trail), 0018 (outbox events, jobs)

## 1. Summary

Administrators write **"when X, then Y" rules without code**: when a record is created, changes, moves to a state,
or reaches a date, or when an app emits an event, then set fields, run a transition, plan an activity, notify
someone, post a note, create a record, call a webhook, or run an action a module declares. Rules are records,
edited in an **Automation** app, evaluated by a subscriber of Shutro's audit trail and outbox (so a rule fires
exactly once per change, after it committed, whoever made it: the UI, the API, an import, another module), and
every run is logged with what it did or why it failed. Studio (the next RFC) and the AI assistant build on the same
engine: Studio to ship rules as a module, the assistant to draft them.

## 2. Problem

Every installation has rules of its own: "a purchase order over 50 000 from a new vendor gets an activity for the
buyer", "an invoice unpaid 7 days after its due date notifies the salesperson", "a task moved to Done posts a note
on its project". In Odoo these are *automated actions* (server actions with Python in the database) or paid Studio
customizations: powerful, but they run as the superuser, are invisible in version control, break on upgrades, and
have no run log. The alternative today in Kosh is code: a module with an outbox subscriber (`sale_project` does
this). That is right for product behaviour and wrong for a customer's own rules.

## 3. How Odoo does it, and its weaknesses

Odoo's `base.automation`: a trigger (on create, on update of fields, on state change, timed on a date field, on
webhook), a filter domain, and server actions (update record, create activity, send email, execute Python). Its
weaknesses: Python in the database with superuser rights (a security and upgrade problem), rules invisible to
reviews, no log of what ran, triggers implemented by patching ORM methods (a `write` from anywhere may or may not
fire depending on the patch), no idempotency (a crash mid-action re-runs or loses the action), and timed triggers
by a cron that scans every record.

## 4. Options

- **A. Rules as records, evaluated by an engine on Shutro's durable feeds (audit trail, outbox), actions from a
  fixed menu plus module-declared ones.** Exactly once per change, logged, permission-aware, no code in the
  database. Recommended.
- **B. Rules as code only** (a module per customer). Reviewable and upgrade-safe, but needs a developer for every
  rule; that is what we have now.
- **C. Odoo's way**: scripts stored in the database. Rejected by CLAUDE.md ("explicit over magic", "secure by
  default").

## 5. Recommendation: A

### 5.1 Triggers

| Trigger | Fires when | Source |
| --- | --- | --- |
| `created` | a record of the model is created | the audit trail (`create` rows exist for every model) |
| `updated` | a record changes; optionally only when one of `fields` changed, optionally only to `values` | the audit trail (field rows exist for **tracked** fields: a rule on an untracked field is refused at save with the fields that are tracked, until Shutro request #26 below) |
| `deleted` | a record is deleted (or archived) | the audit trail |
| `transition` | a state transition ran (`confirm` on `sale.order`) | the audit trail's row of the state field (old → new) |
| `event` | an app emitted an outbox event (`sale.order.confirmed`, `approval.decided`, `mail.message.posted`) | the outbox (`shutro.subscribe`) |
| `date` | a date / datetime field of the record is reached, with an offset (`deadline` − 3 days, `dueDate` + 7 days) | a job enqueued per record and rule (`runAt`, keyed, so a record is scheduled once per rule; rescheduled when the field changes), plus a nightly sweep for records the jobs missed |
| `schedule` | a cron expression, with the records of a domain | the scheduler (RFC 0006's "a scheduler on top later": this RFC introduces it, as a job that re-enqueues itself at the next instant) |

Every trigger has a **condition**: a Shutro domain on the record (RFC 0004's search syntax, the same the search
layer and approval policies use), evaluated **after** the change in the engine's scope. `updated` and `transition`
also take a "before" condition on the old values of tracked fields (`{ state: 'draft' }` → "from draft").

### 5.2 The feed, and exactly once

- **Audit rows as events.** Shutro writes `shutro_audit` rows in the writing transaction (RFC 0013): `create`,
  `unlink`, and one row per tracked field changed, with the transaction id, the user, the reason. The engine's
  subscriber keeps a cursor on that table (like an outbox subscription: one row per subscriber in `automation.cursor`,
  advanced in the handler's transaction, one worker at a time by an advisory lock, the same polling cadence as
  the outbox), groups rows by `(tx, model, record)` into one change each, and evaluates the rules of that model.
  A change is handled in a transaction of its own; the rule runs commit with the cursor, so a crash re-runs the
  change, never skips it, and the run log's unique key `(rule, tx, record)` makes a re-run a no-op.
- **Outbox events** come through `shutro.subscribe` per topic a rule names (subscribers are started when a rule
  on a new topic is enabled; the module's own topic list grows as modules declare events).
- **Loop guard.** The engine's writes carry the reason `automation:<rule id>:<depth>`. A change whose reason names a
  rule does not fire that rule again on the same record, and a chain deeper than 5 stops with a logged error.
  One rule runs at most once per record per transaction.
- **Why not `announceChange`.** It is after-commit `NOTIFY`: lost when no server listens. Rules need a durable
  feed, and the audit trail is one every write path fills.
- **Shutro request #26:** a per-model option that emits a `record.changed` outbox event (model, id, action, the
  changed keys) in the writing transaction, for every write and not only tracked fields. With it, the `updated`
  trigger covers every field and the audit cursor goes away. Until then, the audit trail is the feed, and the
  rule editor says which fields a rule can watch (the model's tracked ones) and offers to track another (Studio).

### 5.3 Actions (in order; each sees the record as the previous one left it)

| Action | What it does | Notes |
| --- | --- | --- |
| `set` | writes field values (a value, or an expression from the record's fields: `{{partner.name}}`, `{{amountTotal}}`) | through the ORM: constraints, computes, audit |
| `transition` | runs a named transition | its guards and `requires` apply |
| `activity` | plans an activity (type, summary, deadline offset, assignee: a user, the record's field such as `user`, or the holders of a role) | RFC 0006 part 1 |
| `notify` | a notification of kind `automation` with a text template, to users, a field's user or a role, on the channels their preferences allow | RFC 0006 parts 3–5: in-app, email, push, SMS, WhatsApp |
| `note` / `comment` | posts on the record's chatter (template) | followers hear a comment |
| `create` | creates a record of a model with values mapped from the record | the new record's rules fire too (depth counts) |
| `webhook` | `POST` JSON (the record's fields of a list, the trigger) to a URL, signed `X-Kosh-Signature` (HMAC of the body with a per-rule secret), 10 s timeout, 3 retries with backoff, hosts allow-listed in settings | a job: the run is logged as `queued` then `done` / `failed` |
| `action` | runs an action a module declares in its manifest (`automationActions: [{ key, label, model?, params, run(env, record, params) }]`): typed TypeScript, reviewable, explicit | the way to go beyond the fixed menu without scripts in the database |

Templates are small: `{{field}}`, `{{field.subfield}}`, `{{today}}`, `{{actor.name}}`, `{{record.url}}`; no logic.

**Who the actions run as.** A rule chooses `runAs: 'actor'` (the user whose change fired it: their rules and
permissions apply, the audit names them with the reason `automation:<rule>`) or `runAs: 'system'` (a superuser
scope, audited with the reason). The default is `actor`; `system` is what an administrator picks deliberately, and
the rule form says what it means. A `date` or `schedule` trigger has no actor: it runs as `system`, or as the
user named by the rule (`runAs: { user }`).

### 5.4 The run log

`automation.run`: rule, trigger, model, record, actor, started, finished, `state` (`done`, `failed`, `skipped` with
the reason: condition false, loop, depth), the actions with their outcome (a JSON list: action, result, error),
and the error. Unique on `(rule, tx, record)` for the feed-driven triggers. Retention: a per-company setting
(default 90 days, `done` runs; `failed` kept until seen), a nightly job prunes. The log is the Automation app's
second page; a failed run can be **retried** (the actions run again on the record as it is now) and a rule can be
**tested** on a record without writing (`dry run`: the condition's result and the actions it would take).

### 5.5 Permissions

- `automation.manager` (administrators and whoever they give it to) creates and edits rules and reads the run
  log; `automation.user` reads the runs of records they can read (the chatter shows "Rule X did Y" as a system
  note when the rule says so).
- Rules are company-scoped; a rule's `runAs: 'system'` is itself audited as a permission change (RFC 0003).
- Webhook hosts are allow-listed in settings; a rule's secret is shown once.

### 5.6 The app

Automation (category Administration): **Rules** (list by model, enabled toggle; a form with the trigger, the
condition built with the search layer's filter editor, the actions as an ordered list of cards with the
templates' field pickers, the run-as choice, and "Test on a record"), **Runs** (list by state with the error,
retry), **Settings** (retention, webhook hosts). Everything through i18n, keyboard reachable, light and dark.

### 5.7 Performance

The subscriber handles changes in batches of 100 rows; a model without rules costs one indexed read per batch
(rules are cached per installed set, invalidated on change). Budgets: a change with one `set` action runs in
< 50 ms; the feed lags a commit by at most the poll interval (5 s, like the outbox). Timed triggers never scan
the whole table: one job per record, enqueued when the record is created or its date changes.

### 5.8 Tests

Real PostgreSQL: every trigger fires once per change whoever makes it (API, bootstrap, another module), not for
its own writes, and not twice after a crash (the cursor and the unique run); each action; `runAs` differences
(an actor without rights fails and is logged, system succeeds); the date trigger reschedules when the date moves;
the webhook's signature and retries against a local server; permissions (a user without `automation.manager`
cannot read rules); E2E: a rule made in the app fires on a record and shows in the run log.

## 6. Delivery plan (each step reviewed)

1. Models, the audit cursor and outbox subscribers, the engine with `set`, `transition`, `activity`, `notify`,
   `note`, `create` and module `action`s, `runAs`, the loop guard, the run log, the API, tests.
2. The Automation app: rules, the condition builder, the actions editor, runs with retry, dry run, E2E.
3. `webhook` with the allow-list and signature; `date` and `schedule` triggers, with the scheduler job.
4. Shutro request #26 adopted when it lands; Studio (RFC 0012) exports rules as a module.

## 7. Open questions (answers wanted with the approval)

- **Default `runAs`**: `actor` (safe, sometimes refused) as proposed, or `system`?
- **Templates**: the small `{{…}}` language only, as proposed, or expressions (comparisons, arithmetic) too? The
  proposal keeps logic out: a module `action` is the place for it.
- **Who gets `automation.manager` by default**: administrators only (proposed), or every app's managers for their
  own models?

## Implementation notes (2026-10-26): step 1 — the engine

- `@kosh/automation`: `automation.rule` and `automation.run` (served by the generated API with list and form
  views under the Automation app; `automation.cursor` private). The engine (`engine.ts`) reads `shutro_audit`
  and `shutro_outbox` past cursors of its own, one node at a time by advisory locks, groups audit rows into one
  change per transaction, model and record, and applies the enabled rules of the change's model and company:
  the untracked check, the trigger (watched fields, from / to values, the loop guard), the condition (a search with
  the record's id and the domain), then the actions in one transaction of the run's scope (`shutro.run` as the
  actor with the groups `AuthService.verify` gives, or `bootstrap` as the system), the run row written before
  (`queued`) and after (`done` / `failed` / `skipped`), unique per `(rule, tx, record)`.
- Outbox events are read with a cursor rather than `shutro.subscribe`: a subscriber's handler is a Shutro scope,
  and the engine's runs need scopes of their own (the first try nested them and left runs queued).
- Actions: `set`, `transition`, `activity`, `notify` (an `automation.notify` event the inbox subscriber turns
  into `automation` notifications), `note` / `comment`, `create`, `action` (the manifest's `automationActions`);
  `webhook` is skipped until step 3. Templates keep a single path's type.
- Tests: `packages/automation/test/automation.integration.test.ts` (created with templates and the loop guard,
  updated with watched fields, from / to, the condition and an untracked field, a transition creating a record,
  run as the actor refused and logged versus the system, a module action, an activity, a retry, an event rule
  and its notification, a dry run, permissions, the tracked fields route).

## Alignment with CLAUDE.md

Rules are data, actions are a fixed menu plus typed module code (explicit over magic, secure by default: no scripts
in the database, every run audited, record rules apply when a rule runs as its actor). The engine reuses Shutro's
audit trail, outbox and jobs (nothing re-implemented; one request, #26, for the generic change event). Views and
conditions use RFC 0004's search syntax, notifications RFC 0006's pipeline, the app the shell of RFC 0007.
