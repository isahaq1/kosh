/**
 * The stock ledger (RFC 0032 §3.3): the summary by movement type for the period, the movements, and the stock
 * report, each from the server; the XLSX downloads.
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

test('the stock ledger: summary, movements and the stock report; the XLSX downloads', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/stockroom/a/stockroom.action_ledger');
  await expect(page.getByRole('heading', { name: 'Stock ledger' })).toBeVisible();
  await page.getByLabel('From').fill('2020-01-01');
  await expect(page.getByRole('columnheader', { name: 'Purchase receipt' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Movements' }).click();
  await expect(page.getByRole('columnheader', { name: 'Movement' })).toBeVisible();
  await page.getByRole('button', { name: 'Stock', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'On hand' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'XLSX' }).click();
  expect((await download).suggestedFilename()).toMatch(/^stock-report\.xlsx$/);
});

test('stock by family: a template’s variants in one row, and its stock as a matrix (RFC 0030)', async ({
  page,
}) => {
  await signIn(page, 'dina');
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const headers = { 'x-csrf-token': csrf ?? '' };
  const list = async (model: string, filter: unknown, fields: string) =>
    (
      (await (
        await page.request.get(
          `/api/v1/models/${model}?fields=${fields}&filter=${encodeURIComponent(JSON.stringify(filter))}&limit=50`,
        )
      ).json()) as { items: { id: number; name: string }[] }
    ).items;
  const post = async (url: string, data: Record<string, unknown>) => {
    const made = await page.request.post(url, { headers, data });
    expect(made.status(), `${url}: ${await made.text()}`).toBeLessThan(300);
    return (await made.json()) as { id: number };
  };
  // Two variants of the T-shirt are received.
  const [template] = await list('product.template', { name: 'T-shirt' }, 'name');
  const variants = await list('product.product', { template: template?.id }, 'name');
  const small = variants.find((v) => v.name.includes('S, Red'));
  const medium = variants.find((v) => v.name.includes('M, Blue'));
  expect(small && medium, JSON.stringify(variants)).toBeTruthy();
  const [vendors] = await list('stock.location', { usage: 'vendor' }, 'name');
  const [stock] = await list('stock.location', { usage: 'internal' }, 'name');
  const receipt = await post('/api/v1/models/stock.picking', {
    kind: 'receipt',
    source: vendors?.id,
    destination: stock?.id,
    moves: {
      create: [
        { product: small?.id, quantity: '6' },
        { product: medium?.id, quantity: '3' },
      ],
    },
  });
  await post(`/api/v1/models/stock.picking/${receipt.id}/transitions/confirm`, {});
  await post(`/api/v1/models/stock.picking/${receipt.id}/transitions/validate`, {});

  await page.goto('/stockroom/a/stockroom.action_ledger');
  await page.getByRole('button', { name: 'Stock', exact: true }).click();
  // Variant by variant first; then together.
  await expect(page.getByRole('cell', { name: /T-shirt \(S, Red\)/ }).first()).toBeVisible();
  await page.getByLabel('By family (variants together)').check();
  const family = page.getByRole('button', { name: 'T-shirt', exact: true }).first();
  await expect(family).toBeVisible();
  await expect(page.getByRole('cell', { name: /T-shirt \(S, Red\)/ })).toHaveCount(0);
  await expect(page.getByText('2 variants').first()).toBeVisible();
  // The family's matrix: sizes down, colours across.
  await family.click();
  const dialog = page.getByRole('dialog', { name: 'Stock of T-shirt' });
  await expect(dialog.getByRole('columnheader', { name: 'Red' })).toBeVisible();
  await expect(dialog.getByRole('columnheader', { name: 'Blue' })).toBeVisible();
  await expect(dialog.getByRole('rowheader', { name: 'S', exact: true })).toBeVisible();
  await expect(dialog.getByRole('row', { name: /^S / })).toContainText('6');
  await expect(dialog.getByText(/All variants: .* available/)).toBeVisible();
});
