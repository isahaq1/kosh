/**
 * The Shop end to end (RFC 0024 §2.7): Dina turns a new site into a shop and adds a delivery method on screen; a
 * visitor, with no session, fills a cart through the public API, sees the method's fee and checks out with cash on
 * delivery; the order is in Sites › Shop orders, confirmed, with how it is paid; its parcel is booked with the test
 * courier from the shipment's form.
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

test('a shop and its delivery method made on screen; a visitor checks out; the order is there', async ({
  page,
  playwright,
}) => {
  await signIn(page, 'dina'); // Shop manager
  await page.goto('/sites/a/sites.action_sites/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E shop');
  await page.getByRole('textbox', { name: 'Key', exact: true }).fill('e2e-shop');
  await page.getByRole('checkbox', { name: 'Shop', exact: true }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/sites\.action_sites\/\d+$/);

  await page.goto('/sites/a/shop.action_carriers/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Express');
  await page.getByRole('textbox', { name: 'Fee', exact: true }).fill('150');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/shop\.action_carriers\/\d+$/);

  // The steel beam goes on the shop.
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const [beam] = (
    (await (
      await page.request.get(
        `/api/v1/models/product.product?fields=id&filter=${encodeURIComponent(JSON.stringify({ name: 'Steel beam' }))}`,
      )
    ).json()) as { items: { id: number }[] }
  ).items;
  expect(
    (
      await page.request.patch(`/api/v1/models/product.product/${beam?.id}`, {
        headers: { 'x-csrf-token': csrf ?? '' },
        data: { published: true },
      })
    ).ok(),
  ).toBe(true);

  // A visitor: no session.
  const visitor = await playwright.request.newContext({ baseURL: new URL(page.url()).origin });
  const shop = '/api/v1/public/shop/e2e-shop';
  const { token } = (await (await visitor.post(`${shop}/cart`)).json()) as { token: string };
  const headers = { 'x-cart-token': token };
  expect(
    (
      await visitor.put(`${shop}/cart/lines`, { headers, data: { product: beam?.id, quantity: 2 } })
    ).ok(),
  ).toBe(true);
  const { carriers } = (await (
    await visitor.get(`${shop}/carriers?city=Dhaka`, { headers })
  ).json()) as { carriers: { id: number; name: string; fee: string }[] };
  const express = carriers.find((c) => c.name === 'Express');
  expect(express?.fee).toBe('150.00');
  const placed = await visitor.post(`${shop}/checkout`, {
    headers,
    data: {
      name: 'Rina Akter',
      email: 'rina.e2e@example.com',
      phone: '01700000000',
      street: 'House 12, Road 5',
      city: 'Dhaka',
      carrier: express?.id,
      payment: 'cod',
    },
  });
  expect(placed.status()).toBe(201);
  const order = (await placed.json()) as { order: string; state: string };
  expect(order.state).toBe('sale');
  await visitor.dispose();

  await page.goto('/sites/a/shop.action_orders');
  const row = page.getByRole('row').filter({ hasText: order.order });
  await expect(row).toBeVisible();
  await row.getByText(order.order).click();
  await expect(page.getByText('Cash on delivery').first()).toBeVisible();
  await expect(page.getByText('Rina Akter').first()).toBeVisible();

  // The parcel, booked with the test courier on screen.
  const [placedOrder] = (
    (await (
      await page.request.get(
        `/api/v1/models/sale.order?fields=id,partner&filter=${encodeURIComponent(JSON.stringify({ name: order.order }))}`,
      )
    ).json()) as { items: { id: number }[] }
  ).items;
  const shipment = (await (
    await page.request.post('/api/v1/models/delivery.shipment', {
      headers: { 'x-csrf-token': csrf ?? '' },
      data: {
        order: placedOrder?.id,
        carrier: express?.id,
        courier: 'fake',
        recipient: 'Rina Akter',
        phone: '01700000000',
        address: 'House 12, Road 5',
        city: 'Dhaka',
        cod: '2150',
      },
    })
  ).json()) as { id: number };
  await page.goto(`/sites/a/shop.action_shipments/${shipment.id}`);
  await page.getByRole('button', { name: 'Book the courier' }).click();
  await expect(page.getByRole('button', { name: /^State: Booked/ })).toBeVisible();
  const booked = (await (
    await page.request.get(`/api/v1/models/delivery.shipment/${shipment.id}`)
  ).json()) as { trackingRef: string | null };
  expect(booked.trackingRef).toMatch(/^FAKE-/);
});
