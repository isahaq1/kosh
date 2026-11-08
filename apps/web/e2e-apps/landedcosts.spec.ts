/**
 * Landed costs (RFC 0030 §3.3): the Landed costs list in Stockroom and a new one's form with its receipts and costs.
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

test('landed costs in Stockroom: the list and a new one with its receipts and costs', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/stockroom/a/stockroom.action_landed_costs');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByText('Receipts').first()).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Split' })).toBeVisible();
});
