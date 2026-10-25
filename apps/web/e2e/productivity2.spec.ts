/**
 * Everyday speed, part 2 (RFC 0010 Phase A): list selection with bulk archive and Undo, a deferred delete undone
 * in time, export to CSV, the column chooser and density, kanban column counts and folded empty columns, the home
 * page (greeting, attention, recent, apps), the empty state, and the installable manifest.
 */
import { expect, test } from '@playwright/test';
import { openApp, signIn } from './support.js';

const CONTACTS = '/contacts/a/contacts.action_partners';

test('select rows: archive with Undo, a delete undone before it runs', async ({ page }) => {
  await signIn(page, 'dina'); // contacts manager: may archive and delete
  await page.goto(CONTACTS);
  await expect(page.getByText('6 records')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select Sumaiya Khan' }).click();
  await page.getByRole('checkbox', { name: 'Select Rafiq Ahmed' }).click();
  const toolbar = page.getByRole('toolbar', { name: '2 selected' });
  await expect(toolbar).toBeVisible();

  await toolbar.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Archive: 2 done' })).toBeVisible();
  await expect(page.getByText('4 records')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Restored' })).toBeVisible();
  await expect(page.getByText('6 records')).toBeVisible();

  await page.getByRole('checkbox', { name: 'Select Nadia (Acme accounts)' }).click();
  await page
    .getByRole('toolbar', { name: '1 selected' })
    .getByRole('button', { name: 'Delete' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Delete 1 record?' });
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('cell', { name: 'Nadia (Acme accounts)', exact: true })).toHaveCount(0); // hidden at once
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('cell', { name: 'Nadia (Acme accounts)', exact: true })).toBeVisible();
  await expect(page.getByText('6 records')).toBeVisible();
});

test('export downloads a CSV of the current search; columns and density are remembered', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto(CONTACTS);
  await page.getByRole('button', { name: 'Export' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'CSV (all columns)' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('res.partner.csv');

  await page.getByRole('button', { name: 'Columns' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Email' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('columnheader', { name: 'Email' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Density' }).click();
  await page.reload();
  await expect(page.getByRole('columnheader', { name: 'Email' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Density' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Restore for the other tests.
  await page.getByRole('button', { name: 'Columns' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Email' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Density' }).click();
  await expect(page.getByRole('columnheader', { name: 'Email' })).toBeVisible();
});

test('kanban: counts per column, empty columns folded until opened', async ({ page }) => {
  await signIn(page, 'maria');
  await page.goto('/purchase/a/purchase.action_orders?view=kanban');
  const draft = page.getByRole('region', { name: 'Draft' });
  await expect(draft.getByRole('heading')).toContainText('4');
  const folded = page.getByRole('button', { name: /Show Approved \(0\)/ });
  await expect(folded).toBeVisible();
  await folded.click();
  await expect(page.getByRole('region', { name: 'Approved' }).getByRole('heading')).toContainText(
    'Approved',
  );
});

test('the home page: greeting, attention, recent records and tinted apps', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto(CONTACTS);
  await page.getByRole('row').nth(1).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Acme Trading');
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    /Good (morning|afternoon|evening), Dina/,
  );
  await expect(page.getByRole('heading', { name: 'Needs your attention' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Acme Trading/ })).toBeVisible(); // recently opened
  await expect(page.getByRole('link', { name: /Contacts/ })).toBeVisible();
  await page.getByRole('button', { name: 'Search records, menus and commands…' }).click();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
});

test('an empty search shows an empty state; the app is installable', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto(CONTACTS);
  const search = page.getByRole('combobox', { name: 'Search…' });
  await search.fill('zzzz-no-such-contact');
  await page.getByRole('option', { name: 'Search Name for: zzzz-no-such-contact' }).click();
  await expect(page.getByText('No record matches the current search.')).toBeVisible();
  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  expect((await manifest.json()).display).toBe('standalone');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
  await openApp(page, 'Contacts').catch(() => undefined);
});
