/**
 * Agreements, work acceptance and vendor requests (RFC 0032 §3.4): the Purchase menus and the order's new fields.
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

test('a vendor request drafted; the order form has its PO type, sourcing and advance; agreements open', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/purchase/a/purchase.action_vendor_requests/new');
  await page.getByRole('textbox', { name: 'Vendor name' }).fill('Meghna Engineering');
  await page.getByRole('textbox', { name: 'City' }).fill('Narayanganj');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/purchase\.action_vendor_requests\/\d+$/);
  await expect(page.getByRole('button', { name: /^State: Draft/ })).toBeVisible();

  await page.goto('/purchase/a/purchase.action_rfqs/new');
  await expect(page.getByRole('combobox', { name: 'PO type' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Sourcing' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Advance (%)' })).toBeVisible();

  await page.goto('/purchase/a/purchase.action_agreements');
  await expect(page.getByRole('heading', { name: /Agreements/ }).first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
