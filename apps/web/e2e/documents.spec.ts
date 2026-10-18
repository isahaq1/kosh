/**
 * Documents and scheduled reports end to end (RFC 0005): printing a purchase order to PDF from its form, the
 * drag-and-drop designer (add a block, edit it, see the live preview, save; a broken binding is refused), and a
 * scheduled report run now with its output downloaded.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

const ORDERS = '/purchase/a/purchase.action_orders';

test('print a purchase order as PDF from its form', async ({ page }) => {
  await signIn(page, 'dina'); // approvers see every order; the seeded ones have no requester
  await page.goto(ORDERS);
  await page.getByRole('row', { name: /PO-R-001/ }).click();
  await expect(page.getByRole('heading', { name: 'PO-R-001' })).toBeVisible();
  await page.getByRole('button', { name: 'Print' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Purchase order' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^Purchase_order-PO-R-001\.pdf$/);
  const stream = await file.createReadStream();
  const head = await new Promise<string>((resolve) =>
    stream.once('data', (chunk: Buffer) => resolve(chunk.subarray(0, 5).toString())),
  );
  expect(head).toBe('%PDF-');
});

test('the designer: blocks, live preview, save; a broken binding is refused', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/reports');
  await page
    .getByRole('navigation', { name: 'Main menu' })
    .getByRole('link', { name: 'Documents' })
    .click();
  await page.getByRole('button', { name: 'Purchase order', exact: true }).click();
  const preview = page.frameLocator('iframe[title="Preview"]');
  await expect(preview.getByRole('heading', { level: 1 })).toContainText('Purchase order PO-R-');

  await page.getByRole('button', { name: 'Text' }).click();
  await page.getByRole('button', { name: /^Text/ }).last().click(); // select the new block
  await page.getByLabel('Text', { exact: true }).fill('Vendor: {{vendor.name}}');
  await expect(preview.locator('p')).toContainText('Vendor: Acme Trading');

  // Reorder by drag-and-drop: the new block goes before the heading.
  const items = page.getByRole('list', { name: 'Blocks' }).getByRole('listitem');
  const handle = page.getByRole('button', { name: /^Move text/ });
  const from = await handle.boundingBox();
  const to = await items.first().boundingBox();
  if (from === null || to === null) throw new Error('layout');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y - 10, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 4, { steps: 15 });
  await page.mouse.up();
  await expect(items.first()).toContainText('Text');
  // The preview follows the new order (debounced); it also leaves the drag's click suppression behind us.
  await expect(preview.locator('main > *').first()).toHaveText('Vendor: Acme Trading');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

  await page.getByRole('button', { name: /^Text/ }).first().click();
  await page.getByLabel('Text', { exact: true }).fill('{{vendor.nope}}');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert').first()).toContainText("unknown field 'vendor.nope'");
});

test('a scheduled report: created from the form, run now, output downloaded', async ({ page }) => {
  await signIn(page, 'maria');
  await page.goto('/reports');
  await page
    .getByRole('navigation', { name: 'Main menu' })
    .getByRole('link', { name: 'Scheduled reports' })
    .click();
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByLabel('Name').fill('Monthly spend');
  await page.getByLabel('Model').fill('purchase.order');
  await page
    .getByLabel('Query')
    .fill('{"rows":["vendor"],"measures":{"total":{"sum":"amountTotal"}}}');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Monthly spend' })).toBeVisible();
  await expect(page.getByLabel('Next Run At')).not.toBeEmpty(); // planned from the cadence
  await page.getByRole('button', { name: 'Run now' }).click();
  const output = page.getByRole('region', { name: 'Outputs' }).getByRole('listitem').first();
  await expect(output).toContainText('Monthly_spend.xlsx');
  const download = page.waitForEvent('download');
  await output.getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe('Monthly_spend.xlsx');
  await page.goto('/reports/a/reporting.action_schedules');
  await expect(page.getByRole('row', { name: /Monthly spend/ })).toContainText('Pivot');
});
