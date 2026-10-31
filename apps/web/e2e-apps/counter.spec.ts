/**
 * Counter end to end (RFC 0021): a manager makes a shop with a cash method; at the register a session opens with
 * the drawer's cash, a product is found and sold, the cash prefilled and the sale confirmed; the session closes
 * with the count.
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

test('a shop, a session, a sale paid in cash, the session closed', async ({ page }) => {
  await signIn(page, 'dina'); // Counter manager
  await page.goto('/counter/a/counter.action_shops/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Shop');
  const methods = page.getByRole('table', { name: 'methods' });
  await methods.locator('..').getByRole('button', { name: 'Add a line' }).click();
  await methods.locator('tbody tr').last().getByRole('textbox').first().fill('Cash');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/counter\.action_shops\/\d+$/);

  await page.goto('/counter/a/counter.action_register');
  const shopButton = page.getByRole('button', { name: 'E2E Shop' });
  if (await shopButton.isVisible().catch(() => false)) await shopButton.click();
  await page.getByLabel('Cash in the drawer').fill('1000');
  await page.getByRole('button', { name: 'Open the session' }).click();
  const search = page.getByRole('textbox', { name: 'Search or scan' });
  await expect(search).toBeVisible();
  await search.fill('Steel beam');
  await page
    .getByRole('button', { name: /Steel beam/ })
    .first()
    .click();
  await expect(page.getByRole('complementary', { name: 'Sale' })).toContainText('Steel beam');
  await page.getByRole('button', { name: 'Pay', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Cash').focus();
  await dialog.getByRole('button', { name: 'Confirm the sale' }).click();
  await expect(page.getByRole('status')).toContainText(/R\//);

  await page.getByRole('button', { name: 'Close the session' }).click();
  const closing = page.getByRole('dialog');
  const expected = await closing.getByText(/Cash expected in the drawer/).textContent();
  const amount = /:\s*([\d,.]+)/.exec(expected ?? '')?.[1]?.replaceAll(',', '') ?? '1000';
  await closing.getByLabel('Cash counted').fill(amount);
  await closing.getByRole('button', { name: 'Close the session' }).click();
  await expect(page.getByText(/closed: .* sold, difference/)).toBeVisible();
});
