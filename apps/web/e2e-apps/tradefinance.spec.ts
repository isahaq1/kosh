/**
 * Trade Finance end to end (RFC 0021): Dina drafts an import LC, applies, records it issued by the bank, presents
 * documents for part of it and accepts them — their maturity is set.
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

async function pick(page: Page, field: string, option: RegExp): Promise<void> {
  await page.getByRole('combobox', { name: field }).click();
  await page.getByRole('option', { name: option }).click();
}

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

test('an import LC applied, issued, documents presented and accepted', async ({ page }) => {
  await signIn(page, 'dina'); // Trade Finance manager
  await page.goto('/tradefinance/a/tradefinance.action_lcs/new');
  await pick(page, 'Issuing bank', /Acme Trading/);
  await pick(page, 'Counterparty', /Bengal Steel/);
  await pick(page, 'Currency', /BDT/);
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('100000');
  for (const [field, offset] of [
    ['Latest shipment', 20],
    ['Expires on', 35],
  ] as const) {
    const box = page.getByRole('textbox', { name: field, exact: true });
    await box.fill(day(offset));
    await box.blur();
  }
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/tradefinance\.action_lcs\/\d+$/);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: /^State: Applied/ })).toBeVisible();
  await page.getByRole('button', { name: 'Issued by the bank' }).click();
  await expect(page.getByRole('button', { name: /^State: Issued/ })).toBeVisible();

  await page.goto('/tradefinance/a/tradefinance.action_presentations/new');
  await pick(page, 'LC', /LC\//);
  await page.getByRole('textbox', { name: 'Drawn', exact: true }).fill('40000');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/tradefinance\.action_presentations\/\d+$/);
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByRole('button', { name: /^State: Accepted/ })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Due on' })).not.toHaveValue('');
});
