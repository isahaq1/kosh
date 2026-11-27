/**
 * Appraisals end to end (RFC 0038, step 5): Dina, HR, writes a kind of skill on screen, then a review cycle and
 * opens it; the overview.
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

test('a kind of skill written on screen; a review cycle opened', async ({ page }) => {
  await signIn(page, 'dina'); // HR
  await page.goto('/appraisals/a/hr_appraisal.action_skill_types/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`E2E Machines ${Date.now()}`);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/hr_appraisal\.action_skill_types\/\d+$/);

  await page.goto('/appraisals/a/hr_appraisal.action_cycles/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Mid-year review');
  await page.getByRole('textbox', { name: 'Period from' }).fill('2026-01-01');
  await page.getByRole('textbox', { name: 'Period to' }).fill('2026-06-30');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/hr_appraisal\.action_cycles\/\d+$/);
  await page.getByRole('button', { name: 'Open the cycle' }).click();
  await expect(page.getByRole('button', { name: /^State: Open/ })).toBeVisible();
});

test('the Appraisals overview', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/appraisals/a/hr_appraisal.action_overview');
  await expect(page.getByRole('heading', { name: 'Appraisals · Overview' })).toBeVisible();
  for (const title of ['Completed', 'Skills on record', 'Appraisals by state'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
