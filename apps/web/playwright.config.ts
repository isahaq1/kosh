import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4173',
    reuseExistingServer: process.env['CI'] === undefined,
  },
});
