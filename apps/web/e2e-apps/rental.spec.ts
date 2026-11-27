/**
 * Rental end to end (RFC 0038, step 6): Dina, a Rental manager, puts a product up for rent on its form, writes a
 * rental order for it on screen and reserves it; the overview.
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

/** A day so many days from now at `hour`, as a datetime-local input takes it. */
const at = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
};

test('a product put up for rent; an order written on screen and reserved', async ({ page }) => {
  await signIn(page, 'dina'); // Rental manager
  const name = `E2E Generator ${Date.now()}`;
  await page.goto('/product/a/product.action_products/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByRole('checkbox', { name: 'For rent' }).check();
  await page.getByRole('textbox', { name: 'Rent per unit' }).fill('2500');
  await page.getByRole('textbox', { name: 'Number for rent' }).fill('2');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/product\.action_products\/\d+$/);

  await page.goto('/contacts/a/contacts.action_partners/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Rental Customer');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/contacts\.action_partners\/\d+$/);

  await page.goto('/rental/a/rental.action_orders/new');
  await page.getByRole('combobox', { name: 'Customer' }).click();
  await page.keyboard.type('E2E Rental Customer');
  await page.getByRole('option', { name: 'E2E Rental Customer' }).first().click();
  await page.getByRole('textbox', { name: 'From', exact: true }).fill(at(40, 9));
  await page.getByRole('textbox', { name: 'Until', exact: true }).fill(at(42, 9));
  const lines = page.getByRole('table', { name: 'lines' });
  await lines.locator('..').getByRole('button', { name: 'Add a line' }).click();
  const row = lines.locator('tbody tr').last();
  await row.getByRole('combobox').first().click();
  await page.keyboard.type(name);
  await page.getByRole('option', { name }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/rental\.action_orders\/\d+$/);
  await page.getByRole('button', { name: 'Reserve' }).click();
  await expect(page.getByRole('button', { name: /^State: Reserved/ })).toBeVisible();
});

test('the Rental overview', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/rental/a/rental.action_overview');
  await expect(page.getByRole('heading', { name: 'Rental · Overview' })).toBeVisible();
  for (const title of ['Out now', 'Reserved', 'Orders by state'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
