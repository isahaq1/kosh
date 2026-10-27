import { defineConfig, devices } from '@playwright/test';

/**
 * The portal's end-to-end tests (RFC 0015 step 3): a real Kosh server with the portal bridges (`e2e/server.ts`) and
 * the built portal (`vite preview`, proxying `/api` to it). Run after `pnpm build` (the server uses built packages).
 */
const API_PORT = 3102;
const WEB_PORT = 5175;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    locale: 'en-US',
    acceptDownloads: true,
  },
  projects: [{ name: 'portal', use: { ...devices['Pixel 7'] } }],
  webServer: [
    {
      command: 'node e2e/server.ts',
      url: `http://127.0.0.1:${API_PORT}/health/ready`,
      timeout: 240_000,
      reuseExistingServer: process.env['CI'] === undefined,
      env: {
        KOSH_E2E_PORTAL_PORT: String(API_PORT),
        KOSH_PORTAL_URL: `http://localhost:${WEB_PORT}`,
      },
      stdout: 'pipe',
    },
    {
      command: `pnpm exec vite build && pnpm exec vite preview --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      timeout: 180_000,
      reuseExistingServer: process.env['CI'] === undefined,
      env: { KOSH_API: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
