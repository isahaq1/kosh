/**
 * Stockroom end to end (RFC 0021): Dina receives ten steel beams — the new receipt comes with its locations — and
 * validates it; Rahim delivers four, confirmed and ready because they are reserved, the reservation saying for what;
 * he validates it, and the product shows six on hand.
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

/** A new transfer of `quantity` steel beams from the action's new form, saved and confirmed. */
async function transfer(page: Page, action: string, quantity: string): Promise<string> {
  await page.goto(`/stockroom/a/${action}/new`);
  await expect(page.getByRole('combobox', { name: 'To' })).not.toHaveText(/^$/);
  await page.getByRole('button', { name: 'Add a line' }).click();
  const row = page.locator('tbody tr').last();
  await row.getByRole('combobox').first().click();
  await page.getByRole('option', { name: /Steel beam/ }).click();
  const qty = row.getByRole('textbox').nth(1);
  await qty.fill(quantity);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(new RegExp(`${action.replace('.', '\\.')}/\\d+$`));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('button', { name: /^State: Confirmed/ })).toBeVisible();
  return page.url().replace(/^https?:\/\/[^/]+/, '');
}

test('a receipt in, a delivery reserved, explained and validated; stock on hand follows', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina'); // Stockroom manager
  await transfer(page, 'stockroom.action_receipts', '10');
  await expect(page.getByText('Vendors').first()).toBeVisible();
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByRole('button', { name: /^State: Done/ })).toBeVisible();

  const context = await browser.newContext();
  const rahim = await context.newPage();
  await signIn(rahim, 'rahim'); // Stockroom user
  const delivery = await transfer(rahim, 'stockroom.action_deliveries', '4');
  await expect(rahim.getByText('Everything reserved')).toBeVisible();
  await rahim.goto('/stockroom/a/stockroom.action_reservations');
  await expect(rahim.getByText(/^4 reserved for TR\/\d{4}\/\d{5}$/).first()).toBeVisible();
  await rahim.goto(delivery);
  await rahim.getByRole('button', { name: 'Validate' }).click();
  await expect(rahim.getByRole('button', { name: /^State: Done/ })).toBeVisible();
  await context.close();

  await page.goto('/stockroom/a/stockroom.action_stock');
  const line = page.getByRole('row').filter({ hasText: 'Steel beam' });
  await expect(line).toContainText('6');
});
