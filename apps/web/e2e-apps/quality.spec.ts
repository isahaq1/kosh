/**
 * Quality end to end (RFC 0038 §4): Dina, a Quality manager, writes a control point with its tolerances; an alert
 * is raised, investigated and resolved once its root cause and the corrective action are written; the overview.
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

test('a control point written on screen; an alert investigated and resolved with its cause', async ({
  page,
  request,
}) => {
  await signIn(page, 'dina'); // Quality manager
  await page.goto('/quality/a/quality.action_points/new');
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('E2E visual inspection');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/quality\.action_points\/(\d+)$/);
  const point = page.url().split('/').pop();
  await page.goto('/quality/a/quality.action_points');
  await expect(page.getByText('E2E visual inspection').first()).toBeVisible();
  // The point applies to every receipt: archived again, or it would hold the receipts of the specs that follow
  // (they share this installation) until somebody did its checks. Through the API, with a session of its own.
  const login = await request.post('/api/v1/auth/login', {
    data: { login: 'dina', password: PASSWORD },
  });
  const { token } = (await login.json()) as { token: string };
  const archived = await request.patch(`/api/v1/models/quality.point/${point}`, {
    headers: { authorization: `Bearer ${token}` },
    data: { active: false },
  });
  expect(archived.status()).toBe(200);

  await page.goto('/quality/a/quality.action_alerts/new');
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('E2E torn bags');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/quality\.action_alerts\/\d+$/);
  await page.getByRole('button', { name: 'Investigate' }).click();
  await expect(page.getByRole('button', { name: /^State: Investigating/ })).toBeVisible();
  await page.getByRole('textbox', { name: 'Root cause' }).fill('The pallet was stacked too high.');
  await page.getByRole('textbox', { name: 'Corrective action' }).fill('The bags were repacked.');
  await page.getByRole('button', { name: 'Save' }).click();
  // Saved: the next-step banner no longer asks for the cause, it offers Resolve.
  await expect(page.getByText('Next step: Resolve.')).toBeVisible();
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByRole('button', { name: /^State: Resolved/ })).toBeVisible();
});

test('the Quality overview', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/quality/a/quality.action_overview');
  await expect(page.getByRole('heading', { name: 'Quality · Overview' })).toBeVisible();
  for (const title of ['Checks to do', 'Open alerts', 'Checks by result'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
