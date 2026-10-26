# Automation (RFC 0011)

"When X, then Y" rules without code. A rule is a record of the **Automation** app (every installation has the
module; the app shows for `automation.manager`, administrators give that role): a model, a trigger, a condition,
the actions, and who they run as. The engine reads Shutro's audit trail and outbox with a cursor of its own, so a
rule fires **exactly once per change, after it committed, whoever made it** (the UI, the API, an import, another
module), and every evaluation is a row of the run log.

## Triggers

| Trigger | Fires when | Settings |
| --- | --- | --- |
| `created` | a record of the model is created | |
| `updated` | a record changes | `watchFields` (tracked fields; one of them must have changed), `fromValues` / `toValues` (`{ state: 'draft' }` → `{ state: 'sale' }`) |
| `transition` | the state field changed | `fromValues` / `toValues`; `watchFields` names the state field (`state` by default) |
| `deleted` | a record is deleted | |
| `event` | an app emitted an outbox event whose payload names a record (`{ model, id }`) | `topic` (`sale.order.confirmed`, `approval.decided`, `crm.deal.won`) |
| `date` | a date field of the record (plus `dateOffsetDays`, negative for before) is reached | `dateField`, `dateOffsetDays`; once per record and date value, a moved date fires again; records whose date passed more than 7 days before the rule existed are left alone |
| `schedule` | a cron slot (UTC: `0 2 * * *`, `*/15 * * * *`, `@daily`) is due | `cron`; runs on the records the condition matches (500 per slot), once per slot |

The audit trail logs field changes of **tracked** fields only (`tracking` on the model or the field): an `updated`
rule watching another field is skipped with the reason `untracked` on every change (`GET
/api/v1/automation/models/:model` lists the tracked fields and the transitions). Shutro request #26 asks for
change events on every field.

Every trigger takes a **condition**: a Shutro domain the record must match after the change (the search layer's
syntax, the one approval policies use), e.g. `{ amountTotal: { gte: '50000' }, partner: { isCompany: true } }`.

## Actions (in order; the first failure stops the run and rolls its writes back)

| `kind` | Settings | Does |
| --- | --- | --- |
| `set` | `values` | writes the fields (through the ORM: constraints, computes, audit) |
| `transition` | `name` | runs the transition (its guards and permission apply) |
| `activity` | `type` (the activity type's name), `summary`, `note`, `inDays`, `assignee` | plans an activity for each user named |
| `notify` | `users`, `text` | a notification of kind `automation` through the pipeline (inbox, email, push, SMS as the users' preferences allow) |
| `note`, `comment` | `text` | posts on the record's chatter |
| `create` | `model`, `values` | creates a record (its rules fire too, up to a depth of 5) |
| `action` | `key`, `params` | runs an action a module declares (`automationActions` in its manifest: typed TypeScript) |
| `webhook` | `url`, `fields` | a signed JSON POST through a job (`automation.webhook`, 4 attempts with backoff, 10 s timeout): `{ rule, trigger, model, id, record, at }`, `X-Kosh-Signature: sha256=<HMAC of the body with the rule's webhookSecret>` (made on first use), `X-Kosh-Rule`; https only (http for localhost), and the host on `KOSH_AUTOMATION_WEBHOOK_HOSTS` (comma-separated, `*.example.com` allowed) |

**Users** (`assignee`, `users`) are ids, `field:<key>` (a user field of the record, `field:user`), or `role:<code>`
(every holder of the role in the company). **Templates** in `values`, `summary`, `note`, `text`: `{{field}}`,
`{{relation.field}}` (`{{partner.name}}`), `{{today}}`, `{{actor.name}}`, `{{record.url}}`; a value that is one
template keeps its type (`'{{partner}}'` is the partner's id for a many2one).

## Who the actions run as

`runAs: 'actor'` (the default): the user whose change fired the rule, under their rules and permissions; a rule
that does more than the actor may do fails, and the run says why. `runAs: 'system'`: a superuser scope, audited
with the reason `automation:<rule>:<depth>`. That reason is the **loop guard**: a rule never fires on its own
writes, and a chain of rules stops at depth 5 (`skipped: loop` / `depth` in the log).

## The run log

`automation.run`: the rule, the trigger, the record, the actor, when, `state` (`done`, `failed`, `skipped` with
the `reason`: `trigger`, `fields`, `from`, `to`, `condition`, `untracked`, `loop`, `depth`, `no-actor`), the
`outcomes` of the actions and the `error`. Unique per `(rule, tx, record)`: a re-read of the trail after a crash
is a no-op. `POST /api/v1/automation/runs/:id/retry` runs a failed run's actions again as a new run;
`POST /api/v1/automation/rules/:id/test { record }` is a dry run (the condition's result, the rendered actions).
`automation.user` reads runs; `automation.manager` reads and writes rules. The Automation app's **rule editor**
builds all of this without JSON: the trigger, the watched fields, the condition rows (or a domain), the actions
with pickers, run-as, a dry run on a record, and "Run pending changes now" (`POST /api/v1/automation/poll`,
managers: one read of the trail and the outbox, for a demo or a test). A failed run has "Try again" on its form.

## Example

```json
{
  "name": "Big deals need a call",
  "targetModel": "crm.deal",
  "trigger": "updated",
  "watchFields": ["amount"],
  "condition": { "amount": { "gte": "50000" } },
  "runAs": "system",
  "actions": [
    { "kind": "set", "values": { "priority": "high" } },
    { "kind": "activity", "type": "Call", "summary": "Call {{partner.name}} about {{name}}", "assignee": ["field:user"], "inDays": 2 },
    { "kind": "notify", "users": ["role:crm.manager"], "text": "{{actor.name}} raised {{name}} to {{amount}}" }
  ]
}
```

A module offers an action:

```ts
defineModule({
  // …
  automationActions: [
    {
      key: 'crm.flag_vip',
      label: 'Mark the partner VIP',
      model: 'crm.deal',
      run: async (env, record) => { /* typed code in the run's scope */ return 'flagged'; },
    },
  ],
});
```

## Settings

`KOSH_AUTOMATION_POLL_MS` (5 000): how often a node reads the trail and the outbox and checks the timed rules
(one node at a time for the feeds, an advisory lock). `KOSH_AUTOMATION_WEBHOOK_HOSTS`: the webhook allow-list.
`KOSH_SCHEDULES=off` keeps the engine off (the CLI). A `date` or `schedule` rule has no actor: it runs as
`runAsUser` when set, else as the system.
