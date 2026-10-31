/**
 * RFC 0020 step 1 end to end: Settings › App settings lists the apps with settings; Sales' quotation settings are
 * changed and saved (kept after a reload, marked as changed), then reset to the default; Accounting's section is
 * there too. The overview's search finds the page by a setting's words. Step 2: a setting's history shows the
 * change; the settings export as a file, and such a file imports after a preview of what changes.
 */
import { readFileSync } from 'node:fs';
import { totp } from '@kosh/server';
import { expect, type Page, test } from '@playwright/test';

const PASSWORD = 'correct horse battery';

async function signInAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Login').fill('admin');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Authentication code').fill(totp('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
}

test('the apps’ own settings: changed, kept, marked, reset; found by the Settings search', async ({
  page,
}) => {
  await signInAdmin(page);
  await page.goto('/settings');
  await page.getByLabel('Search settings').fill('validity');
  await page
    .getByRole('main')
    .getByRole('link', { name: /^App settings/ })
    .click();

  const apps = page.getByRole('navigation', { name: 'Apps' });
  await expect(apps.getByRole('button', { name: 'Accounting' })).toBeVisible();
  await apps.getByRole('button', { name: 'Sales' }).click();
  const quotations = page.getByRole('region', { name: 'Quotations' });
  await expect(quotations.getByText('For this company')).toBeVisible();
  const days = quotations.getByRole('spinbutton', { name: /Quotations valid for/ });
  await expect(days).toHaveValue('30');
  await days.fill('10');
  await quotations
    .getByRole('textbox', { name: /Default terms and conditions/ })
    .fill('Payment within 15 days.');
  await quotations.getByRole('button', { name: 'Save' }).click();
  await expect(quotations.getByText('Saved.')).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/app=sales/);
  const again = page.getByRole('region', { name: 'Quotations' });
  await expect(again.getByRole('spinbutton', { name: /Quotations valid for/ })).toHaveValue('10');
  await expect(again.getByText('Changed').first()).toBeVisible();
  await again.getByRole('button', { name: /History of Quotations valid for/ }).click();
  const history = page.getByRole('dialog', { name: /History of Quotations valid for/ });
  await expect(history).toContainText('30');
  await expect(history).toContainText('10');
  await expect(history).toContainText('changed');
  await page.keyboard.press('Escape');
  await again.getByRole('button', { name: /Reset Quotations valid for/ }).click();
  await expect(again.getByRole('spinbutton', { name: /Quotations valid for/ })).toHaveValue('30');

  // Export: a JSON file of the installation's and the company's settings.
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^app-settings-.*\.json$/);
  const path = await download.path();
  const exported = JSON.parse(readFileSync(path, 'utf8')) as {
    companySettings: Record<string, Record<string, unknown>>;
  };
  expect(exported.companySettings['sales.quotations']).toMatchObject({ saleValidityDays: 30 });
  // Import: the same file with 45 days — previewed (30 → 45), then applied.
  exported.companySettings['sales.quotations'] = {
    ...exported.companySettings['sales.quotations'],
    saleValidityDays: 45,
  };
  await page.getByLabel('Settings file to import').setInputFiles({
    name: 'settings.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  const importing = page.getByRole('dialog', { name: 'Import settings' });
  await expect(importing).toContainText('Sales › Quotations');
  await expect(importing).toContainText('45');
  await importing.getByRole('button', { name: 'Import the settings' }).click();
  await expect(page.getByText(/Settings imported/)).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Quotations' })
      .getByRole('spinbutton', { name: /Quotations valid for/ }),
  ).toHaveValue('45');
  await page
    .getByRole('region', { name: 'Quotations' })
    .getByRole('button', { name: /Reset Quotations valid for/ })
    .click();

  await apps.getByRole('button', { name: 'Accounting' }).click();
  await expect(page.getByRole('region', { name: 'Fiscal year and lock dates' })).toBeVisible();
});
