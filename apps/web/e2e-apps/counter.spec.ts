/**
 * Counter end to end (RFC 0021): a manager makes a shop with a cash method; at the register a session opens with
 * the drawer's cash, a product is found, its quantity typed and sold, the cash prefilled and the sale confirmed,
 * then refunded with a reason; the session closes with the count.
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

test('a shop, a session, a sale paid in cash, the session closed', async ({ page }) => {
  await signIn(page, 'dina'); // Counter manager
  await page.goto('/counter/a/counter.action_shops/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Shop');
  const methods = page.getByRole('table', { name: 'methods' });
  await methods.locator('..').getByRole('button', { name: 'Add a line' }).click();
  await methods.locator('tbody tr').last().getByRole('textbox').first().fill('Cash');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/counter\.action_shops\/\d+$/);

  await page.goto('/counter/a/counter.action_register');
  const shopButton = page.getByRole('button', { name: 'E2E Shop' });
  if (await shopButton.isVisible().catch(() => false)) await shopButton.click();
  await page.getByLabel('Cash in the drawer').fill('1000');
  await page.getByRole('button', { name: 'Open the session' }).click();
  const search = page.getByRole('textbox', { name: 'Search or scan' });
  await expect(search).toBeVisible();
  await search.fill('Steel beam');
  await page
    .getByRole('button', { name: /Steel beam/ })
    .first()
    .click();
  await expect(page.getByRole('complementary', { name: 'Sale' })).toContainText('Steel beam');
  // A family tile (the T-shirt template's variants) opens the chooser; the variant picked joins the sale.
  await search.fill('');
  await page.getByRole('button', { name: /^T-shirt/ }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /S \/ Red/ })
    .click();
  await expect(page.getByRole('complementary', { name: 'Sale' })).toContainText('T-shirt (S, Red)');
  // The quantity typed (weighed goods are sold the same way).
  await page.getByRole('textbox', { name: /Quantity of Steel beam/ }).fill('2');
  await page.getByRole('button', { name: 'Pay', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Cash').focus();
  await dialog.getByRole('button', { name: 'Confirm the sale' }).click();
  await expect(page.getByRole('status')).toContainText(/R\//);
  const soldAs = (await page.getByRole('status').textContent()) ?? '';
  // The sale taken back, with its reason: a negative sale in the same session.
  await page.getByLabel('Why it comes back').fill('Wrong item');
  await page.getByRole('button', { name: 'Refund', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(/-|−/);
  await expect(page.getByRole('status')).not.toHaveText(soldAs);

  await page.getByRole('button', { name: 'Close the session' }).click();
  const closing = page.getByRole('dialog');
  // The sale and its refund cancel out: the drawer holds the opening cash again (waited for, not read once).
  await expect(closing.getByText(/Cash expected in the drawer/)).toContainText(/1,?000/);
  await closing.getByLabel('Cash counted').fill('1000');
  await closing.getByRole('button', { name: 'Close the session' }).click();
  await expect(page.getByText(/closed: .* sold, difference/)).toBeVisible();
});

test('the customer of a sale is named at the till by what they say, and is on the sale', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/contacts/a/contacts.action_partners/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Till Customer');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('till.customer@example.com');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/contacts\.action_partners\/\d+$/);

  await page.goto('/counter/a/counter.action_register');
  const shopButton = page.getByRole('button', { name: 'E2E Shop' });
  if (await shopButton.isVisible().catch(() => false)) await shopButton.click();
  await page.getByLabel('Cash in the drawer').fill('500');
  await page.getByRole('button', { name: 'Open the session' }).click();
  const box = page.getByRole('textbox', { name: 'Customer of this sale' });
  await expect(box).toBeVisible();
  // Nobody has this: said in words, and the sale goes on without a customer.
  await box.fill('nobody@example.com');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Nobody, or more than one contact');
  // The address, however it is typed.
  await box.fill('Till.Customer@example.com');
  await box.press('Enter');
  const named = page.getByRole('group', { name: 'Customer of this sale' });
  await expect(named).toContainText('E2E Till Customer');

  await page.getByRole('textbox', { name: 'Search or scan' }).fill('Steel beam');
  await page
    .getByRole('button', { name: /Steel beam/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Pay', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Cash').focus();
  await dialog.getByRole('button', { name: 'Confirm the sale' }).click();
  await expect(page.getByRole('status')).toContainText(/R\//);
  // The next sale starts without a customer.
  await expect(named).toHaveCount(0);
  await expect(box).toBeVisible();

  // The sale carries its customer.
  await page.goto('/counter/a/counter.action_orders');
  await expect(page.getByRole('row').nth(1)).toContainText('E2E Till Customer');

  await page.goto('/counter/a/counter.action_register');
  await page.getByRole('button', { name: 'Close the session' }).click();
  const closing = page.getByRole('dialog');
  await closing.getByLabel('Cash counted').fill('500');
  await closing.getByLabel('If it differs, why').fill('E2E');
  await closing.getByRole('button', { name: 'Close the session' }).click();
  await expect(page.getByText(/closed: .* sold, difference/)).toBeVisible();
});

test('a gift card typed at the till comes off the sale, by the server’s arithmetic', async ({
  page,
}) => {
  await signIn(page, 'dina');
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const headers = { 'x-csrf-token': csrf ?? '' };
  const made = await page.request.post('/api/v1/models/loyalty.voucher', {
    headers,
    data: { entries: { create: [{ amount: '1' }] } },
  });
  expect(made.status(), await made.text()).toBe(201);
  const voucher = ((await made.json()) as { id: number }).id;
  const read = async (): Promise<{ code: string; balance: string }> =>
    (await (
      await page.request.get(`/api/v1/models/loyalty.voucher/${voucher}?fields=code,balance`)
    ).json()) as { code: string; balance: string };
  const { code } = await read();

  await page.goto('/counter/a/counter.action_register');
  const shopButton = page.getByRole('button', { name: 'E2E Shop' });
  if (await shopButton.isVisible().catch(() => false)) await shopButton.click();
  await page.getByLabel('Cash in the drawer').fill('500');
  await page.getByRole('button', { name: 'Open the session' }).click();
  await page.getByRole('textbox', { name: 'Search or scan' }).fill('Steel beam');
  await page
    .getByRole('button', { name: /Steel beam/ })
    .first()
    .click();
  // The server offers what may come off the sale; a code that is none is said in words.
  const offers = page.getByRole('form', { name: 'Promotions, points and gift cards' });
  const gift = offers.getByLabel('Gift card or wallet');
  await gift.fill('GC-NOPE');
  await offers.getByRole('button', { name: 'Apply' }).click();
  await expect(offers.getByRole('alert')).toContainText('No gift card or wallet has this code.');
  await gift.fill(code.toLowerCase());
  await gift.press('Enter');
  const off = page.getByRole('list', { name: 'Taken off the sale' });
  await expect(off).toContainText(`Gift card ${code}`);
  await expect(off).toContainText(/−1(.00)?$/);

  await page.getByRole('button', { name: 'Pay', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Cash').focus();
  await dialog.getByRole('button', { name: 'Confirm the sale' }).click();
  await expect(page.getByRole('status')).toContainText(/R\//);
  // The card paid its one taka, once.
  expect(Number((await read()).balance)).toBe(0);

  await page.getByRole('button', { name: 'Close the session' }).click();
  const closing = page.getByRole('dialog');
  const expected = (await closing.getByText(/Cash expected in the drawer/).textContent()) ?? '';
  await closing
    .getByLabel('Cash counted')
    .fill(expected.replace(/[^0-9.]/g, '').replace(/\.$/, ''));
  await closing.getByLabel('If it differs, why').fill('E2E');
  await closing.getByRole('button', { name: 'Close the session' }).click();
  await expect(page.getByText(/closed: .* sold, difference/)).toBeVisible();
});

test('a method paid through a provider: the till shows a code, the customer pays, the sale counts it once confirmed', async ({
  page,
}) => {
  await signIn(page, 'dina');
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const headers = { 'x-csrf-token': csrf ?? '' };
  const list = async (model: string, fields: string, filter: unknown = {}) =>
    (
      (await (
        await page.request.get(
          `/api/v1/models/${model}?fields=${fields}&limit=50&filter=${encodeURIComponent(JSON.stringify(filter))}`,
        )
      ).json()) as { items: Record<string, unknown>[] }
    ).items;
  const post = async (url: string, data: Record<string, unknown>) => {
    const made = await page.request.post(url, { headers, data });
    expect(made.status(), `${url}: ${await made.text()}`).toBeLessThan(300);
    return (await made.json()) as { id: number };
  };
  // The test provider, and a method of the shop that is paid through it.
  const bank = (await list('account.journal', 'type')).find((j) => j['type'] === 'bank');
  const provider = await post('/api/v1/models/payment.provider', {
    name: `E2E wallet ${Date.now()}`,
    code: 'fake',
    journal: bank?.['id'],
  });
  const [shop] = await list('pos.shop', 'name', { name: 'E2E Shop' });
  const method = await post('/api/v1/models/pos.payment.method', {
    shop: shop?.['id'],
    name: 'E2E wallet',
    kind: 'mobile',
    sequence: 5,
    provider: provider.id,
    journal: bank?.['id'],
  });

  await page.goto('/counter/a/counter.action_register');
  const shopButton = page.getByRole('button', { name: 'E2E Shop' });
  if (await shopButton.isVisible().catch(() => false)) await shopButton.click();
  await page.getByLabel('Cash in the drawer').fill('500');
  await page.getByRole('button', { name: 'Open the session' }).click();
  await page.getByRole('textbox', { name: 'Search or scan' }).fill('Steel beam');
  await page
    .getByRole('button', { name: /Steel beam/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Pay', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('E2E wallet').focus();
  await dialog.getByRole('button', { name: 'Ask to pay' }).click();
  // The code the customer scans; the sale waits for the provider.
  await expect(dialog.getByRole('img', { name: /Code to pay .* by E2E wallet/ })).toBeVisible();
  await expect(dialog.getByText('Waiting for the payment…')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Confirm the sale' })).toBeDisabled();
  // The customer, on the provider's page, with no session of ours.
  const [asked] = await list('payment.transaction', 'reference,state', { provider: provider.id });
  const paid = await page.request.post(
    `/api/v1/payment/fake/checkout/${String(asked?.['reference'])}?outcome=paid`,
    { headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: '', maxRedirects: 0 },
  );
  expect(paid.status()).toBeLessThan(400);
  await expect(dialog.getByText(`Paid: ${String(asked?.['reference'])}`)).toBeVisible({
    timeout: 20_000,
  });
  await dialog.getByRole('button', { name: 'Confirm the sale' }).click();
  await expect(page.getByRole('status')).toContainText(/R\//);

  // The method goes away again, so the shop is as the other tests expect it.
  const archived = await page.request.patch(`/api/v1/models/pos.payment.method/${method.id}`, {
    headers,
    data: { active: false },
  });
  expect(archived.status(), await archived.text()).toBeLessThan(300);
  await page.getByRole('button', { name: 'Close the session' }).click();
  const closing = page.getByRole('dialog');
  const expected = (await closing.getByText(/Cash expected in the drawer/).textContent()) ?? '';
  await closing
    .getByLabel('Cash counted')
    .fill(expected.replace(/[^0-9.]/g, '').replace(/\.$/, ''));
  await closing.getByLabel('If it differs, why').fill('E2E');
  await closing.getByRole('button', { name: 'Close the session' }).click();
  await expect(page.getByText(/closed: .* sold, difference/)).toBeVisible();
});
