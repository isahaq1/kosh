/**
 * Spend end to end (RFC 0024 §2.1): Nadia claims two days' allowance — the amount filled from the category's rate —
 * in a report she submits; she cannot approve it herself; Dina, a Spend manager, approves it in the report's
 * approvals panel and the report is approved.
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

async function pick(page: Page, field: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: field }).click();
  await page.getByRole('option', { name: option }).click();
}

test('an allowance claimed at the rate, a report submitted, approved by a Spend manager', async ({
  page,
  browser,
}) => {
  const context = await browser.newContext();
  const nadia = await context.newPage();
  await signIn(nadia, 'nadia');
  await nadia.goto('/spend/a/spend.action_sheets/new');
  await nadia.getByRole('textbox', { name: 'Purpose' }).fill('Visit to the Sylhet depot');
  await nadia.getByRole('textbox', { name: 'Purpose' }).blur();
  await expect(nadia.getByRole('combobox', { name: 'Employee' })).toContainText('Nadia Islam');
  await nadia.getByRole('button', { name: 'Save' }).click();
  await expect(nadia).toHaveURL(/spend\.action_sheets\/\d+$/);
  const report = nadia.url().replace(/^https?:\/\/[^/]+/, '');
  const reference = (await nadia.getByRole('heading', { level: 1 }).textContent())?.trim() ?? '';

  await nadia.goto('/spend/a/spend.action_expenses/new');
  await nadia.getByRole('textbox', { name: 'Description' }).fill('Daily allowance, Sylhet');
  await pick(nadia, 'Category', 'Daily allowance');
  const quantity = nadia.getByRole('textbox', { name: 'Quantity' });
  await quantity.fill('2');
  await quantity.blur();
  await expect(nadia.getByRole('textbox', { name: /^Amount/ })).toHaveValue(/1,?600/);
  await nadia.getByRole('textbox', { name: 'Spent on' }).fill('2026-10-20');
  await pick(nadia, 'Report', reference);
  await nadia.getByRole('button', { name: 'Save' }).click();
  await expect(nadia).toHaveURL(/spend\.action_expenses\/\d+$/);

  await nadia.goto(report);
  await nadia.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(nadia.getByRole('button', { name: /^State: Waiting for approval/ })).toBeVisible();
  const panel = nadia.getByRole('region', { name: 'Approvals' });
  await expect(panel.getByRole('button', { name: /Approve/ })).toHaveCount(0); // never one's own
  await context.close();

  await signIn(page, 'dina');
  await page.goto(report);
  await page
    .getByRole('region', { name: 'Approvals' })
    .getByRole('button', { name: 'Approve', exact: true })
    .click();
  await expect(page.getByRole('button', { name: /^State: Approved/ })).toBeVisible();
});

test('the Spend overview', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/spend/a/expense.action_overview');
  await expect(page.getByRole('heading', { name: 'Spend · Overview' })).toBeVisible();
  for (const title of ['Reports waiting for approval', 'Spent this month', 'By category'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
