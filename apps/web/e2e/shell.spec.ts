/**
 * The shell: sign-in (with 2FA for administrators), apps and menus per role (installing a module grants nothing),
 * languages (Bangla; Arabic switches the layout to right-to-left), themes, sign-out.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

test('a wrong password is refused with a clear message', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Login').fill('rahim');
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('The login or password is wrong.');
});

test('apps follow the roles: a user without roles sees none', async ({ page }) => {
  await signIn(page, 'bob');
  await expect(page.getByText('No apps are available to you yet.')).toBeVisible();
  await page.goto('/contacts/a/contacts.action_partners');
  await expect(page.getByRole('alert')).toContainText('not available');
});

test('requesters see their apps and menus', async ({ page }) => {
  await signIn(page, 'rahim');
  const apps = page.getByRole('main').getByRole('link');
  await expect(apps).toHaveText(['Contacts', 'Purchase', /^Chat/, 'Reports']);
  await page.getByRole('link', { name: 'Purchase' }).click();
  await expect(page).toHaveURL(/\/purchase\/a\/purchase\.action_orders/);
  await expect(
    page.getByRole('navigation', { name: 'Main menu' }).getByRole('link', { name: 'Orders' }),
  ).toHaveAttribute('aria-current', 'page');
});

test('the sidebar: apps open their sections; collapsed with Ctrl+B and remembered; a drawer on phones', async ({
  page,
}) => {
  await signIn(page, 'rahim');
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  await sidebar.getByRole('button', { name: 'Purchase app' }).click();
  await expect(page).toHaveURL(/\/purchase\/a\/purchase\.action_orders/);
  await expect(sidebar.getByRole('button', { name: 'Purchase app' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  // The page bar says where the user is.
  const here = page.getByRole('navigation', { name: 'You are here' });
  await expect(here).toContainText('Purchase');
  await expect(here).toContainText('Orders');

  await page.keyboard.press('Control+b');
  await expect(sidebar.getByRole('button', { name: 'Expand the sidebar' })).toBeVisible();
  await page.reload();
  await expect(sidebar.getByRole('button', { name: 'Expand the sidebar' })).toBeVisible();
  await sidebar.getByRole('button', { name: 'Expand the sidebar' }).click();
  await expect(sidebar.getByRole('button', { name: 'Collapse the sidebar' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar).toBeHidden();
  await page.getByRole('button', { name: 'Open the menu' }).click();
  const drawer = page.getByRole('dialog', { name: 'Main menu' });
  await drawer.getByRole('button', { name: 'Contacts app' }).click();
  await expect(drawer).toBeHidden(); // following a link closes it
  await expect(page).toHaveURL(/\/contacts\//);
});

test('administrators sign in with a second factor', async ({ page }) => {
  await signIn(page, 'admin');
  await expect(page.getByText('Administrator rights apply after')).toHaveCount(0);
  // The home page's apps (each tile also carries the app's summary).
  await expect(page.getByRole('region', { name: 'Apps' }).getByRole('link')).toHaveText([
    /^Contacts/,
    /^Purchase/,
    /^Chat/,
    /^Reports/,
    /^Integrations/,
    /^Automation/,
    /^Email/,
    /^Studio/,
    /^Settings/, // administrators see every installed app
  ]);
});

test('Bangla labels; Arabic switches to right-to-left; dark theme', async ({ page }) => {
  await signIn(page, 'rahim');
  await page.getByRole('button', { name: 'Language' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'বাংলা' }).click();
  await expect(page.getByRole('heading', { name: 'অ্যাপস' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'bn-BD');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

  await page.getByRole('button', { name: 'ভাষা' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'العربية' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'التطبيقات' })).toBeVisible();
  // Logical properties: the sidebar (with the user menu) sits at the inline start, i.e. on the right in RTL.
  const box = await page.getByRole('button', { name: 'Rahim Uddin' }).boundingBox();
  expect(box?.x ?? 0).toBeGreaterThan(900);

  await page.getByRole('button', { name: 'اللغة' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'English' }).click();
  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/); // remembered
});

test('sign out ends the session', async ({ page }) => {
  await signIn(page, 'rahim');
  await page.getByRole('button', { name: 'Rahim Uddin' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});
