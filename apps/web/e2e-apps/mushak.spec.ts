/**
 * Bangladesh end to end (RFC 0016 step 4): on an installation with `l10n_bd`, an accountant opens Accounting ›
 * Reporting › Mushak returns, sees the month's posted invoice in the sales register with its VAT, switches to the
 * monthly return (9.1) and downloads it as a workbook.
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

test('the sales register shows the month’s invoice; the monthly return downloads as XLSX', async ({
  page,
}) => {
  await signIn(page, 'rahim');
  await page.goto('/accounting/a/l10n_bd.action_mushak');
  await expect(page.getByRole('heading', { name: 'Mushak returns' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sales register (6.2)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // The seeded invoice: 5 steel beams at 1,000, VAT 15 %.
  const row = page.getByRole('row', { name: /Steel beam/ }).first();
  await expect(row).toContainText('5,000.00');
  await expect(row).toContainText('750.00');
  await expect(row).toContainText('Standard rate (15 %)');

  await page.getByRole('button', { name: 'Monthly return (9.1)' }).click();
  await expect(page.getByRole('columnheader', { name: 'Part 7 — net tax' })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'Output VAT' })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download XLSX' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^mushak-9\.1-\d{4}-\d{2}\.xlsx$/);
});
