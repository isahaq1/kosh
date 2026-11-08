/**
 * Vendor prices (RFC 0030 §3.1): the Vendor prices list in Purchase, and purchase lines that say why they have
 * their price.
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

test('vendor prices in Purchase; a purchase line says why it has its price', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/purchase/a/purchase.action_vendor_prices');
  await expect(page.getByRole('heading', { name: /Vendor prices/ }).first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  // A new request for quotation: its lines show the vendor's code and why each price.
  await page.goto('/purchase/a/purchase.action_rfqs');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Why this price' })).toBeVisible();
});
