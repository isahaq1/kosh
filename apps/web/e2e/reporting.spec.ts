/**
 * The report views end to end (RFC 0005): pivot (headers, totals, comparison, drill-down to the records, XLSX
 * download), graph, calendar, gantt, cohort, map, hierarchy, spreadsheets with live REPORT() cells, and dashboards
 * built without code. Seeded: three orders this month, one a year ago (dina sees them all).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

const ORDERS = '/purchase/a/purchase.action_orders';
const CONTACTS = '/contacts/a/contacts.action_partners';

test('pivot: vendors by month with totals; a cell drills down to its records; XLSX download', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto(`${ORDERS}?view=pivot`);
  const table = page.getByRole('table');
  await expect(table.getByRole('rowheader', { name: 'Acme Trading' })).toBeVisible();
  await expect(table.getByRole('rowheader', { name: 'Bengal Steel' })).toBeVisible();
  const acme = table.getByRole('row', { name: /Acme Trading/ });
  await expect(acme).toContainText('30,000'); // the row total: 12 000 + 8 000 this month, 10 000 last year
  // The cell of Acme this month: 2 orders, 20 000.
  const cell = acme.getByRole('button', { name: '20,000' });
  await expect(cell).toBeVisible();
  await cell.click();
  await expect(page).toHaveURL(/view=list/);
  await expect(page.getByRole('row', { name: /PO-R-001/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /PO-R-002/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /PO-R-003/ })).toHaveCount(0);
  await expect(page.getByRole('row', { name: /PO-R-OLD/ })).toHaveCount(0);

  // Downloads need the export permission: approvers are refused (shown), managers get the file.
  await page.goto(`${ORDERS}?view=pivot`);
  await page.getByRole('button', { name: 'Download' }).click();
  await page.getByRole('menuitem', { name: 'Excel (XLSX)' }).click();
  await expect(page.getByRole('alert')).toContainText('export');
  await page.getByRole('button', { name: 'Dina Rahman' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await signIn(page, 'maria');
  await page.goto(`${ORDERS}?view=pivot`);
  await page.getByRole('button', { name: 'Download' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Excel (XLSX)' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
});

test('pivot: year-over-year comparison and flip', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto(`${ORDERS}?view=pivot`);
  await page.getByLabel('Compare').selectOption('yoy');
  const from = new Date();
  await page
    .getByLabel('From')
    .fill(`${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-01`);
  const acme = page.getByRole('row', { name: /Acme Trading/ });
  await expect(acme.getByRole('button', { name: /^20,000\+100\.0%$/ }).first()).toBeVisible(); // 20 000 vs 10 000 last year
  await page.getByRole('button', { name: 'Flip axes' }).click();
  await expect(page.getByRole('columnheader', { name: 'Acme Trading' })).toBeVisible();
});

test('graph, calendar, gantt and cohort render the orders', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto(`${ORDERS}?view=graph`);
  await expect(page.getByRole('figure').locator('svg').first()).toBeVisible();
  await expect(page.locator('table.sr-only')).toContainText('50,000'); // this month's spend, for screen readers

  await page.goto(`${ORDERS}?view=calendar`);
  await expect(
    page
      .getByRole('table', {
        name: /October|November|December|January|February|March|April|May|June|July|August|September/,
      })
      .getByRole('button', { name: 'PO-R-003' })
      .first(),
  ).toBeVisible();
  await page
    .getByRole('table', {
      name: /October|November|December|January|February|March|April|May|June|July|August|September/,
    })
    .getByRole('button', { name: 'PO-R-003' })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'PO-R-003' })).toBeVisible();

  await page.goto(`${ORDERS}?view=gantt`);
  await expect(page.getByRole('button', { name: /PO-R-001 · 50%/ })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Bengal Steel' }).getByRole('button', { name: /PO-R-003/ }),
  ).toBeVisible();

  await page.goto(`${ORDERS}?view=cohort`);
  await expect(page.getByRole('table')).toContainText('Period 0');
  await expect(page.getByRole('table').getByRole('row')).not.toHaveCount(1);
});

test('map lists located contacts; hierarchy opens a company to its people', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto(`${CONTACTS}?view=map`);
  const locations = page
    .getByRole('region', { name: 'Locations' })
    .or(page.getByRole('heading', { name: 'Locations' }).locator('..'));
  await expect(locations.getByRole('button', { name: 'Acme Trading' })).toBeVisible();
  await expect(locations.getByRole('button', { name: 'Rafiq Ahmed' })).toHaveCount(0); // no coordinates

  await page.goto(`${CONTACTS}?view=hierarchy`);
  const tree = page.getByRole('tree');
  const acme = tree.getByRole('treeitem', { name: /Acme Trading/ });
  await expect(acme).toHaveAttribute('aria-expanded', 'false');
  await acme.focus();
  await page.keyboard.press('ArrowRight');
  await expect(acme).toHaveAttribute('aria-expanded', 'true');
  await expect(tree.getByRole('treeitem', { name: /Karim/ })).toBeVisible();
});

test('spreadsheet: formulas and live REPORT() totals', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/reports');
  await expect(page).toHaveURL(/reporting\.action_dashboards/);
  await page
    .getByRole('navigation', { name: 'Main menu' })
    .getByRole('link', { name: 'Spreadsheets' })
    .click();
  await page.getByLabel('Name').fill('Spend check');
  await page.getByRole('button', { name: 'New spreadsheet' }).click();
  const grid = page.getByRole('table', { name: 'Spend check' });
  const type = async (ref: string, text: string) => {
    await grid.getByRole('cell', { name: ref, exact: true }).dblclick();
    await page.getByLabel(`Formula ${ref}`).fill(text);
    await page.keyboard.press('Enter');
  };
  // The seeded report orders only (other specs add orders): a domain as JSON in the third argument.
  const seeded = '"{\\"name\\":{\\"like\\":\\"PO-R-%\\"}}"';
  await type('A1', `=REPORT("purchase.order", "sum:amountTotal", ${seeded})`);
  await type('A2', `=REPORT("purchase.order", "count", ${seeded})`);
  await type('A3', '=A1/A2');
  await expect(grid.getByRole('cell', { name: 'A1', exact: true })).toHaveText('60,000');
  await expect(grid.getByRole('cell', { name: 'A3', exact: true })).toHaveText('15,000');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('dashboard: built without code, KPI and chart cards, saved', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/reports');
  await page.getByLabel('Name').fill('Purchasing');
  await page.getByRole('button', { name: 'New dashboard' }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Add a card' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title').fill('Total spend');
  await dialog.getByLabel('Model').fill('purchase.order');
  await dialog.getByLabel(/Measure/).fill('sum:amountTotal');
  await dialog.getByLabel(/Filter/).fill('{"name":{"like":"PO-R-%"}}');
  await dialog.getByRole('button', { name: 'Add a card' }).click();
  const card = page.getByRole('region', { name: 'Total spend' });
  await expect(card).toContainText('60,000');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible(); // saved
  await page.reload();
  await page.getByRole('button', { name: 'Purchasing' }).click();
  await expect(page.getByRole('region', { name: 'Total spend' })).toContainText('60,000');
});
