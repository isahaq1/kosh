/**
 * Everyday speed (RFC 0010 Phase A): the command palette (records, menus, recent, commands), keyboard shortcuts
 * and their cheat sheet, breadcrumbs and the record pager, the save state with Ctrl+S, the leave guard, toasts
 * after an action, and axe on the palette.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test('the palette finds records and menus, and remembers recent records', async ({ page }) => {
  await signIn(page, 'dina');
  await page.keyboard.press(`${mod}+k`);
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('Acme Trad');
  await expect(palette.getByRole('option', { name: /Acme Trading/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Acme Trading', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'You are here' })).toContainText('Contacts');

  // Menus by name, then recent records first in an empty palette.
  await page.keyboard.press(`${mod}+k`);
  await page.keyboard.type('purchase ord');
  await expect(palette.getByRole('option', { name: /Purchase.*orders?/i }).first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Purchase orders/i);
  await page.keyboard.press(`${mod}+k`);
  await expect(palette.getByRole('option', { name: /Acme Trading/ })).toBeVisible();
  const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(
    results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
  ).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

test('shortcuts: / searches, N creates, Esc goes back, ? lists them', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/contacts/a/contacts.action_partners');
  await expect(page.getByRole('row').nth(1)).toBeVisible();
  await page.keyboard.press('/');
  await expect(page.locator('[data-kosh-search]')).toBeFocused();
  await page.locator('[data-kosh-search]').blur();
  await page.keyboard.press('n');
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole('heading', { name: 'New', level: 1 })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('row').nth(1)).toBeVisible();
  await page.keyboard.press('Shift+?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
});

test('the record pager walks the list; Ctrl+S saves; leaving unsaved asks first', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/contacts/a/contacts.action_partners');
  await page.getByRole('row').nth(1).click();
  await expect(page.getByText('1 / 6')).toBeVisible();
  const first = await page.getByRole('heading', { level: 1 }).textContent();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.getByText('2 / 6')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(first ?? '');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.getByText('1 / 6')).toBeVisible();

  const city = page.getByLabel('City');
  await city.fill('Narayanganj');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  // Leaving asks; staying keeps the edit.
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(city).toHaveValue('Narayanganj');
  await page.keyboard.press(`${mod}+s`);
  await expect(page.getByText('All changes saved')).toBeVisible();
  await city.fill('Dhaka');
  await page.keyboard.press(`${mod}+s`);
  await expect(page.getByText('All changes saved')).toBeVisible();
});

test('an action confirms with a toast', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/contacts/a/contacts.action_partners');
  await page.getByRole('row', { name: /Sumaiya Khan/ }).click();
  await page.getByRole('button', { name: 'Qualify' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Qualify: done' })).toBeVisible();
});
