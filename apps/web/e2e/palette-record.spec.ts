/**
 * The palette on the open record (RFC 0033 §3.6) and the phone action bar (§3.7): a record's next step is run
 * from Ctrl+K without the mouse; on a phone-wide screen the next step sits in a bar at the bottom.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

const CONTACTS = '/contacts/a/contacts.action_partners';

test('the palette lists the open record’s next steps and runs one', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto(CONTACTS);
  await page.getByRole('row', { name: /Rafiq Ahmed/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Rafiq Ahmed');
  // The record's own buttons, whatever they are for its status, are the palette's first group.
  const first = page.locator('[data-kosh-form] [data-kosh-record-action]').first();
  const label = (await first.getAttribute('data-kosh-record-action')) ?? '';
  expect(label).not.toBe('');
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog');
  await expect(palette.getByText('This record')).toBeVisible();
  await expect(palette.getByRole('option', { name: new RegExp(label) }).first()).toBeVisible();
  await palette.getByRole('combobox').fill(label);
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  // The step ran: the record's buttons are no longer the same set.
  await expect(page.locator(`[data-kosh-form] [data-kosh-record-action="${label}"]`)).toHaveCount(
    0,
  );
});

test('on a phone the next step is in a bar at the bottom of the record', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signIn(page, 'dina');
  await page.goto(CONTACTS);
  await page.getByRole('row', { name: /Acme Trading/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Acme Trading');
  const bar = page.locator('[data-kosh-action-bar]');
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button').first()).toBeVisible();
  // It is at the bottom edge of the screen.
  const box = await bar.boundingBox();
  expect(box === null ? 0 : box.y + box.height).toBeGreaterThan(780);
});
