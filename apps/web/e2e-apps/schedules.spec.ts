/**
 * Batches (RFC 0031 step 4): the new batch form; the batches list and Gantt open.
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

test('a batch form with its target and slot; the batches list', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/production/a/production.action_schedules/new');
  await expect(page.getByRole('combobox', { name: 'Product', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Target' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Packaging bill' })).toBeVisible();
  await page.goto('/production/a/production.action_schedules');
  await expect(page.getByRole('heading', { name: /Batches/ }).first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
