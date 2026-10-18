import { expect, test } from '@playwright/test';

test('the app shell loads', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Kosh' })).toBeVisible();
});
