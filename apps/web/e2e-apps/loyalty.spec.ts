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

test('a gift card pays part of a quotation from the order form', async ({ page }) => {
  await signIn(page, 'dina');
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const headers = { 'x-csrf-token': csrf ?? '' };
  const make = async (model: string, data: Record<string, unknown>): Promise<number> => {
    const made = await page.request.post(`/api/v1/models/${model}`, { headers, data });
    expect(made.status(), `${model}: ${await made.text()}`).toBe(201);
    return ((await made.json()) as { id: number }).id;
  };
  const stamp = Date.now();
  const gift = await make('loyalty.voucher', {
    entries: { create: [{ amount: '300', note: 'Sold at the counter' }] },
  });
  const code = (
    (await (
      await page.request.get(`/api/v1/models/loyalty.voucher/${gift}?fields=code`)
    ).json()) as {
      code: string;
    }
  ).code;
  const customer = await make('res.partner', { name: `Gift Buyer ${stamp}` });
  const product = await make('product.product', { name: `Gift Goods ${stamp}`, listPrice: '1000' });
  const [currency] = (
    (await (await page.request.get('/api/v1/models/res.currency?fields=name&limit=1')).json()) as {
      items: { id: number }[];
    }
  ).items;
  const order = await make('sale.order', {
    partner: customer,
    currency: currency?.id,
    lines: { create: [{ product, name: 'Goods', quantity: '1', priceUnit: '1000' }] },
  });

  await page.goto(`/sales/a/sales.action_orders/${order}`);
  await page.getByLabel('Gift card or wallet').fill(code);
  await page.getByRole('button', { name: 'Apply points and credit' }).click();
  // The line is on the order, and the card is empty.
  await expect(page.getByRole('row', { name: new RegExp(`Gift card ${code}`) })).toContainText(
    '-300',
  );
  await expect
    .poll(async () => {
      const read = await page.request.get(`/api/v1/models/loyalty.voucher/${gift}?fields=balance`);
      return Number(((await read.json()) as { balance: string }).balance);
    })
    .toBe(0);
  const read = await page.request.get(`/api/v1/models/sale.order/${order}?fields=voucherUsed`);
  expect(Number(((await read.json()) as { voucherUsed: string }).voucherUsed)).toBe(300);
});
