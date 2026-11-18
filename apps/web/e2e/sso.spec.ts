/**
 * Single sign-on on screen (RFC 0034 §2.4): the sign-in page says in words why a provider's sign-in was refused; an
 * Administrator adds a provider in Settings › Security and is told the redirect address to register and which
 * variable holds its secret — and until that secret is set, the provider is not offered at sign-in. (The sign-on
 * itself is proved against a provider on the server: `packages/server/test/sso…`.)
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

test('a refused sign-on is said in words on the sign-in page', async ({ page }) => {
  await page.goto('/login?sso_error=unknown');
  await expect(page.getByRole('alert')).toContainText(
    'Nobody here has that address. Ask your administrator to add you',
  );
  await page.goto('/login?sso_error=token');
  await expect(page.getByRole('alert')).toContainText('could not be trusted');
  // A hand-off code that is not ours: refused by the server, and the password form is still there.
  await page.goto('/login?sso=not-a-real-hand-off-code');
  await expect(page.getByRole('alert')).toContainText('used already or took too long');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('an Administrator adds a provider; without its secret it is not offered at sign-in', async ({
  page,
}) => {
  await signIn(page, 'admin');
  await page.goto('/settings/a/settings.action_security');
  const section = page.getByRole('region', { name: 'Single sign-on' });
  await expect(section).toBeVisible();

  // An issuer that is not https is refused by the server, in its words.
  const form = section.getByRole('form', { name: 'Add a provider' });
  await form.getByLabel('Name on the sign-in button').fill('Acme ID');
  await form.getByLabel('Key').fill('acme-e2e');
  await form.getByLabel('Issuer').fill('http://id.acme.example');
  await form.getByLabel('Client ID').fill('kosh-client');
  await form.getByRole('button', { name: 'Add' }).click();
  await expect(section.getByRole('alert')).toContainText('The issuer is an https address.');

  await form.getByLabel('Issuer').fill('https://id.acme.example');
  await form.getByRole('button', { name: 'Add' }).click();
  const provider = section.getByRole('listitem').filter({ hasText: 'Acme ID' });
  await expect(provider).toBeVisible();
  try {
    await expect(provider).toContainText('/api/v1/auth/sso/acme-e2e/callback');
    await expect(provider).toContainText('KOSH_SSO_ACME_E2E_SECRET');
    await expect(provider).toContainText('Secret not set: not offered at sign-in');

    // Signed out, the sign-in page offers no provider.
    const other = await page.context().browser()?.newContext();
    const guest = await other?.newPage();
    if (guest === undefined) throw new Error('no second browser context');
    await guest.goto(new URL('/login', page.url()).toString());
    await expect(guest.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(guest.getByRole('link', { name: /Sign in with/ })).toHaveCount(0);
    await other?.close();
  } finally {
    await provider.getByRole('button', { name: 'Remove' }).click();
    await expect(section.getByRole('listitem').filter({ hasText: 'Acme ID' })).toHaveCount(0);
  }
});
