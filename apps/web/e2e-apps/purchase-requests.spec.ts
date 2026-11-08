/**
 * Purchase requests (RFC 0032 §3.4): a request drafted from the Purchase app and the line tracker.
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

test('a purchase request saved as a draft; the line tracker with its filters', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/purchase/a/purchase.action_requests/new');
  await page.getByRole('textbox', { name: 'Purpose' }).fill('Spare belts for the pellet mill');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/purchase\.action_requests\/\d+$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('PR/');
  await expect(page.getByRole('button', { name: /^State: Draft/ })).toBeVisible();

  await page.goto('/purchase/a/purchase.action_request_lines');
  await expect(page.getByRole('heading', { name: /Request lines/ }).first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
