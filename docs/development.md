# Development

Requirements: Node.js 24+, pnpm 11, Docker.

```sh
pnpm install
pnpm dev:services        # PostgreSQL 18, Valkey 8, S3 storage (+ bucket), Mailpit; waits until healthy
cp .env.example .env
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm test:e2e            # Playwright (first time: pnpm --filter @kosh/web exec playwright install chromium)
pnpm demo                # a throwaway installation of every app with the demo data (API on :3000)
pnpm bench               # performance budgets on seeded data (minutes; CI runs it on main)
```

- Mailpit UI: http://localhost:8025 · S3 API: http://localhost:8333 (SeaweedFS; MinIO's free images are no longer
  published, and Shutro ERP speaks plain S3, so AWS S3 or MinIO work through `S3_ENDPOINT`)
- Shutro is linked from `../shutro/dist-npm/shutro` until it is published: after changing Shutro, run
  `pnpm pack:npm` there (and `npm install --omit=dev` inside `dist-npm/shutro` once).
- Only `packages/server/src/orm.ts` imports `shutro`; everything else imports `@kosh/server/orm`.

## Tests

- **Adapters are certified against providers' sandboxes**: `pnpm certify [adapter …]` runs their contract suites
  live and records the exchanges (`cassette()` from `@kosh/server/testing`, secrets redacted); `pnpm test` replays
  them. See [integrations.md](integrations.md), Certified against the sandboxes.
- **Integration tests share one PostgreSQL server**, started once per run by Vitest's global setup
  (`packages/server/test/support/postgres.global.ts`); each test file creates a database of its own on it with
  `testDatabase()` from `@kosh/server/testing`, and drops it in `afterAll` with `stop()`. To use a server you
  already run instead of a container: `KOSH_TEST_DATABASE_URL=postgres://user:pass@host:port/postgres pnpm test`.

  ```ts
  import { type TestDatabase, testDatabase } from '@kosh/server/testing';
  let db: TestDatabase;
  beforeAll(async () => { db = await testDatabase(); /* … db.getConnectionUri() … */ });
  afterAll(async () => { await db?.stop(); });
  ```

- **Flaky tests are counted, not hidden.** A failed test runs once more; one that passes only then is listed at
  the end of the run as flaky, with its strikes in `.flaky-ledger.json` (CI keeps the ledger between runs). A test
  reaching three strikes fails the run until it is fixed; a clean pass clears its strikes.
- **E2E never reuses a server.** An interrupted Playwright run can leave its servers on ports 3100 / 3101 / 4173 /
  4174; the next run then stops with "already used" instead of silently sharing a stale database. Stop those
  processes (`netstat -ano | findstr ":3100 :3101 :4173 :4174"`) and run again.
- **The module standard** (RFC 0023) is a function in `packages/cli/src/standard.ts`, run on the repository's
  modules by `pnpm lint` (`scripts/check-modules.ts`, every rule enforced) and on a company's own modules by
  `shutro-erp check` (Bangla and demo data reported, failing only with `--strict`).
- **End-to-end specs wait on state, never on time**: `pnpm lint` refuses `waitForTimeout` in a spec.
- Under heavy machine load the first connection of a test file can time out (the worker is too busy loading
  modules to finish the handshake in 30 s); the shared server makes this rare, and the ledger names it when it
  happens.

