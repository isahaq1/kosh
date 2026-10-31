/**
 * App overviews end to end (RFC 0022 §3.2): the Sales app opens on its Overview — the month's KPIs with their
 * change, the year's curve, the top customers and the quotations to chase — declared in the manifest, installed as
 * a dashboard, read-only for the user.
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

test('the Sales overview: KPIs, a chart, the top customers and the open quotations; no editing', async ({
  page,
}) => {
  await signIn(page, 'rahim'); // Sales user
  await page.goto('/sales');
  await page
    .getByRole('navigation', { name: 'Main menu' })
    .getByRole('link', { name: 'Overview' })
    .click();
  await expect(page).toHaveURL(/\/sales\/a\/sales\.action_overview$/);
  await expect(page.getByRole('heading', { name: 'Sales · Overview' })).toBeVisible();
  for (const title of [
    'Sales this month',
    'Open quotations',
    'Top customers',
    'Biggest open quotations',
  ])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
  // The seeded orders: at least one open quotation, and a customer in the pivot.
  await expect(page.getByRole('region', { name: 'Top customers' })).toContainText(
    /Bengal Steel|Padma/,
  );
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
});
