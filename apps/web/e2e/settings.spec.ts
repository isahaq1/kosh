/**
 * RFC 0019 step 1 end to end: Settings opens on its overview, whose search finds a section by its words; your
 * profile from the user menu — details saved, this device among the signed-in ones, two-factor sign-in set up with
 * the key shown (recovery codes once) and turned off again.
 */
import { totp } from '@kosh/server';
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

test('Settings opens on its overview; its search finds a section by its words', async ({
  page,
}) => {
  await signIn(page, 'admin');
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
  await page.getByLabel('Search settings').fill('lakh');
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: /^Company/ })).toBeVisible();
  await expect(main.getByRole('link', { name: /^App manager/ })).toHaveCount(0);
  await main.getByRole('link', { name: /^Company/ }).click();
  await expect(page.getByRole('heading', { name: 'Company', level: 1 })).toBeVisible();
});

test('your profile: details saved, this device listed, two-factor on and off', async ({ page }) => {
  await signIn(page, 'rahim');
  await page.getByRole('button', { name: 'Rahim Uddin' }).click();
  await page.getByRole('menuitem', { name: 'Your profile' }).click();
  await expect(page.getByRole('heading', { name: 'Your profile', level: 1 })).toBeVisible();

  await page.getByLabel('Phone').fill('+880 1711 223344');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Phone')).toHaveValue('+880 1711 223344');

  const devices = page.getByRole('region', { name: 'Signed-in devices' });
  await expect(devices.getByText('This device')).toBeVisible();

  const twoFactor = page.getByRole('region', { name: 'Two-factor sign-in' });
  await twoFactor.getByRole('button', { name: 'Set up' }).click();
  const secret = ((await twoFactor.locator('code').textContent()) ?? '').trim();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await twoFactor.getByLabel('Code').fill(totp(secret));
  await twoFactor.getByRole('button', { name: 'Turn on' }).click();
  await expect(twoFactor.getByText(/Your recovery codes/)).toBeVisible();
  await expect(twoFactor.getByText('On', { exact: true })).toBeVisible();

  await twoFactor.locator('summary').click();
  await twoFactor.getByLabel('Password').fill('correct horse battery');
  await twoFactor.getByLabel('Code').fill(totp(secret));
  await twoFactor.getByRole('button', { name: 'Turn off two-factor sign-in' }).click();
  await expect(twoFactor.getByText('Off', { exact: true })).toBeVisible();
});
