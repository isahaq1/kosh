# Requests to Shutro

Things Kosh needs from Shutro, recorded instead of being worked around (CLAUDE.md, Shutro integration).

| # | Request | Needed by | Status |
| - | ------- | --------- | ------ |
| 1 | `describe()` with `selection` values and `state` states / transitions in a normalized, client-ready form | RFC 0002 (OpenAPI enums), 0004 (views) | Open |
| 2 | A per-environment description (`describeFor(env, model)`): fields the user may read / write, operations allowed | RFC 0002 (`/meta`), 0003 (UI hints), 0004 | Open |
| 3 | `aggregate({ groupingSets / rollup / cube })` returning the grouping level per row, keeping per-currency Money | RFC 0005 (one-query pivots) | Open |
| 4 | Method signatures in metadata (or a declared-exposure API) for remotely callable methods | RFC 0002 (exposed methods) | Open (Kosh declares exposure in manifests meanwhile) |
| 5 | Publish `shutro@0.2.0` to npm (Kosh links the local build until then) | Installation | Open |
