/**
 * Routes end to end (RFC 0024 §2.6): the Depot delivers in two steps. A delivery of five anchor bolts, confirmed,
 * leaves from DP/Output and waits; its pick from stock into Output is ready. Dina validates the pick on screen, and
 * the delivery has everything reserved.
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

type Items = { items: { id: number }[] };
const filter = (f: unknown) => encodeURIComponent(JSON.stringify(f));

test('a delivery in two steps: the pick validated on screen brings the delivery its stock', async ({
  page,
}) => {
  await signIn(page, 'dina'); // Stockroom manager
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const headers = { 'x-csrf-token': csrf ?? '' };
  const get = async (url: string) => ((await (await page.request.get(url)).json()) as Items).items;
  const [depot] = await get(
    `/api/v1/models/stock.warehouse?fields=id&filter=${filter({ code: 'DP' })}`,
  );
  const [stock] = await get(
    `/api/v1/models/stock.location?fields=id&filter=${filter({ warehouse: depot?.id, step: { isNull: true } })}`,
  );
  const [customers] = await get(
    `/api/v1/models/stock.location?fields=id&filter=${filter({ usage: 'customer' })}`,
  );
  const [bolt] = await get(
    `/api/v1/models/product.product?fields=id&filter=${filter({ name: 'Anchor bolt' })}`,
  );
  const delivery = (await (
    await page.request.post('/api/v1/models/stock.picking', {
      headers,
      data: {
        kind: 'delivery',
        source: stock?.id,
        destination: customers?.id,
        moves: { create: [{ product: bolt?.id, quantity: '5' }] },
      },
    })
  ).json()) as { id: number };
  expect(
    (
      await page.request.post(`/api/v1/models/stock.picking/${delivery.id}/transitions/confirm`, {
        headers,
      })
    ).ok(),
  ).toBe(true);
  const [pick] = await get(
    `/api/v1/models/stock.picking?fields=id&filter=${filter({ next: delivery.id })}`,
  );

  await page.goto(`/stockroom/a/stockroom.action_deliveries/${delivery.id}`);
  await expect(page.getByText('DP/Output').first()).toBeVisible();
  await expect(page.getByText('Nothing reserved').first()).toBeVisible();
  await page.goto(`/stockroom/a/stockroom.action_transfers/${pick?.id}`);
  await expect(page.getByText('Everything reserved').first()).toBeVisible();
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByRole('button', { name: /^State: Done/ })).toBeVisible();
  await page.goto(`/stockroom/a/stockroom.action_deliveries/${delivery.id}`);
  await expect(page.getByText('Everything reserved').first()).toBeVisible();
});
