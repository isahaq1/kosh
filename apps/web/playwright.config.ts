import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (RFC 0007 §5): a real Kosh server (PostgreSQL in a container, `e2e/server.ts`) and the built app
 * (`vite preview`, proxying `/api` to it). Run after `pnpm build` (the server uses the built packages).
 */
const API_PORT = 3100;

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // one database for every test file
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure', locale: 'en-US' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
  ],
});
