/**
 * Campaigns end to end (RFC 0038, step 3): Dina, a Campaigns manager, makes a mailing list with a subscriber,
 * writes a campaign to it on screen and sends it; the overview.
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

test('a list with a subscriber; a campaign written on screen and sent to it', async ({ page }) => {
  await signIn(page, 'dina'); // Campaigns manager
  await page.goto('/campaigns/a/marketing.action_lists/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Customers');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/marketing\.action_lists\/\d+$/);

  await page.goto('/campaigns/a/marketing.action_subscribers/new');
  await page.getByRole('combobox', { name: 'List' }).click();
  await page.keyboard.type('E2E Customers');
  await page.getByRole('option', { name: 'E2E Customers' }).click();
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('e2e.reader@example.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/marketing\.action_subscribers\/\d+$/);

  await page.goto('/campaigns/a/marketing.action_campaigns/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Winter offer');
  await page.getByRole('combobox', { name: 'To the lists' }).click();
  await page.getByRole('option', { name: 'E2E Customers' }).click();
  await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Winter prices are here');
  await page.getByRole('textbox', { name: 'Message', exact: true }).click();
  await page.keyboard.type('Everything in stock is 15% off until Friday.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/marketing\.action_campaigns\/\d+$/);
  await page.getByRole('button', { name: 'Send now' }).click();
  // Sending, then sent once the server has written to the one subscriber.
  await expect(page.getByRole('button', { name: /^State: (Sending|Sent)/ })).toBeVisible();
});

test('the Campaigns overview', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/campaigns/a/marketing.action_overview');
  await expect(page.getByRole('heading', { name: 'Campaigns · Overview' })).toBeVisible();
  for (const title of ['Subscribers', 'Messages sent', 'Subscribers by list'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
