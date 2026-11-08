/**
 * Explain popovers (RFC 0031 §3.1): a developer turns Developer mode on from the user menu; a contact's field label
 * then opens a dark card saying what the field is; the page title lists the model's relations.
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

test('Developer mode: fields and models explain themselves on hover', async ({ page }) => {
  await signIn(page, 'dina');
  await page.getByRole('button', { name: 'Dina Rahman' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Developer mode' }).click();
  await page.keyboard.press('Escape');
  await page.goto('/contacts/a/contacts.action_partners/new');
  const email = page
    .locator('[data-kosh-explain]')
    .filter({ hasText: /^Email$/ })
    .first();
  await email.hover();
  const card = page.locator('[data-radix-popper-content-wrapper]').last();
  await expect(card).toContainText('res.partner');
  await expect(card).toContainText('email');
  await expect(card).toContainText('char');
  // Off again: no popovers.
  await page.getByRole('button', { name: 'Dina Rahman' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Developer mode' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-kosh-explain]')).toHaveCount(0);
});
