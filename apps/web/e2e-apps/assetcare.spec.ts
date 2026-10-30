/**
 * Asset Care end to end (RFC 0021): Dina adds a press; Rahim, a technician, reports it broken down — the press is
 * Down — then starts and finishes the order, and the press is Operational again.
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

test('a breakdown reported, the equipment down, repaired, operational again', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina'); // Asset Care manager
  await page.goto('/assetcare/a/assetcare.action_equipment/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Press');
  await page.getByRole('textbox', { name: 'Asset tag' }).fill('PR-E2E');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/assetcare\.action_equipment\/\d+$/);
  const press = page.url().replace(/^https?:\/\/[^/]+/, '');

  const context = await browser.newContext();
  const rahim = await context.newPage();
  await signIn(rahim, 'rahim'); // technician
  await rahim.goto('/assetcare/a/assetcare.action_requests/new');
  await rahim.getByRole('combobox', { name: 'Equipment' }).click();
  await rahim.getByRole('option', { name: 'E2E Press' }).click();
  await rahim
    .getByRole('textbox', { name: 'What is wrong / what to do' })
    .fill('Oil leak at the ram');
  await rahim.getByRole('button', { name: 'Save' }).click();
  await expect(rahim).toHaveURL(/assetcare\.action_requests\/\d+$/);
  const order = rahim.url().replace(/^https?:\/\/[^/]+/, '');

  await page.goto(press);
  await expect(page.getByText('Down', { exact: true }).first()).toBeVisible();

  await rahim.goto(order);
  await rahim.getByRole('button', { name: 'Start' }).click();
  await expect(rahim.getByRole('button', { name: /^State: In progress/ })).toBeVisible();
  await rahim.getByRole('button', { name: 'Finish' }).click();
  await expect(rahim.getByRole('button', { name: /^State: Done/ })).toBeVisible();
  await context.close();

  await page.goto(press);
  await expect(page.getByText('Operational', { exact: true }).first()).toBeVisible();
});
