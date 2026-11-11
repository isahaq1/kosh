/**
 * The peek panel (RFC 0033 §3.2): a list row opens the record beside the list — the list stays —, the next record
 * with Alt+↓, the full page with the button, closed with Escape; the URL carries the peeked record.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

const CONTACTS = '/contacts/a/contacts.action_partners';

test('a row peeks beside the list; next, close and the full page', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto(CONTACTS);
  await page.evaluate(() => localStorage.removeItem('kosh.peek')); // the default: peeking is on
  await page.reload();
  await page.getByRole('row', { name: /Bengal Steel/ }).click();
  const panel = page.getByRole('complementary', { name: 'Record preview' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { level: 1 })).toContainText('Bengal Steel');
  // The list is still there, and the URL says which record is peeked (a reload lands in the same place).
  await expect(page).toHaveURL(/contacts\.action_partners\?.*peek=\d+/);
  await expect(page.getByRole('row', { name: /Sumaiya Khan/ })).toBeVisible();
  await page.reload();
  await expect(panel.getByRole('heading', { level: 1 })).toContainText('Bengal Steel');
  // The next record of the list, without closing the panel.
  await expect(panel.getByText(/^\d+ \/ \d+$/)).toBeVisible(); // the list loaded: the panel knows its place
  const first = page.url();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page).not.toHaveURL(first);
  await expect(panel).toBeVisible();
  // Escape closes it; the list never left.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page).not.toHaveURL(/peek=/);
  // The full page from the panel.
  await page.getByRole('row', { name: /Bengal Steel/ }).click();
  await panel.getByRole('button', { name: 'Open the full page' }).click();
  await expect(page).toHaveURL(/contacts\.action_partners\/\d+$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Bengal Steel');
});
