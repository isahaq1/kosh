/**
 * Replenishment end to end (RFC 0024 §2.6): Dina refreshes the forecast — no anchor bolts, below the minimum of 100
 * — and the screen says why it proposes 200; she orders 250 instead, and a request for quotation to Bengal Steel is
 * made; once refreshed, the bolts are on order and nothing is left to propose.
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

test('the forecast explained, a quantity changed, a request for quotation made', async ({
  page,
}) => {
  await signIn(page, 'dina'); // Stockroom manager
  await page.goto('/stockroom/a/stockroom.action_replenishment');
  await expect(page.getByRole('heading', { name: 'Replenishment' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh the forecast' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'rules refreshed' })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'Anchor bolt' });
  await expect(row).toContainText(
    'On hand 0 = forecast 0; below the minimum 100: 200 to reach the maximum 200.',
  );
  const quantity = row.getByRole('textbox', { name: /Quantity to order for Anchor bolt/ });
  await expect(quantity).toHaveValue('200');
  await quantity.fill('250');
  await row.getByRole('checkbox').click();
  await page.getByRole('button', { name: 'Order (1)' }).click();
  await expect(page.getByRole('status').filter({ hasText: /250 on P/ })).toBeVisible();
  // Nothing left to propose: the bolts are on order.
  await expect(page.getByRole('row').filter({ hasText: 'Anchor bolt' })).toHaveCount(0);
  await page.getByLabel('Show every rule').click();
  await expect(page.getByRole('row').filter({ hasText: 'Anchor bolt' })).toContainText(
    /on order 250 \(P/,
  );
});
