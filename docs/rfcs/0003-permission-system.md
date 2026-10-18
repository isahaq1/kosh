# RFC 0003: Permission system

- **Status:** Draft (for review)
- **Depends on:** 0001, 0002; Shutro RFC 0014 (security: ACL, rules, field groups, RLS, administrators, permissions,
  grants, back-dating, elevation, runtime security)

## 1. Summary

Every app, menu, view, action, endpoint and record in Kosh is governed by permissions; **installing a module grants
nothing**. Kosh builds the administration experience (roles, per-company assignment, approval policies, audit) on
Shutro's security engine, which already enforces ACL, record rules (in SQL and optionally RLS), field security,
feature permissions, special per-user grants, back-date rules and scoped elevation. Administrators are the one
explicit bypass, with mandatory 2FA, audit, and a "keep at least one administrator" guard.

## 2. Problem

ERP customers need to say: "buyers create purchase requests in their own company; department heads approve up to
500 000 BDT; the finance director approves above; auditors read everything but export nothing; Rahim may also post
back-dated bills this month". They need to change this without developers, and to prove later who could do what.

## 3. How Odoo does it, and its weaknesses

`res.groups` (with `implied_ids`), `ir.model.access` CSV (ACL), `ir.rule` domains, `groups=` on fields, views, menus
and buttons, `sudo()`; the admin (uid 1 / `base.group_system`) bypasses ACL but not rules unless `sudo()`.

- **Rules evaluated in Python**, partly; record rules and ACL can be bypassed with `sudo()` anywhere in code, and
  any public method is an RPC entry point (RFC 0002).
- **Groups are global**, not per company: a user is a purchase manager in every allowed company.
- **Approvals** are module-specific (`purchase` double validation, `approvals` app) with different models and rules.
- **Field and button visibility** is UI-only in many places (`groups=` on view nodes); the server still accepts the
  write unless the field itself carries groups.
- **Permission changes are not audited**; broken rule domains fail when users hit them.

## 4. Options

| | A. Kosh layer on Shutro security (overlay + Kosh admin models) | B. Separate policy engine (OPA/Cedar) | C. Odoo-like tables evaluated by Kosh |
| --- | --- | --- | --- |
| Enforcement point | Shutro (every query, SQL, optional RLS) | Kosh before calling Shutro (double model) | Kosh, not in SQL |
| Raw SQL / exports / reports covered | Yes (rules in SQL, RLS) | No | No |
| Admin edits without code | Yes (Shutro runtime security) | Yes | Yes |
| Complexity | Low (reuses tested engine) | High; two sources of truth | Medium; re-implements Shutro |

## 5. Recommendation: A

### 5.1 Concepts

- **Access levels** (manifest, RFC 0001): what an app offers (`purchase.user`, `.approver`, `.manager`), mapped to
  Shutro groups with `implies`. Shutro ACL, rules and field groups reference these groups.
- **Roles**: what administrators assign: bundles of access levels across apps ("Procurement officer" =
  purchase.user + inventory.user + contacts.user). Stored as Shutro **runtime roles** (`env.securityAdmin.saveRole`,
  implies = access levels), editable without code, validated when saved (rule domains compiled), audited
  (`security` audit rows), reloaded in every process by NOTIFY.
- **Per-company assignment**: `kosh_user_role(user, role, company)`. The identity loader (Shutro `identity`) returns
  the groups of the *current* company only, so a user can be a manager in one company and a user in another.
- **Special grants** per user (Shutro `grants`): one permission or model operation without a role, with optional
  expiry, e.g. `account.backdate` until month end.
- **Action permissions**: Shutro `definePermission` codes for buttons, transitions (`requires`), exposed methods and
  menus; `env.access.has()` on the server, the same answer in `/api/v1/meta` for the UI.
- **Visibility**: apps, menus, views and actions are visible only when the user has an access level or permission
  that unlocks them; the server filters the menu tree and refuses actions it would not show (the UI hiding is a
  convenience, never the control).

### 5.2 The administrator bypass

- One built-in role, `base.admin`, is a Shutro **administrator group** (`defineGroup({ administrator: true })`):
  it passes ACL, rules, field groups, permissions and back-date rules on every model of every module, also in RLS.
  (Shutro's per-call `asSuperuser({ reason })` remains for system code; administrators act as themselves, so their
  changes are attributed to them in the audit trail.)
- **Mandatory 2FA** for any user holding an administrator role: the session refuses to grant the role's groups until
  the second factor is verified (the identity loader drops administrator groups for sessions without 2FA).
- **Keep at least one administrator**: removing the role from, deactivating or deleting the last active 2FA-enabled
  administrator is refused (a Shutro constraint on `kosh_user_role` / `res.users`, checked in the same transaction).
- **Integrity still applies**: constraints, sequences, company consistency (`checkCompany`), state-machine guards,
  compare-and-set, back-date rules for non-admins: administrators bypass permissions, not data integrity.
- Every administrator session start and every permission change writes audit rows.

### 5.3 Multi-level approvals

`@kosh/approvals` (RFC 0001 §6): `approval.policy` (model, ordered levels, each with a condition domain and an
approver role or user), `approval.request` (record, level, approver, state, decided_at, comment). A transition such as
`purchase.order.submit` creates the requests whose conditions match (`amountTotal > 50 000`, `> 500 000`); the order's
`approve` transition `requires` that every request is approved (guard). Approvers see their requests through a Shutro
record rule (`{ approver: { $env: 'uid' } }` or their role); decisions are audited and notify (RFC 0006). Policies
are data records (`noupdate`), so companies tune thresholds without code.

### 5.4 Administration APIs (no code)

`/api/v1/admin/roles`, `/assignments`, `/grants`, `/rules`, `/approval-policies`: thin endpoints over
`env.securityAdmin` and the Kosh models, administrator-only, each change audited and announced. A "who can do what"
report reads the effective permissions of a user per company (closure of roles, grants, runtime rules).

### 5.5 Enforcement tests

For every endpoint type (list, read, create, update, delete, aggregate, onchange, transition, exposed method,
export, import, report, attachment download, websocket subscription), a forbidden user gets `403` (or `404` when the
record is out of rule scope) at the server. The suite is generated from the metadata so new models are covered.

## 6. Purchase with approvals

- Roles: *Requester* (purchase.user), *Department head* (purchase.approver), *Finance director* (account.manager +
  purchase.approver), *Auditor* (read on purchase and accounting, no export).
- Rahim is Requester in Dhaka Ltd and Department head in Chattogram Ltd: two assignments, one per company.
- A requester submits a 750 000 BDT order: two approval requests (department head, finance director); the order
  cannot be confirmed until both approve; each decision is audited and notified.
- An administrator can do all of it without any role, after 2FA, and every action is attributed to them.

## 7. Open questions

- Delegation (approve on behalf while on leave): a time-boxed grant of the approver role? Proposed: yes, as a
  special grant with expiry, audited.
- Separation of duties (the requester cannot approve their own order): a rule on `approval.request`
  (`record.createdBy != uid`); built in to the approvals module.
