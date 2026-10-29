/**
 * OAuth 2.0 apps end to end (RFC 0017 §5.2): an Integrations manager registers an app (its secret shown once); a
 * user is asked on the consent page — the app, what it may do, where they go back — and allows it; the app trades
 * the code (with PKCE) for a token that reads the user's contacts; the user removes its access in Connected apps and
 * the token stops working.
 */
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

const REDIRECT = 'https://partner.example.test/callback';

test('register an app, allow it, use its token, remove its access', async ({ page, browser }) => {
  await signIn(page, 'dina'); // Integrations manager
  await page.goto('/integrations/a/integrations.action_oauth_apps');
  await expect(page.getByRole('heading', { name: 'OAuth apps', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New app' }).click();
  const dialog = page.getByRole('dialog', { name: 'A new OAuth app' });
  await dialog.getByLabel('Name').fill('Partner CRM');
  await dialog.getByLabel('Redirect addresses').fill(REDIRECT);
  await dialog.getByLabel('Read Contacts').click();
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog.getByText('Copy the client secret now')).toBeVisible();
  const codes = dialog.locator('code');
  const clientId = ((await codes.nth(0).textContent()) ?? '').trim();
  const clientSecret = ((await codes.nth(1).textContent()) ?? '').trim();
  expect(clientId).toMatch(/^kc_/);
  expect(clientSecret).toMatch(/^ks_/);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Partner CRM')).toBeVisible();

  // Rahim is asked, and allows it; the app's callback receives the code.
  const context = await browser.newContext();
  const rahim = await context.newPage();
  await signIn(rahim, 'rahim');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const ask = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'read:contacts',
    state: 's1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  let callback = '';
  await context.route('https://partner.example.test/**', async (route) => {
    callback = route.request().url();
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Connected</h1>' });
  });
  await rahim.goto(`/oauth/authorize?${ask}`);
  await expect(
    rahim.getByRole('heading', { name: 'Partner CRM wants to use your account' }),
  ).toBeVisible();
  await expect(rahim.getByText('Read Contacts')).toBeVisible();
  await expect(rahim.getByText('You will go back to partner.example.test.')).toBeVisible();
  await rahim.getByRole('button', { name: 'Allow' }).click();
  await expect(rahim.getByRole('heading', { name: 'Connected' })).toBeVisible();
  const back = new URL(callback);
  expect(back.searchParams.get('state')).toBe('s1');
  const code = back.searchParams.get('code') ?? '';

  // The app trades the code for a token, which reads Rahim's contacts.
  const issued = await page.request.post('/api/v1/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: clientId,
      client_secret: clientSecret,
    },
  });
  expect(issued.status()).toBe(200);
  const { access_token: token } = (await issued.json()) as { access_token: string };
  const api = await (await import('@playwright/test')).request.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const read = await api.get('/api/v1/models/res.partner', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(read.status()).toBe(200);

  // Rahim removes its access: the token stops working.
  await rahim.goto('/');
  await rahim.getByRole('button', { name: 'Rahim Uddin' }).click();
  await rahim.getByRole('menuitem', { name: 'Connected apps' }).click();
  await expect(rahim.getByRole('heading', { name: 'Connected apps', level: 1 })).toBeVisible();
  await rahim.getByRole('button', { name: 'Remove the access of Partner CRM' }).click();
  await expect(rahim.getByText('You have not allowed any app.')).toBeVisible();
  const after = await api.get('/api/v1/models/res.partner', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(after.status()).toBe(401);
  await api.dispose();
  await context.close();
});
