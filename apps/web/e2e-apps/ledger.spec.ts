/**
 * The stock ledger (RFC 0032 §3.3): the summary by movement type for the period, the movements, and the stock
 * report, each from the server; the XLSX downloads.
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

test('the stock ledger: summary, movements and the stock report; the XLSX downloads', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/stockroom/a/stockroom.action_ledger');
  await expect(page.getByRole('heading', { name: 'Stock ledger' })).toBeVisible();
  await page.getByLabel('From').fill('2020-01-01');
  await expect(page.getByRole('columnheader', { name: 'Purchase receipt' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Movements' }).click();
  await expect(page.getByRole('columnheader', { name: 'Movement' })).toBeVisible();
  await page.getByRole('button', { name: 'Stock', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'On hand' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'XLSX' }).click();
  expect((await download).suggestedFilename()).toMatch(/^stock-report\.xlsx$/);
});
