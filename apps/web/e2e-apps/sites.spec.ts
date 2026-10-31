/**
 * Sites end to end (RFC 0021): Dina makes a site and a page with a text block; the page form previews it; once
 * published, the public API serves it without a sign-in.
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

test('a page made from a block, previewed, published and served by the public API', async ({
  page,
  playwright,
}) => {
  await signIn(page, 'dina'); // Sites manager
  await page.goto('/sites/a/sites.action_sites/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E site');
  await page.getByRole('textbox', { name: 'Key', exact: true }).fill('e2e-site');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/sites\.action_sites\/\d+$/);

  await page.goto('/sites/a/sites.action_pages/new');
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Hello from E2E');
  await page.getByRole('combobox', { name: 'Site' }).click();
  await page.getByRole('option', { name: 'E2E site' }).click();
  await page.getByRole('textbox', { name: 'Path', exact: true }).fill('/hello');
  const blocks = page.getByRole('table', { name: 'blocks' });
  await blocks.locator('..').getByRole('button', { name: 'Add a line' }).click();
  await blocks
    .locator('tbody tr')
    .last()
    .getByRole('textbox')
    .first()
    .fill('Fresh rice every week');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/sites\.action_pages\/\d+$/);
  const preview = page.frameLocator('iframe[title="Preview"]');
  await expect(preview.getByRole('heading', { name: 'Fresh rice every week' })).toBeVisible();

  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByRole('button', { name: /^State: Published/ })).toBeVisible();

  // A visitor: no session.
  const anonymous = await playwright.request.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const res = await anonymous.get('/api/v1/public/sites/e2e-site/page?path=/hello');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { page: { title: string; blocks: { title: string }[] } };
  expect(body.page.title).toBe('Hello from E2E');
  expect(body.page.blocks[0]?.title).toBe('Fresh rice every week');
  await anonymous.dispose();
});
