/**
 * Helpdesk end to end (RFC 0024 §2.4): Dina opens a ticket for a customer on the Support team's board, puts it on
 * waiting, then solves it; the overview counts the tickets.
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

test('a ticket opened, waiting on the customer, then solved', async ({ page }) => {
  await signIn(page, 'dina'); // Helpdesk manager
  await page.goto('/helpdesk/a/helpdesk.action_tickets/new');
  await page.getByRole('textbox', { name: 'Subject' }).fill('The printer in Accounts is jammed');
  await page.getByRole('textbox', { name: 'Customer email' }).fill('accounts@example.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/helpdesk\.action_tickets\/\d+$/);
  await expect(page.getByRole('button', { name: /^State: Open/ })).toBeVisible();
  await page.getByRole('button', { name: 'Waiting on the customer' }).click();
  await expect(page.getByRole('button', { name: /^State: Waiting on the customer/ })).toBeVisible();
  await page.getByRole('button', { name: 'Solved' }).click();
  await expect(page.getByRole('button', { name: /^State: Solved/ })).toBeVisible();
});

test('the Helpdesk overview', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/helpdesk/a/helpdesk.action_overview');
  await expect(page.getByRole('heading', { name: 'Helpdesk · Overview' })).toBeVisible();
  for (const title of ['Open tickets', 'SLA breached', 'Tickets by SLA'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
