# RFC 0002: Shutro integration & metadata-driven API generation

- **Status:** Draft (for review)
- **Depends on:** 0001; Shutro RFCs 0003 (environment), 0014 (security), 0016 (aggregates), 0017 (data),
  0018 (compare-and-set, events, jobs)

## 1. Summary

Kosh talks to the database only through Shutro, from **one import point** (`packages/server/src/orm.ts`). Every HTTP
request runs inside one `shutro.run()` with a verified identity. REST endpoints, an OpenAPI 3.1 document and a
typed client are **generated from Shutro's registry metadata** (`registry.describe()`), so security, validation and
types come from the model definitions and are never re-implemented per endpoint.

## 2. Problem

An ERP exposes hundreds of models to web, mobile and integrations. Hand-written endpoints drift from the models,
duplicate access checks, and miss fields or rules. The API must be complete, typed, documented, secure by the same
rules as the ORM, and cheap to extend.

## 3. How Odoo does it, and its weaknesses

Odoo's web client and integrations call `/web/dataset/call_kw` (JSON-RPC) or XML-RPC: any **public** model method
(`model.method(args, kwargs)`) is callable remotely.

- **Security by naming convention:** every method not starting with `_` is remotely callable; adding a helper method
  can open an RPC entry point by accident.
- **No contract:** arguments and results are untyped; there is no OpenAPI, no generated client, no versioning;
  integrations reverse-engineer the web client.
- **Chatty:** `read`, `onchange`, `name_search` round trips per field change; no batching contract.
- **Errors** are Python tracebacks or strings; clients cannot react to error kinds reliably.

## 4. What Shutro's metadata provides (inspected in the installed package)

`registry.describe(model)` returns, per model: label, `recName`, order, archivable, company scope, tracking,
constraints, `methods` (names only), `onchange` fields, `access` (ACL), `rules`, partition; per field: kind, label,
help, required, readonly, store, computed, depends, index, translate, sequence, groups (field security),
`target` / `inverseField` (relations), `currencyField` / `uomField`, `checkCompany`. The registry also exposes the
load order, modules (groups, permissions, data), `externalIds`, sequences, the compute graph, and
`security.{groups, permissions, isAdministrator}`. Runtime: `shutro.run` with identity loader, `env.access`,
`env.securityAdmin`, `aggregate()`, `onchange()`, compare-and-set writes, `emit` / `enqueue` / `subscribe` / `work`,
`asOf`.

**Gaps to close in Shutro (proposed Shutro RFC amendments, not worked around in Kosh):**

1. `describe()` lists method **names** only: remote methods need parameter/result schemas → Kosh declares exposed
   methods explicitly (below); Shutro adds `describe()` output for `selection` values and `state` states/transitions
   in a client-friendly form (today they are present on the field objects but not normalized in the description).
2. A per-environment description: `describeFor(env, model)` with the fields the user may read/write and the
   operations they may perform, so `/meta` never leaks hidden fields. (Can be computed in Kosh from
   `env.access.canField`, but belongs in Shutro next to the rules.)

## 5. Options

| | A. Generic RPC (`/rpc/model/method`) | B. Generated REST per model at boot + OpenAPI | C. Generated route source files (codegen) |
| --- | --- | --- | --- |
| Contract | Weak (one endpoint) | OpenAPI 3.1 per installed set | OpenAPI + source in git |
| Follows installed modules per database | Yes | Yes (per registry) | Needs regeneration per module set |
| Security | Per-call checks | Shutro checks inside `run()` | Same, but generated code can be edited and drift |
| Custom behaviour | Methods | Explicit `routes` + exposed methods | Edit generated code (drift) |
| Client generation | Hand-written | From OpenAPI | From OpenAPI |

## 6. Recommendation: B, with generated clients

### 6.1 One import point

`packages/server/src/orm.ts` is the only file importing `shutro` (enforced by a Biome/lint rule). It creates the
driver and one Shutro instance per database, with `identity` (users, companies, roles from the database — Shutro
RFC 0014 §7.9), `runtimeSecurity: true` (roles editable by administrators, RFC 0003), keys for encrypted fields,
and the inspector in development.

### 6.2 Per-request environment

The session (RFC 0003 auth) yields user and company; request headers may narrow `companies`, `lang`, `tz`. The
handler runs entirely inside `shutro.run({ user, company, companies, lang, tz })`: one transaction per request
(read-only for `GET`), the identity verified by the loader, record rules and field security applied by Shutro.

### 6.3 Generated endpoints (per installed model, filtered by ACL at runtime)

| Endpoint | Shutro call |
| --- | --- |
| `GET /api/v1/{model}` (`filter`, `order`, `limit`, `offset`, `fields`) | `search()` + `read(fields)`; `filter` is a JSON domain validated against the model (paths, operators) |
| `GET /api/v1/{model}/{id}` | `browse().load()`; `ETag` = `updatedAt` |
| `POST /api/v1/{model}` | `create()` |
| `PATCH /api/v1/{model}/{id}` with `If-Match` | `write(values, { expect: { updatedAt } })` → `412` on `StaleRecordError` |
| `DELETE /api/v1/{model}/{id}` | `unlink()` |
| `POST /api/v1/{model}/aggregate` | `aggregate()` (RFC 0005 builds on it) |
| `POST /api/v1/{model}/onchange` | `onchange()` (one round trip per form change, children included) |
| `POST /api/v1/{model}/{id}/transitions/{name}` | the generated transition method (guards, `requires` permission) |
| `POST /api/v1/{model}/{id}/methods/{name}` | only methods the manifest **exposes**, with schemas |
| `GET /api/v1/{model}/export` · `POST /api/v1/{model}/import` | `export` / `import` ACL, streamed (`stream()`), COPY for imports |
| `GET /api/v1/meta/{model}` | the user's view of the model (fields they may read / write, operations, states) |

Exposed methods are opt-in, with Standard Schema validators for arguments and results:

```ts
// purchase manifest (RFC 0001)
routes: {
  expose: {
    'purchase.order': {
      requestApproval: { input: z.object({ note: z.string().max(500).optional() }), output: z.object({ requestId: z.number() }) },
    },
  },
},
```

### 6.4 Contracts and clients

- **OpenAPI 3.1** generated per installed module set from `describe()`: field kinds map to JSON Schema
  (`decimal` → string pattern, `monetary` → `{ amount: string, currency: string }`, `date` → `format: date`,
  many2one → id, x2many → id arrays / commands), required/readonly flags, enums for selections and states,
  error schema. Served at `/api/v1/openapi.json`.
- **Typed client** (`@kosh/client`) generated from the same metadata at build time for the modules in the repo
  (types from Shutro's generated views), plus a runtime client for dynamic modules.
- **Errors** map Shutro's typed errors to RFC 9457 problem details with stable `type` codes:
  `AccessError` → 403, `MissingRecordError` → 404, `StaleRecordError` → 412, `ValidationError` /
  `ConstraintViolationError` → 422, `ConcurrentUpdateError` → 409. The hint is included.
- **Idempotency keys** (`Idempotency-Key` header) on unsafe methods: the key and response are stored in the request's
  transaction, so a retried request returns the first result.

## 7. Purchase with approvals: the generated surface

- `GET /api/v1/purchase.order?filter={"state":"to_approve","approvalRequests.any":{"approver":{"$env":"uid"}}}`
  lists what the current user must approve; rules hide other companies' orders.
- `POST /api/v1/purchase.order/42/transitions/submit` moves `draft → to_approve`; the approvals module's `before`
  hook creates `approval.request` rows from the policy (levels by amount) and emits `approval.requested` (outbox →
  notifications, RFC 0006).
- `POST /api/v1/approval.request/7/methods/approve` is exposed with a schema; it checks the approver role through
  Shutro rules, and the last approval transitions the order to `approved`.
- `PATCH /api/v1/purchase.order/42` with an old `If-Match` after someone else approved returns `412` instead of
  silently overwriting.
- `GET /api/v1/meta/purchase.order` for a requester omits `marginEstimate` (field group `purchase.manager`).

## 8. Open questions

- Pagination: offset (simple) vs keyset (`after` cursor on order keys) for exports and infinite lists — proposed
  both: keyset for `/export` and lists over 10k rows.
- GraphQL: not in 1.0; the metadata could generate it later.
- Batch endpoint (`POST /api/v1/batch`) running several operations in one transaction for offline/mobile sync.
