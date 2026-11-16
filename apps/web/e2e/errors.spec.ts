/**
 * Errors a user can quote (RFC 0034 §2.2): when the server fails, the screen says so with the request's reference,
 * the first characters of the id the server logged it under.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

test('a server failure on a list shows its reference, and Retry loads the list', async ({
  page,
}) => {
  await signIn(page, 'dina');
  let fail = true;
  await page.route('**/api/v1/models/res.partner?**', async (route) => {
    if (!fail || route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 500,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'https://kosh.dev/problems/internal',
        title: 'Internal error',
        status: 500,
        detail: 'The server failed to handle the request; the error is logged with the request id.',
        requestId: '3f2a9c1e-77b0-4c1d-9a4e-0b1c2d3e4f50',
      }),
    });
  });
  await page.goto('/contacts/a/contacts.action_partners');
  await expect(page.getByText(/logged with the request id\. \(#3f2a9c1e\)/)).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('row', { name: /Bengal Steel/ })).toBeVisible();
});
