import { totp } from '@kosh/server';
import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'correct horse battery';
const ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** Signs in through the UI (the session cookie and CSRF token are set as for a real user). */
export async function signIn(page: Page, login: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (login === 'admin') {
    await page.getByLabel('Authentication code').fill(totp(ADMIN_TOTP_SECRET));
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
}

/**
 * Picks a theme or a language: from the account menu in the home page's corner, or from the page bar inside an app.
 * `menu` is the page bar's button (Theme, Language) when there is no account menu.
 */
export async function choose(page: Page, menu: string, item: string): Promise<void> {
  const corner = page.locator('[data-kosh-account="corner"]');
  if ((await corner.count()) > 0) await corner.click();
  else await page.getByRole('button', { name: menu }).click();
  await page.getByRole('menuitemcheckbox', { name: item }).click();
  await page.keyboard.press('Escape');
}

/** Opens an app from the launcher. */
export async function openApp(page: Page, label: string): Promise<void> {
  await page.getByRole('link', { name: label }).click();
}

/** Opens Settings › App manager (Settings opens on its overview). */
export async function openAppManager(page: Page): Promise<void> {
  await page.goto('/settings/a/settings.action_apps');
}
