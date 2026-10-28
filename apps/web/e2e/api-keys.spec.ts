/**
 * API keys end to end (RFC 0017 §5.1): a user opens API keys from the user menu, creates a key that reads contacts, copies its
 * secret (shown once), and calls the API with it: reading works, changing is outside its scope; then revokes it.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

test('a read-only key for contacts: created, used, refused outside its scope, revoked', async ({
  page,
}) => {
  await signIn(page, 'maria');
  await page.getByRole('button', { name: 'Maria Das' }).click();
  await page.getByRole('menuitem', { name: 'API keys' }).click();
  await expect(page).toHaveURL(/\/me\/settings\.ApiKeys$/);
  await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
  await page.getByLabel('Name').fill('Reporting script');
  await page.getByRole('combobox', { name: 'contacts' }).click();
  await page.getByRole('option', { name: 'Read', exact: true }).click();
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByText('it is shown only once')).toBeVisible();
  const secret = (await page.locator('code').first().textContent()) ?? '';
  expect(secret).toMatch(/^sk_/);
  await page.getByRole('button', { name: 'Done' }).click();
  const row = page.getByRole('row', { name: /Reporting script/ });
  await expect(row).toContainText('read:contacts');
  await expect(row).toContainText('Active');

  // The API with the key, without the session's cookie.
  const api = await page.context().request;
  const read = await api.get('/api/v1/models/res.partner', {
    headers: { 'X-Api-Key': secret, cookie: '' },
  });
  expect(read.status()).toBe(200);
  const write = await api.post('/api/v1/models/res.partner', {
    headers: { 'X-Api-Key': secret, cookie: '' },
    data: { name: 'Made by a script' },
  });
  expect(write.status()).toBe(403);

  await row.getByRole('button', { name: 'Revoke Reporting script' }).click();
  await expect(row).toContainText('Revoked');
  const after = await api.get('/api/v1/models/res.partner', {
    headers: { 'X-Api-Key': secret, cookie: '' },
  });
  expect(after.status()).toBe(401);
});
