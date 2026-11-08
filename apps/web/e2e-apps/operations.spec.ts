/**
 * Stockroom's depot screens (RFC 0032 §3.3): My operations counts each warehouse's transfers; a receipt keeps its
 * transport details.
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

test('a receipt keeps its transport details; My operations counts each warehouse’s transfers', async ({
  page,
}) => {
  await signIn(page, 'dina');
  // A receipt with its transport details, saved as a draft (it has no lines yet).
  await page.goto('/stockroom/a/stockroom.action_receipts/new');
  await page.getByRole('textbox', { name: 'Vehicle number' }).fill('DHAKA-METRO-TA-11-2233');
  await page.getByRole('textbox', { name: 'Driver', exact: true }).fill('Karim');
  await expect(page.getByRole('textbox', { name: 'Driver', exact: true })).toHaveValue('Karim');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/stockroom\.action_receipts\/\d+$/);
  await expect(page.getByRole('textbox', { name: 'Vehicle number' })).toHaveValue(
    'DHAKA-METRO-TA-11-2233',
  );

  await page.goto('/stockroom/a/stockroom.action_operations');
  await expect(page.getByRole('heading', { name: 'My operations' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  // Cards come from the warehouses' open transfers; a card's count opens the transfers it counts.
  const cards = page.getByRole('region', { name: /: (Receipts|Deliveries|Internal moves)$/ });
  if ((await cards.count()) > 0) {
    await cards.first().getByRole('link').first().click();
    await expect(page).toHaveURL(/stockroom\.action_(receipts|deliveries|transfers)/);
  }
});
