/**
 * The view renderers on real data: list (order, search facets, filters, group-by, totals, inline edit, URL state),
 * form (field security, transitions per permission, onchange-free save, read-only state), kanban (drag a card to
 * the next state: the transition runs on the server).
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

const CONTACTS = '/contacts/a/contacts.action_partners';

test('list: rows, order, search facet, filters, group-by; state in the URL', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto(CONTACTS);
  const rows = page.getByRole('main').getByRole('row');
  await expect(rows.nth(1)).toContainText('Acme Trading');
  await expect(page.getByRole('columnheader', { name: 'Credit Limit' })).toBeVisible(); // managers see it
  await expect(
    page.getByRole('term').filter({ hasText: 'Total Credit Limit' }).locator('..'),
  ).toContainText('750,000');

  await page.getByRole('button', { name: 'Name' }).click(); // toggles to descending
  await expect(page.getByRole('columnheader', { name: 'Name' })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
  await expect(rows.nth(1)).toContainText('Sumaiya Khan');

  const search = page.getByRole('combobox', { name: 'Search…' });
  await search.fill('dhaka');
  await page.getByRole('option', { name: 'Search City for: dhaka' }).click();
  await expect(rows).toHaveCount(5); // header + Acme, Rafiq and Acme's two contacts
  await expect(page).toHaveURL(/q=/);

  await page.getByRole('button', { name: 'Filters' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Companies' }).click();
  await page.keyboard.press('Escape');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('Acme Trading');

  // A deep link restores the search.
  await page.reload();
  await expect(rows).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear' }).click();

  await page.getByRole('button', { name: 'Group by' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'City' }).click();
  await page.keyboard.press('Escape');
  const dhaka = page.getByRole('button', { name: /Dhaka \(4\)/ });
  await expect(dhaka).toBeVisible();
  await dhaka.click();
  await expect(dhaka).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('cell', { name: 'Rafiq Ahmed' })).toBeVisible();
});

test('list: inline edit of an inline-editable column saves with compare-and-set', async ({
  page,
}) => {
  await signIn(page, 'rahim');
  await page.goto(CONTACTS);
  await expect(page.getByRole('columnheader', { name: 'Credit Limit' })).toHaveCount(0); // managers only
  const row = page.getByRole('row', { name: /Sumaiya Khan/ });
  await row.getByText('Sylhet').click();
  const input = row.getByRole('textbox');
  await input.fill('Rajshahi');
  await input.press('Enter');
  await expect(row.getByText('Rajshahi')).toBeVisible();
});

test('form: create, edit, transitions the user may run; locked when lost', async ({ page }) => {
  await signIn(page, 'rahim');
  await page.goto(CONTACTS);
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByLabel('Name').fill('Nusrat Jahan');
  await page.getByLabel('Email').fill('nusrat@example.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/contacts\.action_partners\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Nusrat Jahan' })).toBeVisible();
  // Requesters may qualify, not mark lost (needs contacts.mark_lost): the button is not there.
  await expect(page.getByRole('button', { name: 'Qualify' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark lost' })).toHaveCount(0);
  await expect(page.getByLabel('Credit Limit')).toHaveCount(0);
  await page.getByRole('button', { name: 'Qualify' }).click();
  // The state chip names the current stage; its workflow shows it as the current step.
  await page.getByRole('button', { name: 'Stage: Customer' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Customer' })).toHaveAttribute(
    'aria-current',
    'step',
  );
  await page.keyboard.press('Escape'); // closes the workflow, stays on the record
  await expect(page.getByRole('heading', { name: 'Nusrat Jahan' })).toBeVisible();

  // The manager marks it lost (with confirmation): the form becomes read-only.
  const url = page.url();
  await page.getByRole('button', { name: 'Rahim Uddin' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await signIn(page, 'dina');
  await page.goto(url);
  await page.getByRole('button', { name: 'Mark lost' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByRole('button', { name: 'Stage: Lost' })).toBeVisible();
  await expect(page.getByText('Read-only')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveCount(0);
});

test('kanban: dragging a card to the next column runs the transition', async ({ page }) => {
  await signIn(page, 'rahim');
  await page.goto(`${CONTACTS}?view=kanban`);
  const leads = page.getByRole('region', { name: 'Lead' });
  const customers = page.getByRole('region', { name: 'Customer' });
  await expect(leads.getByRole('button', { name: 'Bengal Steel', exact: true })).toBeVisible();
  const handle = leads.getByRole('button', { name: 'Move Bengal Steel' });
  const target = await customers.boundingBox();
  const start = await handle.boundingBox();
  if (target === null || start === null) throw new Error('layout');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 20, start.y + 10, { steps: 5 });
  await page.mouse.move(target.x + target.width / 2, target.y + 60, { steps: 15 });
  await page.mouse.up();
  await expect(customers.getByRole('button', { name: 'Bengal Steel', exact: true })).toBeVisible();
  // Lost needs a permission rahim lacks: the server refuses, the card stays.
  const lost = await page.getByRole('region', { name: 'Lost' }).boundingBox();
  const again = await customers.getByRole('button', { name: 'Move Bengal Steel' }).boundingBox();
  if (lost === null || again === null) throw new Error('layout');
  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
  await page.mouse.down();
  await page.mouse.move(again.x + 20, again.y + 10, { steps: 5 });
  await page.mouse.move(lost.x + lost.width / 2, lost.y + 60, { steps: 15 });
  await page.mouse.up();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(customers.getByRole('button', { name: 'Bengal Steel', exact: true })).toBeVisible();
});
