/**
 * Autosave (RFC 0033 §3.3): a saved contact saves a changed field by itself, says so and offers Undo; a field two
 * people changed shows both values and waits for the choice.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

const CONTACTS = '/contacts/a/contacts.action_partners';

test('a changed field saves by itself; Undo puts the old value back', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto(CONTACTS);
  await page.evaluate(() => localStorage.removeItem('kosh.autosave')); // the default: autosave is on
  await page.getByRole('row', { name: /Rafiq Ahmed/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Rafiq Ahmed');
  const id = Number(/\/(\d+)$/.exec(page.url())?.[1]);
  const city = async () =>
    page.evaluate(async (rid) => {
      const res = await fetch(`/api/v1/models/res.partner/${rid}?fields=city`);
      return ((await res.json()) as { city: string | null }).city;
    }, id);
  const before = await city();
  await page.getByLabel('City').fill('Barishal');
  // No Save pressed: it is saved after a pause, and the server has it.
  await expect(page.getByText('All changes saved')).toBeVisible();
  expect(await city()).toBe('Barishal');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByLabel('City')).toHaveValue(before ?? '');
  expect(await city()).toBe(before);
});

test("a field changed by two people shows both values; taking theirs keeps the server's", async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto(CONTACTS);
  await page.evaluate(() => localStorage.removeItem('kosh.autosave'));
  await page.getByRole('row', { name: /Rafiq Ahmed/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Rafiq Ahmed');
  const id = Number(/\/(\d+)$/.exec(page.url())?.[1]);
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  // Someone else saves the phone while Dina is typing another one: the live update is held back by her change.
  await page.getByLabel('Phone').pressSequentially('0171');
  const theirs = await page.request.patch(`/api/v1/models/res.partner/${id}`, {
    headers: { 'x-csrf-token': csrf ?? '' },
    data: { phone: '01999999999' },
  });
  expect(theirs.ok()).toBe(true);
  await expect(page.getByText('Someone else changed these fields too')).toBeVisible();
  await expect(page.getByText('Theirs: 01999999999')).toBeVisible();
  await page.getByRole('button', { name: 'Take theirs' }).click();
  await expect(page.getByLabel('Phone')).toHaveValue('01999999999');
  await expect(page.getByText('Someone else changed these fields too')).toHaveCount(0);
  // Put the phone back for the specs that follow.
  await page.request.patch(`/api/v1/models/res.partner/${id}`, {
    headers: { 'x-csrf-token': csrf ?? '' },
    data: { phone: null },
  });
});
