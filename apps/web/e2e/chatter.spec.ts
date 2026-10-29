/**
 * The chatter end to end (RFC 0006 §5.1): a note with an @mention picked by keyboard and a file; the change log of
 * an edit; an activity planned for a colleague, who completes it from their own session; accessibility of the panel.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { choose, signIn } from './support.js';

const ORDERS = '/purchase/a/purchase.action_orders';

async function openOrder(page: Page, name: string): Promise<void> {
  await page.goto(ORDERS);
  await page.getByRole('row', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

const chatter = (page: Page) => page.getByRole('region', { name: 'Chatter' });

test('a note with a mention and a file; following; the change log of an edit', async ({ page }) => {
  await signIn(page, 'dina'); // approvers see every order
  await openOrder(page, 'PO-R-002');
  const panel = chatter(page);
  await expect(panel.getByText('Created the record')).toBeVisible();

  await panel.getByRole('button', { name: 'Log note' }).click();
  const box = panel.getByRole('combobox', { name: 'Log note' });
  await box.fill('Price checked with @Mar');
  const suggestions = panel.getByRole('listbox', { name: 'People to mention' });
  await expect(suggestions.getByRole('option', { name: 'Maria Das' })).toBeVisible();
  await box.press('Enter'); // picks the highlighted suggestion
  await expect(box).toHaveValue('Price checked with @Maria Das ');
  await box.pressSequentially('— **ok** to approve');
  await panel.locator('input[type="file"]').setInputFiles({
    name: 'quote.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Acme quote: 8 000 BDT'),
  });
  await expect(panel.getByRole('button', { name: 'Remove quote.txt' })).toBeVisible();
  await box.press('Control+Enter');

  const note = panel.getByRole('article').filter({ hasText: 'Price checked with' });
  await expect(note.locator('.mention')).toHaveText('@Maria Das');
  await expect(note.locator('strong')).toHaveText('ok');
  await expect(note.getByText('Note', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await note.getByRole('button', { name: 'Download quote.txt' }).click();
  expect((await download).suggestedFilename()).toBe('quote.txt');
  await expect(panel.getByRole('button', { name: 'Following' })).toBeVisible(); // the author follows

  // Edit the order: the change appears in the timeline, with the old and new values.
  await page.getByLabel('Amount Total').fill('8500');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByText('Amount Total').first()).toBeVisible();
  await expect(panel.locator('li', { hasText: 'Amount Total' }).first()).toContainText(
    'Amount Total: 8,000 → 8,500',
  );
  // Put the amount back: the report tests read the seeded totals.
  await page.getByLabel('Amount Total').fill('8000');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(panel.locator('li', { hasText: 'Amount Total' }).first()).toContainText(
    'Amount Total: 8,500 → 8,000',
  );
});

test('an activity planned for a colleague, completed in their session', async ({ browser }) => {
  const dina = await browser.newPage();
  await signIn(dina, 'dina');
  await openOrder(dina, 'PO-R-003');
  await chatter(dina).getByRole('button', { name: 'Activity' }).click();
  const dialog = dina.getByRole('dialog', { name: 'Activity' });
  await dialog.getByLabel('Type').click();
  await dina.getByRole('option', { name: 'Call' }).click();
  await dialog.getByLabel('Summary').fill('Negotiate the delivery date');
  await dialog.getByLabel('Assigned to').click();
  await dina.getByRole('option', { name: 'Maria Das' }).click();
  await dialog.getByRole('button', { name: 'Schedule' }).click();
  await expect(chatter(dina).getByText('Negotiate the delivery date')).toBeVisible();
  await expect(chatter(dina).getByText('for Maria Das')).toBeVisible();
  await dina.close();

  const maria = await browser.newPage();
  await signIn(maria, 'maria');
  await openOrder(maria, 'PO-R-003');
  const panel = chatter(maria);
  await panel.getByRole('button', { name: 'Mark done' }).click();
  const done = maria.getByRole('dialog', { name: /Call: Negotiate/ });
  await done.getByLabel('Feedback').fill('Vendor confirmed next Monday.');
  await done.getByRole('button', { name: 'Done' }).click();
  const logged = panel.getByRole('article').filter({ hasText: 'Call done' });
  await expect(logged).toContainText('Negotiate the delivery date');
  await expect(logged).toContainText('Vendor confirmed next Monday.');
  await expect(panel.getByRole('button', { name: 'Mark done' })).toHaveCount(0);
  await maria.close();
});

for (const theme of ['Light', 'Dark'] as const)
  test(`the chatter has no serious accessibility violations (${theme})`, async ({ page }) => {
    await signIn(page, 'dina');
    await choose(page, 'Theme', theme);
    await openOrder(page, 'PO-R-002');
    await expect(chatter(page).getByRole('article').first()).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include('section[aria-label="Chatter"]')
      .analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(serious.map((v) => `${theme}: ${v.id} (${v.nodes.length}) ${v.help}`)).toEqual([]);
  });
