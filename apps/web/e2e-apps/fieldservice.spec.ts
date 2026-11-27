/**
 * Field service end to end (RFC 0038, step 8): Dina, a dispatcher, plans a visit for herself on screen and starts
 * it; the visits on the map; the overview.
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

/** Tomorrow at `hour`, as a datetime-local input takes it. */
const tomorrow = (hour: number) => {
  const d = new Date(Date.now() + 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
};

test('a visit planned on screen and started', async ({ page }) => {
  await signIn(page, 'dina'); // Field service dispatcher
  await page.goto('/contacts/a/contacts.action_partners/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Field Customer');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/contacts\.action_partners\/\d+$/);

  await page.goto('/field_service/a/field_service.action_visits/new');
  await page.getByRole('combobox', { name: 'Customer' }).click();
  await page.keyboard.type('E2E Field Customer');
  await page.getByRole('option', { name: 'E2E Field Customer' }).first().click();
  await page.getByRole('combobox', { name: 'Technician' }).click();
  await page.keyboard.type('Dina');
  await page.getByRole('option', { name: /Dina/ }).first().click();
  await page.getByRole('textbox', { name: 'Planned for' }).fill(tomorrow(10));
  await page.getByRole('textbox', { name: 'What is wrong' }).fill('The generator does not start.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/field_service\.action_visits\/\d+$/);
  await page.getByRole('button', { name: 'Start the visit' }).click();
  await expect(page.getByRole('button', { name: /^State: On site/ })).toBeVisible();
});

test('the Field service overview', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/field_service/a/field_service.action_overview');
  await expect(page.getByRole('heading', { name: 'Field service · Overview' })).toBeVisible();
  for (const title of ['Planned', 'On site now', 'Visits by state'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
