/**
 * Spreadsheet-grade list editing (RFC 0010 Phase B): the keyboard moves between cells and edits them (Enter saves
 * and moves down), a block from a spreadsheet pastes from the active cell (cells it cannot go into are skipped and
 * said), a range fills down, copy gives tab-separated text, and the paste can be undone.
 */
import { expect, type Page, test } from '@playwright/test';
import { signIn } from './support.js';

const CONTACTS = '/contacts/a/contacts.action_partners';

/** Pastes `text` as a spreadsheet would (a paste event on the focused cell). */
async function paste(page: Page, text: string): Promise<void> {
  await page.evaluate((data) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', data);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, text);
}

/** Copies the selection as the grid writes it (a copy event on the focused cell). */
async function copy(page: Page): Promise<string> {
  return page.evaluate(() => {
    const transfer = new DataTransfer();
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
    return transfer.getData('text/plain');
  });
}

let prefix = '';
const row = (page: Page, name: string) =>
  page.getByRole('row', { name: new RegExp(`${prefix} ${name}`) });
/** The city cell (the one inline-editable column; cell 0 is the selection checkbox, then name, email). */
const city = (page: Page, name: string) => row(page, name).getByRole('cell').nth(3);

test.beforeEach(async ({ page }) => {
  prefix = `Grid${Date.now().toString(36).slice(-4)}`;
  await signIn(page, 'admin');
  // Three contacts of this test, through the form.
  for (const [name, town] of [
    ['Alpha', 'Dhaka'],
    ['Beta', 'Bogura'],
    ['Gamma', 'Cumilla'],
  ] as const) {
    await page.goto(`${CONTACTS}/new`);
    await page.getByLabel('Name').fill(`${prefix} ${name}`);
    await page.getByLabel('City').fill(town);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page).toHaveURL(/contacts\.action_partners\/\d+$/); // saved: the record's page
  }
  await page.goto(CONTACTS);
  const search = page.getByRole('combobox', { name: 'Search…' });
  await search.fill(prefix);
  await page.getByRole('option', { name: `Search Name for: ${prefix}` }).click();
  await expect(page.getByRole('row', { name: /Bengal Steel/ })).toHaveCount(0); // the search applied
  await expect(row(page, 'Gamma')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  // The contacts of this test go (the other tests count rows).
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const found = await page.request.get(`/api/v1/models/res.partner/names?q=${prefix}&limit=10`);
  for (const item of ((await found.json()) as { items: { id: number }[] }).items)
    await page.request.delete(`/api/v1/models/res.partner/${item.id}`, {
      headers: { 'x-csrf-token': csrf ?? '' },
    });
});

test('keyboard: arrows move, typing edits, Enter saves and moves down, F2 edits in place', async ({
  page,
}) => {
  await row(page, 'Alpha').getByRole('cell').nth(2).focus(); // the email cell
  await page.keyboard.press('ArrowRight'); // the city cell
  await page.keyboard.type('Sylhet'); // a typed character starts editing, replacing the value
  await page.keyboard.press('Enter'); // saves and moves down
  await expect(row(page, 'Alpha').getByText('Sylhet')).toBeVisible();
  await page.keyboard.press('F2'); // the cell below, with its value
  await page.keyboard.press('End');
  await page.keyboard.type(' Sadar');
  await page.keyboard.press('Enter');
  await expect(row(page, 'Beta').getByText('Bogura Sadar')).toBeVisible();
  // Enter on a cell that is not editable opens the record.
  await row(page, 'Gamma').getByRole('cell').nth(1).focus(); // the name cell
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`${prefix} Gamma`);
});

test('paste lands from the active cell, skipped cells are said, copy is tab-separated, undo works', async ({
  page,
}) => {
  await city(page, 'Alpha').focus();
  await paste(page, 'Pasted A\r\nPasted B\r\n');
  await expect(page.getByRole('status').filter({ hasText: '2 cells pasted' })).toBeVisible();
  await expect(row(page, 'Alpha').getByText('Pasted A')).toBeVisible();
  await expect(row(page, 'Beta').getByText('Pasted B')).toBeVisible();
  await expect(row(page, 'Gamma').getByText('Cumilla')).toBeVisible();

  // A block wider than the editable columns: the credit limit cannot be edited here, and the paste says so.
  await city(page, 'Gamma').focus();
  await paste(page, 'Pasted C\t12345');
  await expect(row(page, 'Gamma').getByText('Pasted C')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '1 cell skipped' })).toBeVisible();

  // Copy the three cities: Shift+↓ selects, the clipboard gets one per line.
  await city(page, 'Alpha').focus();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  expect(await copy(page)).toBe('Pasted A\nPasted B\nPasted C');

  // Undo puts the previous value back.
  await city(page, 'Alpha').focus();
  await paste(page, 'Gone');
  await expect(row(page, 'Alpha').getByText('Gone')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).last().click(); // the newest toast's
  await expect(row(page, 'Alpha').getByText('Pasted A')).toBeVisible();
});

test('fill down copies the top cell into the selected cells below', async ({ page }) => {
  await city(page, 'Alpha').focus();
  await page.keyboard.press('Control+d'); // a single cell: nothing to fill, a hint
  await expect(
    page.getByRole('status').filter({ hasText: 'Select the cells below' }),
  ).toBeVisible();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Control+d');
  await expect(page.getByRole('status').filter({ hasText: '2 cells filled down' })).toBeVisible();
  await expect(row(page, 'Beta').getByText('Dhaka')).toBeVisible();
  await expect(row(page, 'Gamma').getByText('Dhaka')).toBeVisible();
});
