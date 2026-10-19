import { totp } from '@isahaq/kosh-server';
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

/** Opens an app from the launcher. */
export async function openApp(page: Page, label: string): Promise<void> {
  await page.getByRole('link', { name: label }).click();
}
