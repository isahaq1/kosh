/**
 * Settings › Data health (RFC 0036 §2.3): an Administrator runs the checks and sees each one; two contacts that
 * share an email are shown as duplicates, merged into the one chosen, and the merge undone — after which they are
 * removed again, so the data set is as the other specs expect it. Someone who is not an Administrator is told so.
 */
import { totp } from '@kosh/server';
import { expect, type Page, test } from '@playwright/test';
import { choose } from '../e2e/support.js';

const PASSWORD = 'correct horse battery';
const PAGE = '/settings/a/settings.action_data_health';
const EMAIL = 'dup-e2e@example.com';

async function signIn(page: Page, login: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (login === 'admin') {
    await page.getByLabel('Authentication code').fill(totp('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'));
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
}

test('an Administrator runs the checks, merges two contacts that share an email, and undoes it', async ({
  page,
}) => {
  await signIn(page, 'admin');
  await page.goto(PAGE);
  await expect(page.getByRole('heading', { name: 'Data health', level: 1 })).toBeVisible();

  // The checks the installed apps declare, each with its result.
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByText('No draft points at an archived record')).toBeVisible();
  await expect(page.getByText('Every posted entry balances')).toBeVisible();

  // Two contacts with one email.
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const headers = { 'x-csrf-token': csrf ?? '' };
  const ids: number[] = [];
  for (const name of ['Dup Test One', 'Dup Test Two']) {
    const made = await page.request.post('/api/v1/models/res.partner', {
      headers,
      data: { name, isCompany: true, email: EMAIL },
    });
    expect(made.status(), await made.text()).toBe(201);
    ids.push(((await made.json()) as { id: number }).id);
  }
  try {
    await page.reload();
    const group = page.getByRole('listitem').filter({ hasText: EMAIL });
    await expect(group).toBeVisible();
    await expect(group.getByText('Same Email')).toBeVisible();
    // Keep the second; the first is merged into it.
    await group.getByRole('radio', { name: /Dup Test Two/ }).check();
    await group.getByRole('button', { name: 'Merge into the one kept' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Merge into the one kept' }).click();
    await expect(page.getByText(/1 record merged; \d+ links? moved\./)).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: EMAIL })).toHaveCount(0);

    // The merge is on record, and undone: the duplicate is back.
    const merges = page.getByRole('region', { name: 'Recent merges' });
    await merges.getByRole('button', { name: 'Undo' }).first().click();
    await expect(page.getByText('The merge was undone')).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: EMAIL })).toBeVisible();
  } finally {
    for (const id of ids)
      await page.request.delete(`/api/v1/models/res.partner/${id}`, { headers });
  }
});

test('someone who is not an Administrator does not get the page; in Bangla it speaks Bangla', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto(PAGE);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run now' })).toHaveCount(0);

  await page.context().clearCookies();
  await signIn(page, 'admin');
  await choose(page, 'Language', 'বাংলা');
  await page.goto(PAGE);
  await expect(page.getByRole('heading', { name: 'ডেটার অবস্থা', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'এখন চালান' })).toBeVisible();
});
