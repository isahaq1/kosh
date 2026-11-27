/**
 * Repairs end to end (RFC 0038, step 4): Dina, a Repairs manager, takes an item in on screen, writes the
 * diagnosis and, the item being under warranty, starts the repair, marks it repaired and hands it back; the
 * overview.
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

test('an item taken in under warranty, diagnosed, repaired and handed back', async ({ page }) => {
  await signIn(page, 'dina'); // Repairs manager
  await page.goto('/contacts/a/contacts.action_partners/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Repair Customer');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/contacts\.action_partners\/\d+$/);

  await page.goto('/repairs/a/repair.action_orders/new');
  await page.getByRole('combobox', { name: 'Customer' }).click();
  await page.getByRole('option', { name: 'E2E Repair Customer' }).click();
  await page.getByRole('textbox', { name: 'Item', exact: true }).fill('E2E Walton fridge');
  await page.getByRole('textbox', { name: 'Serial number' }).fill(`E2E-${Date.now()}`);
  await page.getByRole('textbox', { name: 'What the customer says' }).fill('Does not cool.');
  await page.getByRole('textbox', { name: 'Diagnosis' }).fill('The start relay has failed.');
  await page.getByRole('checkbox', { name: 'Under warranty' }).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/repair\.action_orders\/\d+$/);

  await page.getByRole('button', { name: 'Diagnosed', exact: true }).click();
  await expect(page.getByRole('button', { name: /^State: Diagnosed/ })).toBeVisible();
  await page.getByRole('button', { name: 'Start the repair' }).click();
  await expect(page.getByRole('button', { name: /^State: In repair/ })).toBeVisible();
  await page.getByRole('button', { name: 'Repaired', exact: true }).click();
  await expect(page.getByRole('button', { name: /^State: Repaired/ })).toBeVisible();
  await page.getByRole('button', { name: 'Hand back' }).click();
  await expect(page.getByRole('button', { name: /^State: Handed back/ })).toBeVisible();
});

test('the Repairs overview', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/repairs/a/repair.action_overview');
  await expect(page.getByRole('heading', { name: 'Repairs · Overview' })).toBeVisible();
  for (const title of ['In the workshop', 'To hand back', 'Orders by state'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
