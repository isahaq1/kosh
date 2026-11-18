/**
 * Password reset on screen (RFC 0034 §2.4): the sign-in page leads to asking for a link, which answers the same
 * whoever asks; the page a link opens refuses one that does not work, and says an incomplete link is incomplete.
 * (The emailed link setting the password, once, is proved on the server: `packages/settings/test/password-reset…`.)
 */
import { expect, test } from '@playwright/test';

test('from sign-in to asking for a reset link: the answer does not say whether the account exists', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password', level: 1 })).toBeVisible();
  await page.getByLabel('Login').fill('nobody-at-all@example.com');
  await page.getByRole('button', { name: 'Email me the link' }).click();
  await expect(
    page.getByText('If that login has an account, an email with a link is on its way.'),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Back to sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('a link that does not work is refused; an incomplete one says so', async ({ page }) => {
  await page.goto('/reset');
  await expect(page.getByRole('alert')).toContainText('This link is incomplete');

  await page.goto('/reset?token=not-a-real-token-not-a-real-token-not-a-real-token');
  await expect(
    page.getByRole('heading', { name: 'Choose a new password', level: 1 }),
  ).toBeVisible();
  const save = page.getByRole('button', { name: 'Save the new password' });
  await expect(save).toBeDisabled();
  await page.getByLabel('Password', { exact: true }).fill('a long enough password');
  await page.getByLabel('Repeat the password').fill('a different long password');
  await expect(page.getByText('The passwords are not the same.')).toBeVisible();
  await page.getByLabel('Repeat the password').fill('a long enough password');
  await save.click();
  await expect(page.getByRole('alert')).toContainText(
    'The link was used, replaced or has expired.',
  );
  await expect(
    page.getByRole('alert').getByRole('link', { name: 'Forgot your password?' }),
  ).toBeVisible();
});
