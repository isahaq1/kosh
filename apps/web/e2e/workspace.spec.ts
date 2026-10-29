/**
 * RFC 0018 step 4 end to end: a saved search becomes a tab above the list (All and the saved view, the current one
 * marked) and an entry of Today's saved views; selecting rows shows the floating bar at the bottom; Ctrl+click opens
 * a record in a new tab; Today names its date.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

const CONTACTS = '/contacts/a/contacts.action_partners';

test('saved views as tabs, the floating selection bar, a record in a new tab, Today', async ({
  page,
  context,
}) => {
  await signIn(page, 'dina');
  await page.goto(CONTACTS);
  await expect(page.getByText(/\d+ records/)).toBeVisible();
  const all = await page.getByText(/\d+ records/).textContent();

  // Save a search: it becomes a tab, marked as the current one.
  const search = page.getByRole('combobox', { name: 'Search…' });
  await search.fill('Acme');
  await page.getByRole('option', { name: 'Search Name for: Acme' }).click();
  await page.getByRole('button', { name: 'Favorites' }).click();
  await page.getByRole('menuitem', { name: 'Save current search' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save current search' });
  await dialog.getByLabel('Name').fill('Acme people');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const tabs = page.getByRole('navigation', { name: 'Saved views' });
  await expect(tabs.getByRole('button', { name: 'Acme people' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  const acme = await page.getByText(/\d+ records?/).textContent();
  expect(acme).not.toBe(all);

  // All shows everything again; the tab brings the search back.
  await tabs.getByRole('button', { name: 'All' }).click();
  await expect(tabs.getByRole('button', { name: 'All' })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText(/\d+ records/)).toHaveText(all ?? '');
  await tabs.getByRole('button', { name: 'Acme people' }).click();
  await expect(page.getByText(/\d+ records?/)).toHaveText(acme ?? '');

  // Selected rows: the bar floats at the bottom of the screen.
  await page.getByRole('checkbox', { name: 'Select Acme Trading' }).click();
  const bar = page.getByRole('toolbar', { name: '1 selected' });
  await expect(bar).toBeVisible();
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  await bar.getByRole('button', { name: 'Clear selection' }).click();
  await expect(bar).toHaveCount(0);

  // Ctrl+click: the record in a new tab, the list stays.
  const opened = context.waitForEvent('page');
  await page
    .getByRole('row', { name: /Acme Trading/ })
    .first()
    .click({ modifiers: ['Control'] });
  const tab = await opened;
  await expect(tab).toHaveURL(/\/contacts\/a\/contacts\.action_partners\/\d+$/);
  await expect(tab.getByRole('heading', { name: 'Acme Trading' })).toBeVisible();
  await tab.close();
  await expect(page).toHaveURL(/contacts\.action_partners(\?|$)/);

  // Today: the date, and the saved view one click away.
  await page.goto('/');
  await expect(page.getByText(/^Today, /)).toBeVisible();
  const saved = page.getByRole('region', { name: 'Your saved views' });
  await saved.getByRole('button', { name: 'Acme people' }).click();
  await expect(
    page.getByRole('navigation', { name: 'Saved views' }).getByRole('button', {
      name: 'Acme people',
    }),
  ).toHaveAttribute('aria-current', 'true');
});
