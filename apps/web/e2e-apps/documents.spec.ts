/**
 * Documents end to end (RFC 0024 §2.8): Dina makes a document in a folder, uploads its file from the form, then a
 * second version; both are listed, the latest first.
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

test('a document made on screen, its file uploaded, then a second version', async ({ page }) => {
  await signIn(page, 'dina'); // Documents manager
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  expect(
    (
      await page.request.post('/api/v1/models/documents.folder', {
        headers: { 'x-csrf-token': csrf ?? '' },
        data: { name: 'E2E contracts' },
      })
    ).ok(),
  ).toBe(true);
  await page.goto('/documents/a/documents.action_documents/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Lease agreement');
  await page.getByRole('combobox', { name: 'Folder' }).click();
  await page.getByRole('option', { name: 'E2E contracts' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/documents\.action_documents\/\d+$/);

  const file = page.getByLabel('Upload a new version');
  await file.setInputFiles({
    name: 'lease.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('v1'),
  });
  await expect(page.getByText('Version 1')).toBeVisible();
  await file.setInputFiles({
    name: 'lease-v2.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('v2'),
  });
  await expect(page.getByText('Version 2')).toBeVisible();
  await expect(page.getByText('lease-v2.txt')).toBeVisible();
});
