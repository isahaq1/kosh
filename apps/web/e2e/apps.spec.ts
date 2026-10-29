/**
 * The App manager (RFC 0008): an Administrator installs an app from Settings → Apps (plan first, then one
 * transaction), it is in the launcher at once with its seed data, and disabling it removes it from the launcher
 * while its data stays; the page passes axe in light and dark, and users without the App manager access do not see
 * Settings and are refused by the server.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { choose, openApp, openAppManager, signIn } from './support.js';

async function axe(page: Page, where: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious.map(
      (v) => `${where}: ${v.id} ${v.help} at ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
    ),
  ).toEqual([]);
}

const card = (page: Page, summary: string) =>
  page.getByRole('listitem').filter({ hasText: summary });

test('install an app, use it, disable it: the data stays', async ({ page }) => {
  await signIn(page, 'admin');
  await expect(page.getByRole('link', { name: 'Library' })).toHaveCount(0);

  await openAppManager(page);
  await expect(page.getByRole('heading', { name: 'Apps', level: 1 })).toBeVisible();
  const library = card(page, 'Books and their authors');
  await expect(library.getByText('Available')).toBeVisible();
  await library.getByRole('button', { name: 'Install Library' }).click();

  const install = page.getByRole('dialog', { name: 'Install Library?' });
  await expect(install.getByText('Will be installed')).toBeVisible();
  await expect(install.getByText(/database changes?, applied in one transaction/)).toBeVisible();
  await install.getByText('Show the SQL').click();
  await expect(install.getByText(/CREATE TABLE/).first()).toBeVisible();
  await install.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByText('Done: installed Library.')).toBeVisible();
  await expect(library.getByText('Installed')).toBeVisible();

  // In the launcher at once, with its seed data.
  await page.goto('/');
  await openApp(page, 'Library');
  await expect(page.getByRole('cell', { name: 'Welcome to the library' })).toBeVisible();

  await page.goto('/');
  await openAppManager(page);
  await card(page, 'Books and their authors')
    .getByRole('button', { name: 'Disable Library' })
    .click();
  const disable = page.getByRole('dialog', { name: 'Disable Library?' });
  await expect(disable.getByText('tables and data stay')).toBeVisible();
  await expect(disable.getByText('No database changes.')).toBeVisible();
  await disable.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(page.getByText('Done: disabled Library.')).toBeVisible();
  await expect(card(page, 'Books and their authors').getByText('Disabled')).toBeVisible();

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Library' })).toHaveCount(0);
});

for (const theme of ['Light', 'Dark'] as const)
  test(`the Apps page passes axe (${theme})`, async ({ page }) => {
    await signIn(page, 'admin');
    await choose(page, 'Theme', theme);
    await openAppManager(page);
    await expect(page.getByRole('heading', { name: 'Apps', level: 1 })).toBeVisible();
    await axe(page, `apps ${theme}`);
  });

test('without the App manager access: no Settings, and the server refuses', async ({ page }) => {
  await signIn(page, 'bob');
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  const res = await page.request.get('/api/v1/settings/apps');
  expect(res.status()).toBe(403);
});

test('the Apps page in Bangla', async ({ page }) => {
  await signIn(page, 'admin');
  await choose(page, 'Language', 'বাংলা');
  await openAppManager(page);
  await expect(
    page.getByText('আপনার ব্যবসার প্রয়োজনীয় অ্যাপগুলো ইনস্টল করুন।', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'সব', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    card(page, 'Books and their authors').getByRole('button', { name: 'সক্রিয় করুন Library' }),
  ).toBeVisible(); // Library is disabled after the first test
  // Back to English for the next tests (the language is the user's preference).
  await page.getByRole('button', { name: 'ভাষা' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'English' }).click();
});
