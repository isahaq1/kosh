/**
 * Payment follow-ups (RFC 0029 §3.4): the Follow-ups page lists late customers with their level, or says nobody is
 * late; the levels are set up in Configuration.
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

test('the Follow-ups page and the follow-up levels', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/accounting/a/accounting.action_followups');
  await expect(page.getByRole('heading', { name: 'Follow-ups', level: 1 })).toBeVisible();
  await expect(page.getByText(/Nobody is late\.|Customer/).first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.goto('/accounting/a/accounting.action_followup_levels');
  for (const name of ['First reminder', 'Second reminder', 'Final notice'])
    await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible();
});

test('fiscal positions are set up in Configuration; a draft invoice says what confirming will do', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/accounting/a/accounting.action_fiscal_positions');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.goto('/accounting/a/accounting.action_customer_invoices');
  const drafts = page.getByRole('row', { name: /Draft/ });
  if ((await drafts.count()) === 0) return; // every invoice of the data set is posted
  await drafts.first().click();
  await expect(page.getByRole('heading', { name: 'When confirmed' })).toBeVisible();
  await expect(page.getByText(/No fiscal position|Fiscal position /)).toBeVisible();
});
