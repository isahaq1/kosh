/**
 * Guidance on a record (RFC 0022 §3.4): a new quotation without lines says what blocks confirming it, from the
 * server's guard; once a line is added, the banner offers the next step and runs it.
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

test('a quotation: what blocks Confirm, then the next step offered and taken', async ({ page }) => {
  await signIn(page, 'rahim');
  await page.goto('/sales/a/sales.action_quotations/new');
  await page.getByRole('combobox', { name: 'Customer' }).click();
  await page.getByRole('option', { name: /Bengal Steel/ }).click();
  await page.getByRole('combobox', { name: 'Currency' }).click();
  await page.getByRole('option', { name: 'BDT' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/sales\.action_quotations\/\d+$/);
  await expect(page.getByRole('alert').filter({ hasText: 'Before Confirm' })).toContainText(
    'Add at least one line before confirming the order.',
  );
  const lines = page.getByRole('table', { name: 'lines' });
  await lines.locator('..').getByRole('button', { name: 'Add a line' }).click();
  const row = lines.locator('tbody tr').last();
  await row.getByRole('combobox').first().click();
  await page.getByRole('option').first().click();
  // The description, quantity and price (the product's onchange may fill them; set them anyway).
  await row.getByRole('textbox').nth(0).fill('Steel beam');
  await row.getByRole('textbox').nth(1).fill('2');
  await row.getByRole('textbox').nth(2).fill('1000');
  await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().includes('/sale.order/'),
    ),
    page.getByRole('button', { name: 'Save' }).click(),
  ]);
  const ready = page.getByRole('status').filter({ hasText: 'Next step: Confirm' });
  await expect(ready).toBeVisible();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('button', { name: /^State: Sales order/ })).toBeVisible();
});
