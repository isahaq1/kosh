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
  published, and Kosh speaks plain S3, so AWS S3 or MinIO work through `S3_ENDPOINT`)
- Shutro is linked from `../shutro/dist-npm/shutro` until it is published: after changing Shutro, run
  `pnpm pack:npm` there (and `npm install --omit=dev` inside `dist-npm/shutro` once).
- Only `packages/server/src/orm.ts` imports `shutro`; everything else imports `@kosh/server/orm`.
