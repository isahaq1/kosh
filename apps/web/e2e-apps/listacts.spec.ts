/**
 * Lists that act (RFC 0033 §3.4): a record added from the row at the foot of the list, a field set for the
 * selected rows and undone, and the list narrowed to a cell's value.
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

test('quick add at the foot of the list; a field set for the selection, then undone', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/product/a/product.action_groups');
  const quick = page.getByRole('form', { name: 'Add a record' });
  // Two groups, without opening a form: type, Enter, the row is there and the row is ready for the next.
  await quick.getByLabel('Name').fill('Winter line');
  await quick.getByLabel('Code').fill('WL');
  await quick.getByLabel('Code').press('Enter');
  await expect(page.getByRole('row', { name: /Winter line/ })).toBeVisible();
  await expect(quick.getByLabel('Name')).toHaveValue('');
  await quick.getByLabel('Name').fill('Spring line');
  await quick.getByLabel('Name').press('Enter');
  await expect(page.getByRole('row', { name: /Spring line/ })).toBeVisible();
  // A code is unique: the server's refusal shows in the row, nothing is added.
  await quick.getByLabel('Name').fill('Another');
  await quick.getByLabel('Code').fill('WL');
  await quick.getByLabel('Code').press('Enter');
  await expect(quick.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('row', { name: /Another/ })).toHaveCount(0);
  await quick.getByLabel('Name').fill('');
  await quick.getByLabel('Code').fill('');

  // Both selected: the name is set for the two at once, and Undo puts the names back.
  await page
    .getByRole('row', { name: /Winter line/ })
    .getByRole('checkbox')
    .check();
  await page
    .getByRole('row', { name: /Spring line/ })
    .getByRole('checkbox')
    .check();
  await page.getByRole('button', { name: 'Set a field…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Field').selectOption({ label: 'Name' });
  await dialog.getByLabel('New value').fill('Seasonal');
  await dialog.getByRole('button', { name: 'Apply to 2 records' }).click();
  await expect(page.getByRole('row', { name: /Seasonal/ })).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('row', { name: /Winter line/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Spring line/ })).toBeVisible();
});

test('a cell narrows the list to its value', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/product/a/product.action_products?view=list');
  const row = page.getByRole('row', { name: /Steel beam/ });
  await expect(row).toBeVisible();
  const before = await page.getByRole('row').count();
  await row.hover();
  await row.getByRole('button', { name: 'Only this Kind' }).click();
  // The search carries the filter (the URL's q), and the list is still a list of products.
  await expect(page).toHaveURL(/[?&]q=/);
  await expect(page.getByRole('row', { name: /Steel beam/ })).toBeVisible();
  expect(await page.getByRole('row').count()).toBeLessThanOrEqual(before);
});
