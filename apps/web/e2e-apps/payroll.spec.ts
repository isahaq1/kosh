/**
 * Payroll end to end (RFC 0024 §2.3): Dina makes a run for a month, computes it — Nadia's payslip with its lines and
 * their explanations — and approves it; Nadia then reads her own payslip.
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

test('a run computed with explained payslips, approved, and read by the employee', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina'); // Payroll manager
  await page.goto('/payroll/a/payroll.action_runs/new');
  await page.getByRole('textbox', { name: 'Title' }).fill('E2E month');
  for (const [label, value] of [
    ['From', '2026-09-01'],
    ['To', '2026-09-30'],
  ] as const) {
    const box = page.getByRole('textbox', { name: label, exact: true });
    await box.fill(value);
    await box.blur();
  }
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/payroll\.action_runs\/\d+$/);
  await page.getByRole('button', { name: 'Compute payslips' }).click();
  await expect(page.getByRole('button', { name: /^State: Computed/ })).toBeVisible();
  const slips = page.getByRole('table', { name: 'slips' });
  await expect(slips).toContainText('Nadia Islam');
  await expect(slips).toContainText(/45,?000/); // 30 000 basic + 15 000 house rent

  await page.getByRole('button', { name: 'Approve' }).click();
  const confirm = page.getByRole('dialog', { name: 'Approve' });
  await expect(confirm).toContainText('Approve and lock this run?');
  await confirm.getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByRole('button', { name: /^State: Approved/ })).toBeVisible();

  const context = await browser.newContext();
  const nadia = await context.newPage();
  await signIn(nadia, 'nadia');
  await nadia.goto('/payroll/a/payroll.action_slips');
  await nadia
    .getByRole('row', { name: /Nadia Islam/ })
    .first()
    .click();
  await expect(nadia.getByRole('table', { name: 'lines' })).toContainText('50000 × 0.6');
  await expect(nadia.getByRole('table', { name: 'lines' })).toContainText('House rent');
  await context.close();
});

test('the Payroll overview', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/payroll/a/payroll.action_overview');
  await expect(page.getByRole('heading', { name: 'Payroll · Overview' })).toBeVisible();
  for (const title of ['Net pay this month', 'Runs to approve', 'Gross by person'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
