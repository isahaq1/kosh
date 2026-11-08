/**
 * Requests end to end (RFC 0032 §3.1): Nadia starts an indent — the store and the internal-use location filled in
 * for her —, and Dina, a Requests manager, finds the Requests overview with what waits.
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

test('a new indent: the store and where the goods are used filled in, saved as a draft', async ({
  page,
}) => {
  await signIn(page, 'nadia');
  await page.goto('/requests/a/requests.action_indents/new');
  await page.getByRole('textbox', { name: 'Purpose' }).fill('Bearings for the pellet mill');
  await page.getByRole('textbox', { name: 'Purpose' }).blur();
  await expect(page.getByRole('combobox', { name: 'Used at' })).toContainText('Internal use');
  await expect(page.getByRole('combobox', { name: 'Store' })).not.toHaveText('');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/requests\.action_indents\/\d+$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('IND/');
  await expect(page.getByRole('button', { name: /^State: Draft/ })).toBeVisible();
});

test('the Requests overview', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/requests/a/indent.action_overview');
  await expect(page.getByRole('heading', { name: 'Requests · Overview' })).toBeVisible();
  for (const title of ['Waiting for approval', 'Approved, to issue', 'By department'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
