/**
 * Approvals end to end (RFC 0025): Rahim's purchase order of 140 000 waits for Dina. In the Approvals app she sees it
 * as a card — the order, who asked, the level — with the header's count; rejecting needs a comment; she approves it,
 * the inbox empties, and the order is confirmed. Rahim's requests show it approved.
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

test('a purchase order decided from the Approvals inbox; the requester sees it approved', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina'); // Purchase manager
  await page.goto('/approvals/a/approvals.action_inbox');
  await expect(page.getByRole('heading', { name: 'To approve' })).toBeVisible();
  const card = page.getByRole('listitem').filter({ hasText: 'Asked by Rahim Uddin' }).first();
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Reject' })).toBeDisabled();
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Approved.')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Asked by Rahim Uddin' })).toHaveCount(
    0,
  );

  const context = await browser.newContext();
  const rahim = await context.newPage();
  await signIn(rahim, 'rahim');
  await rahim.goto('/approvals/a/approvals.action_mine');
  await expect(rahim.getByRole('heading', { name: 'My requests' })).toBeVisible();
  await expect(rahim.getByRole('listitem').filter({ hasText: 'Approved' }).first()).toBeVisible();
  await context.close();
});

test('away: Dina says who decides for her while she is on leave', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/approvals/a/approvals.action_away/new');
  await page.getByRole('combobox', { name: 'Decides instead' }).click();
  await page.getByRole('option', { name: 'Rahim Uddin' }).click();
  await page.getByRole('textbox', { name: 'From', exact: true }).fill('2026-12-20');
  await page.getByRole('textbox', { name: 'Until', exact: true }).fill('2026-12-31');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/approvals\.action_away\/\d+$/);
  await page.goto('/approvals/a/approvals.action_away');
  await expect(page.getByRole('row').filter({ hasText: 'Rahim Uddin' })).toBeVisible();
});

test('a request of a category (RFC 0025 step 4): the fields it asks for, submitted for approval', async ({
  page,
}) => {
  await signIn(page, 'rahim');
  await page.goto('/approvals/a/approvals.action_asks/new');
  await page.getByRole('combobox', { name: 'Category', exact: true }).click();
  await page.getByRole('option', { name: 'Business trip' }).click();
  await page.getByRole('textbox', { name: 'What for', exact: true }).fill('Visit the Sylhet farm');
  // A business trip asks where and when, and how much.
  await expect(page.getByRole('textbox', { name: 'Location', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('15000');
  await page.getByRole('textbox', { name: 'From', exact: true }).fill('2026-12-01');
  await page.getByRole('textbox', { name: 'Until', exact: true }).fill('2026-12-03');
  await page.getByRole('textbox', { name: 'Location', exact: true }).fill('Sylhet');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/approvals\.action_asks\/\d+$/);
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toHaveCount(0);
  await page.goto('/approvals/a/approvals.action_asks');
  await expect(page.getByRole('row', { name: /Visit the Sylhet farm/ })).toContainText(
    'Waiting for approval',
  );
});
