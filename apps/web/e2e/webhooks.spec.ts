/**
 * Webhooks end to end (RFC 0017 §5.3): an integrations manager opens Integrations › Webhooks, creates a webhook for
 * new contacts on the form, finds the events this installation offers in its tools, and sends a test event, which
 * appears in Deliveries. An inbound webhook: switched on on its form (its URL shown), a signed call handled into a
 * contact and shown in Inbound calls; a forged one refused. Users without the access see no Integrations app.
 */
import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

test('a webhook made on its form; the events offered; a test event logged as a delivery', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/integrations/a/integrations.action_webhooks');
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByLabel('Name').fill('CRM sync');
  await page.getByLabel('URL').fill('https://hooks.example.test/kosh');
  await page.getByLabel('Events').fill('res.partner.created res.partner.updated');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('CRM sync');

  await page.getByText('Events you can subscribe to').click();
  await expect(page.getByText('res.partner.created', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send a test event' }).click();
  await expect(page.getByText('A test event is on its way')).toBeVisible();

  await page.goto('/integrations/a/integrations.action_deliveries');
  await expect(page.getByRole('row', { name: /webhook\.ping/ }).first()).toBeVisible();
});

test('an inbound webhook: its URL on the form; a signed call handled, a forged one refused', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/integrations/a/integrations.action_endpoints');
  await page.getByRole('button', { name: 'New' }).click();
  await expect(page.getByText('contacts.signups', { exact: true })).toBeVisible();
  await page.getByLabel('Name').fill('Website sign-ups');
  await page.getByLabel('Endpoint').fill('contacts.signups');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Website sign-ups');
  const url = (await page.getByTestId('endpoint-url').textContent()) ?? '';
  expect(url).toMatch(/\/api\/v1\/hooks\/[\w-]+$/);

  const rows = await page.request.get('/api/v1/models/webhook.endpoint?fields=name,secret');
  const items = ((await rows.json()) as { items: { name: string; secret: string }[] }).items;
  const secret = items.find((e) => e.name === 'Website sign-ups')?.secret ?? '';
  const send = (body: string, key: string) =>
    page.request.post(url, {
      headers: {
        'content-type': 'application/json',
        'x-signature': createHmac('sha256', key).update(body).digest('hex'),
      },
      data: body,
    });
  const body = JSON.stringify({ id: `evt_${Date.now()}`, name: 'Meghna Fabrics' });
  expect((await send(body, secret)).status()).toBe(202);
  expect((await send(body, 'not the secret')).status()).toBe(401);

  await page.goto('/integrations/a/integrations.action_inbound');
  await expect(page.getByRole('row', { name: /Refused/ }).first()).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('row', { name: /Handled/ }).first()).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
});

test('without the integrations access: no Integrations app, and the server refuses', async ({
  page,
}) => {
  await signIn(page, 'bob');
  await expect(page.getByRole('link', { name: 'Integrations' })).toHaveCount(0);
  const res = await page.request.get('/api/v1/webhooks/events');
  expect(res.status()).toBe(403);
});
