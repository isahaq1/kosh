/**
 * "Portal access" on a contact (RFC 0015 §5.2) in the back-office: a contact without an email cannot be invited; with
 * one, the invitation's link is shown (email is not set up on this server), and the access can be revoked.
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

test('a contact is invited to the portal from its form, then its access revoked', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/contacts/a/contacts.action_partners');
  await page.getByRole('cell', { name: 'Acme Trading', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Portal access' });
  await expect(panel.getByText('This contact has no portal access.')).toBeVisible();
  await panel.getByRole('button', { name: 'Grant portal access' }).click();
  await expect(panel.getByRole('alert')).toContainText('email address');

  await page.getByRole('textbox', { name: 'Email' }).fill('orders@acme.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Grant portal access' }).click();
  await expect(panel.getByText(/share this link/)).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Copy the link' })).toHaveValue(
    /\/activate\?token=[\w-]{43}$/,
  );
  await expect(panel.getByText(/Invited: orders@acme\.test/)).toBeVisible();

  await panel.getByRole('button', { name: 'Revoke access' }).click();
  await expect(panel.getByText('Access revoked: orders@acme.test')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Grant portal access' })).toBeVisible();
});
