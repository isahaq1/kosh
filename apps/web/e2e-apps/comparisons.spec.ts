/**
 * Comparative statements (RFC 0032 §3.4): the statements and technical comparisons lists open for a buyer.
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

test('comparative statements and technical comparisons', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/purchase/a/purchase.action_comparisons');
  await expect(page.getByRole('heading', { name: /Comparative statements/ }).first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.goto('/purchase/a/purchase.action_technical_comparisons/new');
  await expect(page.getByRole('combobox', { name: 'Assigned engineer' })).toContainText('Dina');
  await page.goto('/purchase/a/purchase.action_overview');
  await expect(
    page.getByRole('region', { name: 'Comparative statements waiting', exact: true }),
  ).toBeVisible();
});
