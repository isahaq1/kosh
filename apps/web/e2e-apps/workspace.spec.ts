/**
 * RFC 0018 step 1 end to end: an administrator sets the company's brand colour in Settings › Company and the
 * back-office takes it as its accent; a record's state is one chip that opens its workflow; dates are picked on the
 * app's own calendar, by keyboard too.
 */
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

test('the company’s brand colour becomes the accent', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/settings/a/settings.action_company');
  await expect(page.getByRole('heading', { name: 'Brand colour' })).toBeVisible();
  await page.getByRole('button', { name: '#0d9488' }).click();
  await expect(page.getByLabel('Colour', { exact: true })).toHaveValue('#0d9488');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/^Saved/)).toBeVisible();
  await page.reload();
  const hue = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--accent-h'),
  );
  expect(Number(hue)).toBeGreaterThan(170);
  expect(Number(hue)).toBeLessThan(200); // teal
  // Back to the default for the other tests.
  await page.getByRole('button', { name: 'Use the default' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/^Saved/)).toBeVisible();
});

test('the state chip opens the workflow; a date picked on the calendar', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/sales/a/sales.action_orders');
  await page.getByRole('row').nth(1).click();
  await page.getByRole('button', { name: /^State: / }).click();
  await expect(page.locator('[aria-current="step"]')).toBeVisible();
  await expect(page.getByText('Quotation sent')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto('/sales/a/sales.action_quotations');
  await page.getByRole('button', { name: 'New' }).click();
  const valid = page.getByLabel('Valid until');
  await valid.fill('2026-12-31');
  await valid.blur();
  await expect(valid).toHaveValue('31 Dec 2026');
  await page.getByRole('button', { name: 'Pick a date' }).nth(1).click();
  await expect(page.getByRole('button', { name: '31 Dec 2026' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(valid).toHaveValue('30 Dec 2026');
});
