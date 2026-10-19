# Permissions

Kosh is permission-based end to end (RFC 0003). Enforcement lives in Shutro, on every query, so the REST API,
exports, aggregates, onchange and module code all obey the same rules; the server adds sessions, 2FA, navigation
and audit. The UI only hides what the server would refuse anyway.

## Concepts

| | What it is | Where |
|---|---|---|
| Access level | What an app offers (`purchase.user`, `.approver`, `.manager`), mapped to Shutro groups | module manifest (`accessLevels`, required) |
| Role | What administrators assign: a bundle of access levels and other roles, editable without code | Shutro runtime roles (`shutro_role`), admin API |
| Assignment | A role for a user, in one company or all | `auth.user_group` (private), admin API |
| Model access | create / read / write / delete / export / import per role | model `access` in code, plus runtime access per role |
| Record rules | Shutro domains per role (`{ createdBy: { $env: 'uid' } }`) | model `rules` in code, plus runtime rules |
| Field security | hidden or read-only per role | field `groups` in code, plus runtime field security |
| Action permission | a named feature (`purchase.cancel`) for buttons, transitions (`requires`), menus | `definePermission` in code, granted to roles at runtime |
| Special grant | one permission or `model:perm` for one user, optional company and expiry | `auth.user_grant` (private), admin API |
| Approval policy | ordered levels with a domain condition and an approver role | `approval.policy` / `approval.level` (data) |

Installing a module grants nothing: users see an app, menu or action only with an access level of its module (or a
code its `visibleTo` names), and an action on a model only with read access to it (`GET /api/v1/apps`, `/menus`,
`/actions/:id`, all filtered on the server).

## The administrator bypass

`base.admin` (and any runtime role marked `administrator` or implying it) is the single explicit bypass:
Shutro `env.administrator`, exposed as `isSuperuser(env)` from `@isahaq/kosh-server`. Administrators pass every ACL,
rule, field and permission check, acting as themselves (their changes are attributed to them). Safeguards:

- **2FA is mandatory**: administrator groups count only in a session that entered a second factor (verify at
  sign-in, or enrolment in this session) while 2FA is on. Without it the user keeps their other roles only, and
  `GET /api/v1/auth/me` says `administratorNeedsSecondFactor: true`.
- **At least one administrator** (active, with 2FA) always remains: archiving them, turning their 2FA off, removing
  their role or the role itself is refused with `409 last-administrator`. Users holding roles are archived, not
  deleted.
- **Integrity still applies**: required fields, constraints, company consistency, state machines, approval order
  and separation of duties.
- Administrator sessions, sign-ins, permission changes, exports and imports are in the audit log.

## Admin API

All under `/api/v1/admin`, administrators only (the audit log and the effective-permissions report also for the
`permissions.view_audit` permission, e.g. the *Security auditor* access level). Every change is validated when
saved (unknown roles, models, fields and permissions, and broken rule domains are refused), audited by Shutro and in
`audit.event`, and reloaded by every server process.

| Route | |
|---|---|
| `GET access-levels`, `GET permissions` | what modules offer |
| `GET roles`, `PUT roles/:code { label, accessLevels?, implies?, administrator? }`, `DELETE roles/:code` | roles |
| `PUT roles/:code/access/:model { perms }` | model access (`[]` removes the runtime grant) |
| `PUT roles/:code/rules/:name { model, perms, domain }`, `DELETE rules/:name` | record rules |
| `PUT` / `DELETE roles/:code/permissions/:permission` | action permissions |
| `PUT fields/:model/:field { read?, write? }` | field security: `read` hides it from others, `write` makes it read-only for others; `{}` removes it |
| `GET` / `PUT users/:id/roles { assignments: [{ role, company? }] }` | per-company assignments (replaces the set) |
| `GET` / `POST users/:id/grants { grant, reason, company?, expiresAt? }`, `DELETE grants/:id` | special grants |
| `GET users/:id/effective?company=` | who can do what: groups, per-model permissions, hidden and read-only fields, permissions, computed by Shutro as that user |
| `GET audit?kind=security.&limit=&before=` | the audit log (newest first; a kind ending in `.` is a prefix) |

## Approvals

```ts
import { approvalGuard, requestApprovals } from '@isahaq/kosh-permissions';

state: f.state({
  states: { draft: 'Draft', submitted: 'Submitted', approved: 'Approved', rejected: 'Rejected' },
  initial: 'draft',
  transitions: {
    submit: { from: ['draft', 'rejected'], to: 'submitted', after: (orders) => requestApprovals(orders) },
    approve: { from: ['submitted'], to: 'approved', guard: (orders) => approvalGuard(orders), message: 'Waiting for approvals.' },
    reject: { from: ['submitted'], to: 'rejected' },
  },
}),
```

Default policies come from the manifest and are installed as data (`installApprovalPolicies(env, modules)`);
administrators then tune them through the generated API (`approval.policy`, `approval.level`):

```ts
approvals: [{
  name: 'Purchase approvals', model: 'purchase.order', onApproved: 'approve', onRejected: 'reject',
  levels: [
    { name: 'Department head', condition: { amountTotal: { gt: '50000' } }, approverRole: 'purchase.approver' },
    { name: 'Finance director', condition: { amountTotal: { gt: '500000' } }, approverRole: 'company.finance_director' },
  ],
}],
```

- Submitting creates one request per matching level; resubmitting cancels the open ones and starts a new round.
- Levels are decided in order (`409 approval-not-your-turn`), by holders of the role **in the record's company**
  (`X-Company`), never by the requester (`403 separation-of-duties`, administrators included).
- The last approval runs `onApproved`, a rejection `onRejected` (and cancels the other open levels), as the system,
  attributed to the approver in the audit log. Events `approval.requested` / `approval.decided` are emitted for
  notifications (RFC 0006).
- `GET /api/v1/approvals/inbox`, `GET /api/v1/approvals/:model/:id` (needs read access to the record),
  `POST /api/v1/approvals/requests/:id/approve|reject { comment? }`. Requests are private: the generated API does
  not serve them.

## Tests

`packages/permissions/test/enforcement.integration.test.ts` is generated from the OpenAPI document: for every served
model and endpoint type, users without roles get `403` exactly where Shutro denies, so new models are covered
without new tests. The admin and approvals suites cover the scenarios above end to end over HTTP.

## Known limits

- TOTP codes can be replayed within their 30-second window (no used-code memory yet).
- Runtime record rules apply in the ORM; generated RLS policies cover the code's rules only (Shutro).
- Reports, attachments and websocket subscriptions join the enforcement matrix with RFC 0005 / 0006.
