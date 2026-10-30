/**
 * Stockroom end to end (RFC 0021): Dina expects ten steel beams — the new receipt comes with its locations — and
 * validates the six that arrived, the other four going to a backorder that is ready; Rahim delivers four, confirmed
 * and ready because they are reserved, the reservation saying for what; he validates it, and two are left on hand.
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

test('a receipt in part with its backorder, a delivery reserved, explained and validated; stock follows', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina'); // Stockroom manager
  const receipt = await transfer(page, 'stockroom.action_receipts', '10');
  await expect(page.getByText('Vendors').first()).toBeVisible();
  // Six of the ten arrive: the rest goes to a backorder.
  await page.locator('tbody tr').last().getByRole('textbox').last().fill('6');
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' && /\/stock\.picking\/\d+$/.test(new URL(r.url()).pathname),
  );
  await page.getByRole('button', { name: 'Save' }).click();
  await saved;
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByRole('button', { name: /^State: Done/ })).toBeVisible();
  await page.goto('/stockroom/a/stockroom.action_receipts');
  const backorder = page.getByRole('row').filter({ hasText: 'Ready' });
  await expect(backorder).toHaveCount(1);
  expect(receipt).toMatch(/\d+$/);

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
  await expect(line).toContainText('2'); // six in, four out
});

test('a count: started, an unknown barcode reported, a line counted and applied; stock follows', async ({
  page,
}) => {
  await signIn(page, 'dina'); // Stockroom manager
  await page.goto('/stockroom/a/stockroom.action_counts/new');
  await page.getByRole('combobox', { name: 'Location' }).click();
  await page.getByRole('option', { name: 'WH/Stock' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/stockroom\.action_counts\/\d+$/);
  await page.getByRole('button', { name: 'Start counting' }).click();
  await expect(page.getByRole('button', { name: /^State: Counting/ })).toBeVisible();

  await page.getByRole('textbox', { name: 'Barcode' }).fill('0000000');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'No product has the barcode' }),
  ).toBeVisible();

  const beam = page.locator('tbody tr').filter({ hasText: 'Steel beam' });
  await beam.getByRole('textbox').last().fill('1');
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' && /\/stock\.count\/\d+$/.test(new URL(r.url()).pathname),
  );
  await page.getByRole('button', { name: 'Save' }).click();
  await saved;
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByRole('button', { name: /^State: Applied/ })).toBeVisible();

  await page.goto('/stockroom/a/stockroom.action_stock');
  await expect(page.getByRole('row').filter({ hasText: 'Steel beam' })).toContainText('1');
});
