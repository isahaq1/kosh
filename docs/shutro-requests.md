# Requests to Shutro

Things Kosh needs from Shutro, recorded instead of being worked around (CLAUDE.md, Shutro integration).

| # | Request | Needed by | Status |
| - | ------- | --------- | ------ |
| 1 | `describe()` with `selection` values and `state` states / transitions in a normalized, client-ready form | RFC 0002 (OpenAPI enums), 0004 (views) | Open — interim: `packages/server/src/api/metadata.ts` reads them from the field descriptors (approved) |
| 2 | A per-environment description (`describeFor(env, model)`): fields the user may read / write, operations allowed | RFC 0002 (`/meta`), 0003 (UI hints), 0004 | Open — interim: `/api/v1/meta` composes it from `env.access.can` / `canField` (approved) |
| 3 | `aggregate({ groupingSets / rollup / cube })` returning the grouping level per row, keeping per-currency Money | RFC 0005 (one-query pivots) | **Added in Shutro** `8a79c43` (`$groups` per row) |
| 4 | Method signatures in metadata (or a declared-exposure API) for remotely callable methods | RFC 0002 (exposed methods) | Open (Kosh declares exposure in manifests meanwhile) |
| 5 | Publish `shutro@0.2.0` to npm (Kosh links the local build until then) | Installation | Open |
| 6 | `records.read(['id', …])` raised "id is not loaded" | Generated REST rows | **Fixed in Shutro** `14ee682` (regression test) |
| 7 | `onchange()` raised an AccessError for users without a restricted field's group | Generated onchange endpoint | **Fixed in Shutro** `14ee682` (only readable fields are returned) |
| 8 | Runtime field security: hide / make read-only a field per role without code | RFC 0003 (field permissions from the admin UI) | **Added in Shutro** `588f2b2` (`securityAdmin.setFieldGroups`) |
| 9 | Which groups and runtime roles make their holder an administrator | RFC 0003 (mandatory 2FA, keep one administrator) | **Added in Shutro** `588f2b2` (`env.access.administratorGroups()`) |
| 10 | `onchange()` needed only `read`: readers could run form logic on records they could never save | Enforcement matrix (RFC 0003 §5.5) | **Fixed in Shutro** `a84a31e` (needs `create`, or `write` with an id) |
| 11 | Constraint checks may run at commit, outside the superuser scope that made the change, so they cannot assume their records' environment can read them | `approval.policy` / `res.users` constraints | Open — interim: constraints read through `env.asSuperuser` |
| 12 | `asSuperuser()` inside a read-only transaction fails (the scope's audit row cannot be written) | GET routes that read private models (audit log, approval inbox) | Open — interim: those routes run read-write (`request.env(fn, { write: true })`) |
| 13 | Release cached records during long reads in one transaction | Streamed exports of millions of rows | **Added in Shutro** `06f63c7` (`env.releaseCache()`) |
