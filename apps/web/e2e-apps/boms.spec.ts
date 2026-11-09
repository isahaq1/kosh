/**
 * Bills of materials in depth (RFC 0031 step 2): the bill's kind and state on its form; the configuration menus.
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

test('a bill has its kind, batch fields and state; specification parameters and shifts open', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/production/a/production.action_boms/new');
  await expect(page.getByRole('combobox', { name: 'Kind' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Expected loss (%)' })).toBeVisible();
  // The state buttons show on saved bills only (the integration test covers the review and approval).
  await page.goto('/production/a/production.action_spec_parameters');
  await expect(
    page.getByRole('heading', { name: /Specification parameters/ }).first(),
  ).toBeVisible();
  await page.goto('/production/a/production.action_shifts');
  await expect(page.getByRole('heading', { name: /Shifts/ }).first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
