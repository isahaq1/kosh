/**
 * Products, deeper (RFC 0022 step 2): the Overview, and a product's tiles — sold and bought from Sales and Purchase,
 * on hand from Stockroom — on its form.
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

test('the Products overview; a product with what sold, was bought and is on hand', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/product/a/product.action_overview');
  await expect(page.getByRole('heading', { name: 'Products · Overview' })).toBeVisible();
  for (const title of ['Products', 'Goods', 'By category'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
  await page.goto('/product/a/product.action_products?view=list');
  await page
    .getByRole('row', { name: /Steel beam/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Steel beam');
  const related = page.getByRole('region', { name: 'related' });
  for (const label of ['Sold', 'Bought', 'On hand'])
    await expect(related.getByText(label, { exact: true })).toBeVisible();
});
