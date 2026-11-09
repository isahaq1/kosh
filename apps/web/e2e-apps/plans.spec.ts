/**
 * Production plans (RFC 0031 step 3): a plan drafted; the plan schedule's Gantt opens.
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

test('a production plan drafted; the plan schedule', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/production/a/production.action_plans/new');
  await page.getByRole('textbox', { name: 'Plan', exact: true }).fill('Week 48');
  await page.getByRole('textbox', { name: 'From' }).fill('2026-11-23');
  await page.getByRole('textbox', { name: 'To' }).fill('2026-11-27');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/production\.action_plans\/\d+$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('PLAN/');
  await page.goto('/production/a/production.action_plan_lines');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
