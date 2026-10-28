/**
 * India end to end (RFC 0016 step 5, part 3): an accountant opens Accounting › Reporting › GST returns, sees GSTR-1
 * by section, switches to GSTR-3B and its tax payable, downloads GSTR-1 as the GST portal's JSON, and finds the
 * company's GST settings (without an IRP provider here).
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

test('GSTR-1 by section, GSTR-3B with the tax payable, the portal JSON', async ({ page }) => {
  await signIn(page, 'rahim');
  await page.goto('/accounting/a/l10n_in.action_gst');
  await expect(page.getByRole('heading', { name: 'GST returns' })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: /4A B2B invoices/ })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: /7 B2C others/ })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'JSON for the GST portal' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^GSTR-1_.+_\d{6}\.json$/);

  await page.getByRole('button', { name: 'GSTR-3B' }).click();
  await expect(
    page.getByRole('rowheader', { name: '3.1 (a) Outward taxable supplies' }),
  ).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '6.1 Payment of tax' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'JSON for the GST portal' })).toHaveCount(0);
  // The company's GST settings: no IRP provider in this installation.
  await expect(page.getByRole('heading', { name: 'Company GST settings' })).toBeVisible();
  await expect(page.getByText(/No IRP provider is set up/)).toBeVisible();
});
