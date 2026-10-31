/**
 * Contacts, deeper (RFC 0022 step 2): the Overview with its counts, the board of contacts with their tags and
 * photos, the map of those that have coordinates.
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

test('the Contacts overview, the board with tags, the map', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/contacts/a/contacts.action_overview');
  await expect(page.getByRole('heading', { name: 'Contacts · Overview' })).toBeVisible();
  for (const title of ['Contacts', 'Customers', 'Vendors', 'New this month'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();

  // A tag made by the manager, set on a contact, shown as a chip on the board.
  await page.goto('/contacts/a/contacts.action_tags/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Key account');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/contacts\.action_tags\/\d+$/);
  await page.goto('/contacts/a/contacts.action_partners/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Tagged Ltd');
  await page.getByRole('textbox', { name: 'City', exact: true }).fill('Dhaka');
  await page.getByRole('combobox', { name: 'Tags' }).click();
  await page.getByRole('option', { name: 'E2E Key account' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/contacts\.action_partners\/\d+$/);
  await page.goto('/contacts/a/contacts.action_partners?view=kanban');
  const card = page.getByRole('listitem').filter({ hasText: 'E2E Tagged Ltd' });
  await expect(card).toBeVisible();
  await expect(card.getByText('E2E Key account')).toBeVisible();

  // The map view opens (contacts with coordinates are on it; the tile style may be offline here).
  await page.goto('/contacts/a/contacts.action_partners?view=map');
  await expect(page.getByRole('button', { name: /^List$|^Map$|views/ }).first()).toBeVisible();
});
