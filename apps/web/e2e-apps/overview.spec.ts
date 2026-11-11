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
  // The top-records card shows each quotation's amount (a Money value), not a crashed card.
  await expect(page.getByRole('region', { name: 'Biggest open quotations' })).toContainText(/BDT/);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
});

test('a card hidden by the user stays hidden after a reload; Show brings it back (RFC 0022 step 3)', async ({
  page,
}) => {
  await signIn(page, 'rahim');
  await page.goto('/sales/a/sales.action_overview');
  await expect(page.getByRole('region', { name: 'Open quotations', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Customise' }).click();
  await page
    .getByRole('region', { name: 'Open quotations', exact: true })
    .getByRole('button', { name: /Remove/ })
    .click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('region', { name: 'Open quotations', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Sales this month', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Open quotations', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /Show the 1 hidden card/ }).click();
  await expect(page.getByRole('region', { name: 'Open quotations', exact: true })).toBeVisible();
});

test('a KPI moves by itself when a record it counts is created (RFC 0033 step 5)', async ({
  page,
}) => {
  await signIn(page, 'rahim');
  await page.goto('/sales/a/sales.action_overview');
  const kpi = page.getByRole('region', { name: 'Open quotations', exact: true });
  await expect(kpi).toBeVisible();
  const figure = kpi.locator('p.text-3xl');
  await expect(figure).toHaveText(/\d/);
  const before = (await figure.innerText()).trim();
  // Another quotation, made through the API: no reload, no click on this page.
  const made = await page.evaluate(async () => {
    const csrf = sessionStorage.getItem('kosh.csrf') ?? '';
    const idOf = (v: unknown) =>
      typeof v === 'object' && v !== null ? (v as { id: number }).id : (v as number);
    const [order] = (
      (await (await fetch('/api/v1/models/sale.order?limit=1&fields=partner,currency')).json()) as {
        items: { partner: unknown; currency: unknown }[];
      }
    ).items;
    const res = await fetch('/api/v1/models/sale.order', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ partner: idOf(order?.partner), currency: idOf(order?.currency) }),
    });
    return res.status;
  });
  expect(made).toBe(201);
  await expect(figure).not.toHaveText(before);
  // The figure that changed is marked as changed (it flashes once).
  await expect(kpi.locator('[data-changed="true"]')).toHaveCount(1);
});
