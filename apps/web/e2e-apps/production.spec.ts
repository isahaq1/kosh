/**
 * Production end to end (RFC 0021): Dina makes a product and its bill of materials (one steel beam per frame), opens
 * a production order — its bill chosen for her — checks the components (what is required, available, short, and the
 * cost), and confirms it: the components are reserved through Stockroom.
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

async function pick(page: Page, field: string, option: RegExp): Promise<void> {
  await page.getByRole('combobox', { name: field }).click();
  await page.getByRole('option', { name: option }).click();
}

test('a bill of materials, an order checked for what is short and what it costs, confirmed', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/product/a/product.action_products/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Frame');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/product\.action_products\/\d+$/);

  await page.goto('/production/a/production.action_boms/new');
  await pick(page, 'Product', /E2E Frame/);
  const lines = page.getByRole('table', { name: 'lines' });
  await lines.locator('..').getByRole('button', { name: 'Add a line' }).click();
  await lines.locator('tbody tr').last().getByRole('combobox').first().click();
  await page.getByRole('option', { name: /Steel beam/ }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/production\.action_boms\/\d+$/);

  await page.goto('/production/a/production.action_orders/new');
  await pick(page, 'Product', /E2E Frame/);
  await expect(page.getByRole('combobox', { name: 'Bill of materials' })).toContainText(
    'E2E Frame v1',
  );
  await page.getByRole('textbox', { name: 'Quantity', exact: true }).fill('2');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/production\.action_orders\/\d+$/);
  await page.getByRole('button', { name: 'Check components' }).click();
  const components = page.getByRole('table', { name: 'components' });
  await expect(components.getByRole('row').filter({ hasText: 'Steel beam' })).toBeVisible();
  await expect(page.getByText('Total cost')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('button', { name: /^State: Confirmed/ })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Components transfer' })).toContainText('TR/');

  // The work centres' schedule opens on its Gantt.
  await page.goto('/production/a/production.action_workorders');
  await expect(page.getByRole('main')).toContainText('Work orders');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the Production overview (RFC 0022 step 2)', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/production/a/mrp.action_overview');
  await expect(page.getByRole('heading', { name: 'Production · Overview' })).toBeVisible();
  for (const title of ['Orders confirmed', 'Work centres', 'Orders by state'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
