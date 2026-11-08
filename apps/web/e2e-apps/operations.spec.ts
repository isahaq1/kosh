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

test('My operations: a card per warehouse and kind, each count opening its transfers', async ({
  page,
}) => {
  await signIn(page, 'dina');
  // A receipt waiting in the main warehouse, with its transport details.
  await page.goto('/stockroom/a/stockroom.action_receipts/new');
  await page.getByRole('textbox', { name: 'Vehicle number' }).fill('DHAKA-METRO-TA-11-2233');
  await page.getByRole('textbox', { name: 'Driver', exact: true }).fill('Karim');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/stockroom\.action_receipts\/\d+$/);
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Validate', exact: true })).toBeVisible();

  await page.goto('/stockroom/a/stockroom.action_operations');
  const card = page.getByRole('region', { name: /: Receipts$/ }).first();
  await expect(card).toBeVisible();
  await card.getByRole('link', { name: /ready/ }).click();
  await expect(page).toHaveURL(/stockroom\.action_receipts/);
  await expect(page.getByRole('row').nth(1)).toBeVisible();
});
