import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (RFC 0007 §5): a real Kosh server (PostgreSQL in a container, `e2e/server.ts`) and the built app
 * (`vite preview`, proxying `/api` to it). Run after `pnpm build` (the server uses the built packages).
 */
const API_PORT = 3100;
/** The business apps' server (`e2e-apps/server.ts`) and the preview proxying to it (project `apps`). */
const APPS_API_PORT = 3101;
const APPS_WEB_PORT = 4174;

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // one database for every test file
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure', locale: 'en-US' },
  projects: [
    { name: 'chromium', testDir: './e2e', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'apps',
      testDir: './e2e-apps',
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${APPS_WEB_PORT}` },
    },
  ],
  webServer: [
    {
      command: 'node e2e/server.ts',
      url: `http://127.0.0.1:${API_PORT}/health/ready`,
      timeout: 180_000,
      reuseExistingServer: process.env['CI'] === undefined,
      env: { KOSH_E2E_PORT: String(API_PORT) },
      stdout: 'pipe',
    },
    {
      command: 'pnpm exec vite build && pnpm preview',
      url: 'http://localhost:4173',
      timeout: 180_000,
      reuseExistingServer: process.env['CI'] === undefined,
      env: { KOSH_API: `http://127.0.0.1:${API_PORT}` },
    },
    {
      command: 'node e2e-apps/server.ts',
      url: `http://127.0.0.1:${APPS_API_PORT}/health/ready`,
      timeout: 240_000,
      reuseExistingServer: process.env['CI'] === undefined,
      env: { KOSH_E2E_APPS_PORT: String(APPS_API_PORT) },
      stdout: 'pipe',
    },
    {
      command: `pnpm exec vite preview --port ${APPS_WEB_PORT} --strictPort`,
      url: `http://localhost:${APPS_WEB_PORT}`,
      timeout: 180_000,
      reuseExistingServer: process.env['CI'] === undefined,
      env: { KOSH_API: `http://127.0.0.1:${APPS_API_PORT}` },
    },
  ],
});
