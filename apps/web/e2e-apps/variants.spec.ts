/**
 * Variants (RFC 0030 step 4): the template form with its attributes and the Generate button; the attributes list.
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

test('a product template form; the attributes list', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/product/a/product.action_templates/new');
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Sales price' })).toBeVisible();
  await page.goto('/product/a/product.action_attributes');
  await expect(page.getByRole('heading', { name: /Attributes/ }).first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the variant grid on a quotation: pick the template, type two quantities, two lines are added', async ({
  page,
}) => {
  await signIn(page, 'rahim');
  await page.goto('/sales/a/sales.action_quotations');
  await page
    .getByRole('row', { name: /Bengal Steel/ })
    .first()
    .click();
  await expect(page).toHaveURL(/sales\.action_quotations\/\d+$/);
  await page.getByRole('button', { name: 'Add variants from a template…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'T-shirt' }).click();
  await page.getByRole('dialog').getByLabel('T-shirt (S, Red)').fill('2');
  await page.getByRole('dialog').getByLabel('T-shirt (L, Blue)').fill('1');
  await page.getByRole('dialog').getByRole('button', { name: 'Add 2 lines' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('T-shirt (S, Red)')).toBeVisible();
  await expect(page.getByText('T-shirt (L, Blue)')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
