# Requests to Shutro

Things Kosh needs from Shutro, recorded instead of being worked around (CLAUDE.md, Shutro integration).

| # | Request | Needed by | Status |
| - | ------- | --------- | ------ |
| 1 | `describe()` with `selection` values and `state` states / transitions in a normalized, client-ready form | RFC 0002 (OpenAPI enums), 0004 (views) | Open — interim: `packages/server/src/api/metadata.ts` reads them from the field descriptors (approved) |
| 2 | A per-environment description (`describeFor(env, model)`): fields the user may read / write, operations allowed | RFC 0002 (`/meta`), 0003 (UI hints), 0004 | Open — interim: `/api/v1/meta` composes it from `env.access.can` / `canField` (approved) |
| 3 | `aggregate({ groupingSets / rollup / cube })` returning the grouping level per row, keeping per-currency Money | RFC 0005 (one-query pivots) | Open |
| 4 | Method signatures in metadata (or a declared-exposure API) for remotely callable methods | RFC 0002 (exposed methods) | Open (Kosh declares exposure in manifests meanwhile) |
| 5 | Publish `shutro@0.2.0` to npm (Kosh links the local build until then) | Installation | Open |
| 6 | `records.read(['id', …])` raised "id is not loaded" | Generated REST rows | **Fixed in Shutro** `14ee682` (regression test) |
| 7 | `onchange()` raised an AccessError for users without a restricted field's group | Generated onchange endpoint | **Fixed in Shutro** `14ee682` (only readable fields are returned) |
