/**
 * Returns (RFC 0030 §3.2): the Returns list in Stockroom and the reasons a return gives.
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

test('Stockroom lists returns and the reasons they give', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/stockroom/a/stockroom.action_returns');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.goto('/stockroom/a/stockroom.action_return_reasons');
  for (const reason of ['Damaged', 'Wrong item', 'Not as ordered'])
    await expect(page.getByRole('row', { name: new RegExp(reason) })).toBeVisible();
});
