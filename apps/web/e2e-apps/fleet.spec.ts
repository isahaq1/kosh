/**
 * Fleet end to end (RFC 0038, step 2): Dina, a Fleet manager, adds a vehicle on screen; a trip is planned, started
 * at the vehicle's reading and finished with the reading at the end; the overview.
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

test('a vehicle added on screen; a trip started and finished with its distance', async ({
  page,
}) => {
  await signIn(page, 'dina'); // Fleet manager
  await page.goto('/fleet/a/fleet.action_vehicles/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Hiace');
  await page.getByRole('textbox', { name: 'Plate number' }).fill('E2E-51-2040');
  await page.getByRole('textbox', { name: 'Odometer when it came (km)' }).fill('41000');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/fleet\.action_vehicles\/\d+$/);

  await page.goto('/fleet/a/fleet.action_trips/new');
  await page.getByRole('combobox', { name: 'Vehicle' }).click();
  await page.keyboard.type('E2E Hiace');
  await page.getByRole('option', { name: 'E2E Hiace' }).click();
  await page.getByRole('textbox', { name: 'From', exact: true }).fill('Head office');
  await page.getByRole('textbox', { name: 'To', exact: true }).fill('Gazipur depot');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/fleet\.action_trips\/\d+$/);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('button', { name: /^State: On the road/ })).toBeVisible();
  await page.getByRole('textbox', { name: 'Odometer at the end (km)' }).fill('41080');
  await page.getByRole('button', { name: 'Save' }).click();
  // Saved: the next-step banner offers Finish.
  await expect(page.getByText('Next step: Finish.')).toBeVisible();
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByRole('button', { name: /^State: Done/ })).toBeVisible();
});

test('the Fleet overview', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/fleet/a/fleet.action_overview');
  await expect(page.getByRole('heading', { name: 'Fleet · Overview' })).toBeVisible();
  for (const title of ['Vehicles', 'On the road', 'Papers by status'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
