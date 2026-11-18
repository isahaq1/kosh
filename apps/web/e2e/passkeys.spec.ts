/**
 * Passkeys on screen (RFC 0034 §2.4), with Chrome's own virtual authenticator — the browser's real WebAuthn
 * ceremony, not a fake of it: a person adds a passkey in their profile, signs out, signs in with it without a
 * password, removes it, and is then refused in words on the sign-in page. (Every way an answer can be wrong is
 * proved on the server: `packages/server/test/passkeys…`.)
 */
import { expect, type Page, test } from '@playwright/test';
import { signIn } from './support.js';

async function openProfile(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Rahim Uddin' }).click();
  await page.getByRole('menuitem', { name: 'Your profile' }).click();
  await expect(page.getByRole('heading', { name: 'Your profile', level: 1 })).toBeVisible();
}

test('a passkey is added in the profile, signs in without a password, and is refused once removed', async ({
  page,
}) => {
  // A platform authenticator that keeps passkeys and verifies its user, as a laptop's fingerprint reader does.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await signIn(page, 'rahim');
  await openProfile(page);
  const section = page.getByRole('region', { name: 'Passkeys' });
  const name = `E2E laptop ${Date.now()}`;
  await section.getByLabel('Name of the passkey').fill(name);
  await section.getByRole('button', { name: 'Add a passkey' }).click();
  const row = section.getByRole('listitem').filter({ hasText: name });
  await expect(row).toContainText('never used');

  // Signed out, the passkey is the whole sign-in: no login, no password, no code.
  await page.getByRole('button', { name: 'Rahim Uddin' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Use a passkey' })).toBeVisible();
  await page.getByRole('button', { name: 'Use a passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();

  await openProfile(page);
  const again = page.getByRole('region', { name: 'Passkeys' });
  const mine = again.getByRole('listitem').filter({ hasText: name });
  await expect(mine).toContainText('last used');
  await mine.getByRole('button', { name: 'Remove' }).click();
  await expect(again.getByRole('listitem').filter({ hasText: name })).toHaveCount(0);

  // The device still has it; the server does not: refused, in words, and the password form is still there.
  await page.getByRole('button', { name: 'Rahim Uddin' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Use a passkey' }).click();
  await expect(page.getByRole('alert')).toContainText('This passkey could not sign you in');
  await expect(page.getByLabel('Password')).toBeVisible();
});
