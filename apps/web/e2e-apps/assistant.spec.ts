/**
 * "Fill from a document" with lines (RFC 0013 §5.3), with the apps server's fake client: a pasted order fills a new
 * sales order, its customer found by name and its line in the line editor, all proposals until the user saves.
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

test('a pasted order fills a new sales order and its lines; saving creates them', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/sales/a/sales.action_orders');
  await page.getByRole('button', { name: 'Fill from a document' }).click();
  const dialog = page.getByRole('dialog', { name: 'Fill a new record from a document' });
  await dialog
    .getByLabel('Paste the text')
    .fill(['Please send us:', 'Customer: Bengal Steel', 'Line: Steel beam; 3; 950'].join('\n'));
  await dialog.getByRole('button', { name: 'Read the document' }).click();

  // The customer by name, its currency by the onchange, the defaults of a new order, the line in the line editor:
  // proposals, unsaved.
  await expect(page.getByRole('combobox', { name: /^Customer/ })).toHaveText('Bengal Steel');
  await expect(page.getByRole('combobox', { name: 'Currency' })).toHaveText('BDT');
  await expect(page.getByRole('combobox', { name: 'Salesperson' })).toHaveText('Dina Rahman');
  await expect(page.getByText('Proposed', { exact: true }).first()).toBeVisible();
  const line = page.getByRole('row').filter({ hasText: 'Steel beam' });
  await expect(line).toHaveCount(1);
  await expect(line.getByRole('textbox').nth(0)).toHaveValue('Steel beam'); // the description
  await expect(line.getByRole('textbox').nth(1)).toHaveValue('3');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).not.toHaveURL(/\/new$/);
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  // Saved with its line: 3 × 950.
  await expect(page.getByRole('heading', { name: /^SO\/\d{4}\/\d{5}$/ })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Totals' })).toContainText('Total2,850');
});
