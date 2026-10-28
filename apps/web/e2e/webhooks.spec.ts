/**
 * Webhooks end to end (RFC 0017 §5.3): an integrations manager opens Integrations › Webhooks, creates a webhook for
 * new contacts on the form, finds the events this installation offers in its tools, and sends a test event, which
 * appears in Deliveries. Users without the access see no Integrations app.
 */
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

test('without the integrations access: no Integrations app, and the server refuses', async ({
  page,
}) => {
  await signIn(page, 'bob');
  await expect(page.getByRole('link', { name: 'Integrations' })).toHaveCount(0);
  const res = await page.request.get('/api/v1/webhooks/events');
  expect(res.status()).toBe(403);
});
