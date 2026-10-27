/**
 * The AI assistant end to end (RFC 0013 step 1), with the e2e server's fake client: off until an administrator
 * switches it on in Settings → AI assistant; then "Ask" turns a sentence into a filter chip on the contacts list,
 * removable like any other; a user without the assistant sees no "Ask".
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

const CONTACTS = '/contacts/a/contacts.action_partners';

test('an administrator switches it on; "Ask" filters the contacts; the chip removes the filter', async ({
  page,
  browser,
}) => {
  await signIn(page, 'admin');
  await page.goto('/settings/a/assistant.action_settings');
  await expect(page.getByText('The assistant is off for this company.')).toBeVisible();
  await page.getByRole('button', { name: 'Switch on' }).click();
  await expect(page.getByText('The assistant is on for this company.')).toBeVisible();
  await expect(page.getByText('Model: fake-claude')).toBeVisible();

  const other = await browser.newContext();
  const dina = await other.newPage();
  await signIn(dina, 'dina');
  await dina.goto(CONTACTS);
  await expect(dina.getByRole('row', { name: /Sumaiya Khan/ })).toBeVisible();
  await dina.getByRole('button', { name: 'Ask' }).click();
  await dina.getByLabel('What are you looking for?').fill('contacts in Dhaka');
  await dina.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(dina.getByText('contacts in Dhaka', { exact: true })).toBeVisible();
  await expect(dina.getByRole('row', { name: /Acme Trading/ })).toBeVisible();
  await expect(dina.getByRole('row', { name: /Sumaiya Khan/ })).toHaveCount(0); // Sylhet
  await dina.keyboard.press('Escape');
  await dina.getByRole('button', { name: 'Remove contacts in Dhaka' }).click();
  await expect(dina.getByRole('row', { name: /Sumaiya Khan/ })).toBeVisible();

  // The call is in the administrator's log.
  await page.reload();
  await expect(page.getByRole('cell', { name: 'res.partner' })).toBeVisible();
  await other.close();
});

test('the chatter: a summary streams in; a draft reply goes to the composer to edit', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/purchase/a/purchase.action_orders');
  await page.getByRole('row', { name: /PO-R-002/ }).click();
  const chatter = page.getByRole('region', { name: 'Chatter' });
  await chatter.getByRole('button', { name: 'Summarize' }).click();
  const summary = chatter.getByRole('region', { name: 'Summary' });
  await expect(summary.getByText('The order waits for its approval.')).toBeVisible();
  await expect(summary.getByText(/Written by an AI model \(fake-claude\)/)).toBeVisible();
  await summary.getByRole('button', { name: 'Close' }).click();

  await chatter.getByRole('button', { name: 'Draft reply' }).click();
  const draft = chatter.getByRole('region', { name: 'Draft reply' });
  await expect(draft.getByText('Thank you, the order is confirmed for [date].')).toBeVisible();
  await draft.getByRole('button', { name: 'Use this draft' }).click();
  await expect(chatter.getByRole('combobox', { name: 'Send message' })).toHaveValue(
    'Thank you, the order is confirmed for [date].',
  );
});

test('without the assistant access: no "Ask"', async ({ page }) => {
  await signIn(page, 'rahim');
  await page.goto(CONTACTS);
  await expect(page.getByRole('row', { name: /Acme Trading/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask' })).toHaveCount(0);
});
