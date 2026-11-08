/**
 * RFQs to vendors (RFC 0032 §3.4): an RFQ drafted from the Purchase app; the vendor responses list.
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

test('an RFQ to vendors saved as a draft; the vendor responses', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/purchase/a/purchase.action_tenders/new');
  await page.getByRole('textbox', { name: 'RFQ topic' }).fill('Conveyor rollers');
  await page.getByRole('textbox', { name: 'Response deadline' }).fill('2026-12-01');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/purchase\.action_tenders\/\d+$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('RFQ/');
  await expect(page.getByRole('button', { name: /^State: Draft/ })).toBeVisible();

  await page.goto('/purchase/a/purchase.action_responses');
  await expect(page.getByRole('heading', { name: /Vendor responses/ }).first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
