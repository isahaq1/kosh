/**
 * Overheads and costing (RFC 0031 step 5): the costing master form; the overhead allocations list.
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

test('a costing master form with its overheads; the allocations list', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/production/a/production_account.action_costings/new');
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Product', exact: true })).toBeVisible();
  await page.goto('/production/a/production_account.action_allocations');
  await expect(page.getByRole('heading', { name: /Overhead allocations/ }).first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
