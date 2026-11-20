/**
 * Loyalty end to end (RFC 0034 §2.6): a manager writes a program on screen, presses Preview and reads what it
 * would have given over the orders already confirmed — nothing is earned by looking — before a program is ever
 * launched. (Earning, tiers, expiry, cancellations: the integration tests; the demo's own program stays as it is.)
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

test('a program written on screen and previewed on past orders before it runs', async ({
  page,
}) => {
  await signIn(page, 'dina');
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const headers = { 'x-csrf-token': csrf ?? '' };
  const name = `Rewards ${Date.now()}`;
  // A program whose preview covers today, with a point for every hundred.
  const today = new Date().toISOString().slice(0, 10);
  const made = await page.request.post('/api/v1/models/loyalty.program', {
    headers,
    data: {
      name,
      pointValue: '1',
      previewFrom: `${today.slice(0, 4)}-01-01`,
      previewTo: today,
      rules: { create: [{ name: 'A point for every 100', points: 1, amountPer: '100' }] },
    },
  });
  expect(made.status(), await made.text()).toBe(201);
  const id = ((await made.json()) as { id: number }).id;

  await page.goto(`/loyalty/a/loyalty.action_programs/${id}`);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  // The figures arrive, and it is still a draft: Launch is offered.
  await expect(page.getByRole('button', { name: 'Launch', exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const read = await page.request.get(
        `/api/v1/models/loyalty.program/${id}?fields=state,previewAt,previewOrders`,
      );
      const p = (await read.json()) as { state: string; previewAt: string | null };
      return [p.state, p.previewAt !== null];
    })
    .toEqual(['draft', true]);
  await page.reload();
  await expect(page.getByText('Previewed at')).toBeVisible();
  // Looking gave no card of this program to anyone.
  const cards = await page.request.get(
    `/api/v1/models/loyalty.card?filter=${encodeURIComponent(JSON.stringify({ program: id }))}`,
  );
  expect(((await cards.json()) as { items: unknown[] }).items).toEqual([]);
});
