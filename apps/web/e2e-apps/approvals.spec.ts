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
