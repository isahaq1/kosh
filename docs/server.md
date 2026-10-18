# Server

```ts
import { createServer, startServer, startTelemetry } from '@kosh/server';
import { contacts } from './modules/contacts/manifest.ts';

const telemetry = startTelemetry({ serviceName: 'kosh' }); // OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set
const server = await createServer({
  databaseUrl: process.env.DATABASE_URL!,
  valkeyUrl: process.env.VALKEY_URL,       // shared rate limits (and later caches, pub/sub)
  modules: [contacts],                      // dependencies are loaded and checked (docs/modules.md)
  // authenticate: defaults to Kosh sessions (below) when `base` is installed; without base, nobody
});
server.app.get('/api/v1/hello', async (request) => request.env(async (env) => ({ uid: env.uid })));
await startServer(server, { port: 3000, onShutdown: () => telemetry.shutdown() });
```

## Per-request environment

`request.env(fn)` runs `fn` in one Shutro transaction as the request's identity: user, company, allowed companies
and groups from the authenticator, narrowed by headers (`X-Company`, `X-Companies` within the allowed ones,
`Accept-Language` → `bn_BD`, `X-Timezone`). GET and HEAD run read-only. Without an identity it is a 401.

## Authentication

Kosh-native, on Shutro (no external auth service): the framework module `base` (`import { base } from
'@kosh/server'`, a dependency of every app) holds users, companies and currencies, and three **private** models
(`auth.credential`, `auth.session`, `auth.user_group`) that the generated API never serves. Every auth read and write
runs in an audited Shutro system scope.

| Route | |
|---|---|
| `POST /api/v1/auth/login` `{ login, password }` | `{ token, csrfToken, twoFactorRequired }` and the `kosh_session` cookie |
| `POST /api/v1/auth/logout` | revokes the session |
| `GET /api/v1/auth/me` | the signed-in user |
| `POST /api/v1/auth/2fa/setup` → `enable { code }` | TOTP enrolment; `enable` returns 10 recovery codes, shown once |
| `POST /api/v1/auth/2fa/verify { code }` | completes a sign-in pending the second factor (TOTP or a recovery code, once) |
| `POST /api/v1/auth/2fa/disable { password, code }` | turns 2FA off |
| `POST /api/v1/auth/password { current, next }` | at least 12 characters; revokes the user's other sessions |

- **Passwords**: scrypt (N=2^15, r=8, p=1), parameters stored with the hash. Unknown logins cost the same time as
  wrong passwords and get the same answer.
- **Sessions**: random 256-bit tokens, stored as SHA-256 digests; 12 h idle timeout, 7-day lifetime (`auth` option).
  Browsers use the httpOnly `SameSite=Lax` cookie and send `X-CSRF-Token` (the `csrfToken`) on unsafe methods; API
  clients send `Authorization: Bearer <token>` (no CSRF). Lookups are cached for `cacheMs` (5 s), which bounds how
  long a revoked session keeps working on another instance.
- **2FA**: once enabled, a new session reaches only `2fa/verify` and `logout` until verified.
- **Who runs as whom**: the user's companies and per-company groups come from the database (`X-Company` picks the
  company); Shutro's identity loader re-checks each request: archived users and companies or groups the user does
  not have are refused.
- **Sign-in rate limit**: 10 attempts per 15 minutes per IP and login (`auth.loginLimit`).
- **Installation**: `installBase(server.shutro, server.auth, { company: { name, currency }, admin: { login, name,
  password } })` creates the first company and administrator (`base.admin`); `server.auth.createUser(...)` adds users
  with group assignments (all companies, or `{ group, company }`).

OAuth/SSO and passkeys come later, on the same models. Roles and the admin UI for them are `@kosh/permissions`.

## Errors

Every refusal is an RFC 9457 problem document (`application/problem+json`) with a stable `type`:
`unauthenticated` 401, `access` 403, `company-not-allowed` 403, `missing-record` 404, `stale-record` 412,
`validation` / `constraint-violation` 422, `invalid-identity` 400, `rate-limited` 429; unexpected errors are 500
without internals, logged with the request id.

## Generated REST API

Every installed model is served from Shutro's metadata; each request is one Shutro transaction as the caller, so ACL,
record rules, field groups, company scope and constraints apply as in the ORM.

| Request | Does |
| ------- | ---- |
| `GET /api/v1/models/{model}?filter=&order=&fields=&limit=&offset=&count=` | search; `filter` is a Shutro domain as JSON |
| `POST /api/v1/models/{model}` | create → `201`, `Location`, `ETag` |
| `GET /api/v1/models/{model}/{id}?fields=` | read, `ETag` |
| `PATCH /api/v1/models/{model}/{id}` + `If-Match` | update; `412` when someone saved since the ETag was read |
| `DELETE /api/v1/models/{model}/{id}` (+ `If-Match`) | delete |
| `POST /api/v1/models/{model}/aggregate` | grouped totals (Shutro `aggregate`) |
| `POST /api/v1/models/{model}/onchange` | form assistance |
| `POST /api/v1/models/{model}/{id}/transitions/{name}` | a state transition (guards, permissions) |
| `GET /api/v1/meta/{model}` | the caller's view: readable fields, writability, operations, transitions, options |
| `GET /api/v1/openapi.json` | the OpenAPI 3.1 document of the installed modules |

- Default fields are the stored fields the caller may read; asking for a restricted field is a `403`.
- Values: decimals are exact strings in canonical form (`"50000"`, `"12.5"`), money is `{ amount, currency }`,
  dates ISO, many2one an id, x2many id arrays; writes take x2many commands (`create`, `link`, `unlink`, `set`).
- `Idempotency-Key` on POST / PATCH / DELETE / transitions: a retry replays the first response
  (`Idempotent-Replayed: true`); the same key for another request is a `422`; a failed request stores nothing.
  The key and the response are stored in the request's own transaction.

## Operations

- `GET /health/live` (the process answers) and `GET /health/ready` (database and Valkey), public and never rate
  limited; readiness is 503 when a dependency is down.
- Rate limiting per user (or IP when anonymous), shared by every instance through Valkey.
- Pino logs with request ids (`X-Request-Id` honoured or generated, echoed back); authorization headers and cookies
  are redacted.
- OpenTelemetry: a span per request (method, route, status, request id) and a child span per Shutro transaction.
- Graceful shutdown on SIGTERM / SIGINT: new connections are refused, in-flight requests finish (responses ask
  clients to close their connections), then the database pool and Valkey close.
