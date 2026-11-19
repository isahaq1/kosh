/**
 * Subscriptions end to end (RFC 0034 §2.5): a manager's subscription that started forty days ago is invoiced for
 * the two periods that have begun — once each, however often what is due is run —, shows them on its page, is
 * paused and resumed; someone without the role gets neither the records nor the run. (Periods, proration, usage
 * and trials: the integration tests.)
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

async function headers(page: Page): Promise<Record<string, string>> {
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  return { 'x-csrf-token': csrf ?? '' };
}

function daysAgo(days: number): string {
  const day = new Date(Date.now() - days * 86_400_000);
  return day.toISOString().slice(0, 10);
}

test('a subscription is invoiced once per period that has begun, paused and resumed', async ({
  page,
}) => {
  await signIn(page, 'dina');
  const h = await headers(page);
  const make = async (model: string, data: Record<string, unknown>): Promise<number> => {
    const made = await page.request.post(`/api/v1/models/${model}`, { headers: h, data });
    expect(made.status(), `${model}: ${await made.text()}`).toBe(201);
    return ((await made.json()) as { id: number }).id;
  };
  const stamp = Date.now();
  const customer = `Karnaphuli Mills ${stamp}`;
  const plan = await make('subscription.plan', { name: `Monthly ${stamp}`, unit: 'month' });
  const product = await make('product.product', {
    name: `Hosting ${stamp}`,
    kind: 'service',
    listPrice: '2500',
  });
  const partner = await make('res.partner', { name: customer });
  const id = await make('subscription.subscription', {
    partner,
    plan,
    dateStart: daysAgo(40),
    lines: { create: [{ product, quantity: '2' }] },
  });
  const begun = await page.request.post(
    `/api/v1/models/subscription.subscription/${id}/transitions/begin`,
    { headers: h },
  );
  expect(begun.status(), await begun.text()).toBe(200);

  // What is due, run twice: the second run finds nothing left for this subscription.
  const run = await page.request.post('/api/v1/subscriptions/run', { headers: h });
  expect(run.status(), await run.text()).toBe(200);
  expect(((await run.json()) as { invoices: number }).invoices).toBeGreaterThanOrEqual(2);
  await page.request.post('/api/v1/subscriptions/run', { headers: h });
  const record = await page.request.get(
    `/api/v1/models/subscription.subscription/${id}?fields=periodsBilled,state`,
  );
  expect(await record.json()).toMatchObject({ periodsBilled: 2, state: 'active' });

  // On its page: the two invoices, the amount per period.
  await page.goto('/subscriptions/a/subscriptions.action_subscriptions?view=list');
  await expect(page.getByRole('heading', { name: 'Subscriptions', level: 1 })).toBeVisible();
  await page
    .getByRole('row', { name: new RegExp(customer) })
    .getByText(customer)
    .click();
  const invoices = page.getByRole('table', { name: 'invoices' });
  await expect(invoices.getByRole('row')).toHaveCount(3);
  // Read only: an invoice is not removed from here.
  await expect(invoices.getByRole('button', { name: 'Remove line' })).toHaveCount(0);
  await expect(invoices.getByRole('cell', { name: '5,000' })).toHaveCount(2);

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
});

test('without the role: no subscriptions and no run', async ({ page }) => {
  await signIn(page, 'nadia');
  const h = await headers(page);
  const list = await page.request.get('/api/v1/models/subscription.subscription');
  expect(list.status()).toBe(403);
  const run = await page.request.post('/api/v1/subscriptions/run', { headers: h });
  expect(run.status()).toBe(403);
});
