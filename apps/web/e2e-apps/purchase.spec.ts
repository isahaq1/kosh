/**
 * Purchase, deeper (RFC 0022 step 2): the Overview with spend and what waits; the calendar of expected arrivals;
 * the margin shown on a sales order.
 */
import { expect, type Page, test } from '@playwright/test';

const PASSWORD = 'correct horse battery';

async function signIn(page: Page, login: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
}

test('the Purchase overview and the arrivals calendar; the margin on a sales order', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/purchase/a/purchase.action_overview');
  await expect(page.getByRole('heading', { name: 'Purchase · Overview' })).toBeVisible();
  for (const title of ['Purchases this month', 'Open requests', 'Top vendors'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
  await page.goto('/purchase/a/purchase.action_orders?view=calendar');
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.goto('/sales/a/sales.action_orders');
  await page
    .getByRole('row', { name: /Bengal Steel/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('SO/');
  await expect(page.getByText('Margin (%)')).toBeVisible();
});
