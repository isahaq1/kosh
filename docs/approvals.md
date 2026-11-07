# Approvals: the matrix

How the Approvals engine decides who approves a record and what it keeps (RFC 0025, RFC 0027). The engine's wiring
into a module's state machine is in [permissions.md](permissions.md#approvals).

## Who decides a level

A policy (`approval.policy`) covers a model, optionally only its records that meet a condition. Each of its levels
(`approval.level`) applies when its own condition matches, and finds its approvers by **Approved by**:

| Approved by | The approvers |
| --- | --- |
| A role | The role's holders in the record's company (administrators when nobody holds it yet) |
| Named people | The people listed |
| The requester's manager | Their manager in Workforce |
| The head of the requester's department | The department's head in Workforce |
| The approvers of the requester's department | The people on the department's **Approvers** (Workforce › Departments) |
| A person on the record | The user in a field of the record (`approverField`, e.g. `user`) |
| The record decides | The people the record's model names: `approvalUsers(key)` |

**Also** (`extraUsers`) adds people to whoever the kind finds. When the kind finds nobody, the level's role stands in.
The requester never decides their own record. **Decided by** sets how many must approve: any one, all, or a number.

A model joins "the record decides" with a method returning the people per record:

```ts
methods: {
  approvalUsers: method('purchase.order', async function (this: unknown, key: string) {
    // Map<record id, user ids>
  }),
},
```

Purchase names the approvers of its lines' product categories (Products › Categories › Approvers; the nearest
category up the tree that names some).

## When nobody can decide

**When nobody is found** on the policy, for a level with no person and no role:

- **Refuse the submission** (the default): the submission fails, naming the level and why — "pia is not an employee
  in Workforce", "Operations has no head with a user".
- **Administrators decide.**
- **Skip the level**: recorded as skipped; when every level is skipped, the record is approved at once.

## Turns, deadlines and the log

Levels are decided in order of sequence (the same sequence side by side). A level's turn starts when every lower
level is approved: its **Started** time is set and its deadline (**Hours to decide**) counts from then, with the
reminder at half and the escalation once late.

Each request keeps **How the approvers were found**, and the record's approval panel shows it with the log: created,
its turn, votes, approved, rejected, sent back, cancelled (withdrawn, submitted again, or another level rejected),
skipped, reminded and escalated, with who and when. `GET /api/v1/approvals/:model/:id` returns `requests` and
`events`.

## Next (RFC 0027)

Backup approvers per level, skipping approvers who already approved, reassignment by Approvals managers, keeping
waiting requests in step with their level; policies by several companies or a segment; the matrix dashboard.
