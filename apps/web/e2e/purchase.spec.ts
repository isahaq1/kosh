/**
 * Purchase with approvals end to end (RFC 0003 §6, RFC 0004 §6): the approval panel is a registered component
 * added to the order form by another module's view extension; a 750 000 order needs the department head, then the
 * finance director; the last approval approves the order.
 */
import { expect, type Page, test } from '@playwright/test';
import { signIn } from './support.js';

const ORDERS = '/purchase/a/purchase.action_orders';

async function signOut(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

test('a 750 000 order: two approval levels, then approved', async ({ page }) => {
  await signIn(page, 'rahim');
  await page.goto(ORDERS);
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByLabel('Name').fill('PO-2026-0042');
  await page.getByRole('combobox', { name: 'Vendor' }).click();
  await page.getByRole('option', { name: 'Bengal Steel' }).click();
  await page.getByLabel('Amount Total').fill('750000');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'PO-2026-0042' })).toBeVisible();
  await expect(page.getByText('Bengal Steel')).toBeVisible();

  await page.getByRole('button', { name: 'Submit' }).click();
  const panel = page.getByRole('region', { name: 'Approvals' });
  await expect(panel.getByRole('listitem')).toHaveText([
    /Department head.*pending/,
    /Finance director.*pending/,
  ]);
  await expect(panel.getByRole('button', { name: /Approve/ })).toHaveCount(0); // requesters do not approve
  await expect(page.getByText('Read-only')).toBeVisible();
  const url = page.url();
  await signOut(page, 'Rahim Uddin');

  await signIn(page, 'dina');
  await page.goto(url);
  await panel.getByLabel('Comment').fill('Within budget');
  await panel.getByRole('button', { name: 'Approve Department head' }).click();
  await expect(panel.getByRole('listitem').first()).toContainText('approved');
  await expect(panel.getByText('“Within budget”')).toBeVisible();
  await signOut(page, 'Dina Rahman');

  await signIn(page, 'maria');
  await page.goto(url);
  await panel.getByRole('button', { name: 'Approve Finance director' }).click();
  await expect(page.getByRole('list', { name: 'State' }).getByText('Approved')).toHaveAttribute(
    'aria-current',
    'step',
  );

  // The list shows it approved, with the total.
  await page.goto(ORDERS);
  await expect(page.getByRole('row', { name: /PO-2026-0042/ })).toContainText('Approved');
  await expect(page.getByRole('row', { name: /PO-2026-0042/ })).toContainText('750,000');
});
