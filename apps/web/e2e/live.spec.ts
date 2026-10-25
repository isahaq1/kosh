/**
 * Live screens (RFC 0010 Phase B): a list updates when a record changes without a reload; a form shows who else
 * has the record open and refetches another user's save; with unsaved changes it says so and offers a reload.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

const CONTACTS = '/contacts/a/contacts.action_partners';

test('a list updates by itself when a record changes', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto(CONTACTS);
  const row = page.getByRole('row', { name: /Sumaiya Khan/ });
  await expect(row).toContainText('Sylhet');
  const id = Number(
    (await page.evaluate(async () => {
      const res = await fetch('/api/v1/models/res.partner/names?q=Sumaiya');
      return ((await res.json()) as { items: { id: number }[] }).items[0]?.id;
    })) ?? 0,
  );
  expect(id).toBeGreaterThan(0);
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const patch = (city: string) =>
    page.request.patch(`/api/v1/models/res.partner/${id}`, {
      headers: { 'x-csrf-token': csrf ?? '' },
      data: { city },
    });
  expect((await patch('Rangpur')).ok()).toBe(true);
  await expect(row).toContainText('Rangpur'); // no reload, no click
  expect((await patch('Sylhet')).ok()).toBe(true);
  await expect(row).toContainText('Sylhet');
});

test('a form shows who else is here and follows their save; unsaved changes are protected', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina');
  await page.goto(CONTACTS);
  await page.getByRole('row', { name: /Bengal Steel/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Bengal Steel');
  const id = Number(/\/(\d+)$/.exec(page.url())?.[1]);

  const other = await browser.newContext();
  const rahim = await other.newPage();
  await signIn(rahim, 'rahim');
  await rahim.goto(`${CONTACTS}/${id}`);
  await expect(rahim.getByRole('heading', { level: 1 })).toContainText('Bengal Steel');
  // Dina sees Rahim; Rahim sees Dina.
  await expect(page.getByRole('list', { name: 'Also here: Rahim Uddin' })).toBeVisible();
  await expect(rahim.getByRole('list', { name: 'Also here: Dina Rahman' })).toBeVisible();

  // Rahim saves: Dina's form follows without a reload.
  await rahim.getByLabel('City').fill('Khulna');
  await rahim.getByRole('button', { name: 'Save' }).click();
  await expect(rahim.getByText('All changes saved')).toBeVisible();
  await expect(page.getByLabel('City')).toHaveValue('Khulna');

  // Dina has unsaved changes: the save is reported, not applied, until she reloads.
  await page.getByLabel('Phone').fill('01700000000');
  await rahim.getByLabel('City').fill('Chattogram');
  await rahim.getByRole('button', { name: 'Save' }).click();
  await expect(rahim.getByText('All changes saved')).toBeVisible();
  await expect(page.getByText('Someone else changed this record.')).toBeVisible();
  await expect(page.getByLabel('City')).toHaveValue('Khulna');
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByLabel('City')).toHaveValue('Chattogram');
  await expect(page.getByLabel('Phone')).toHaveValue('');

  // Rahim leaves: his chip goes.
  await rahim.goto(CONTACTS);
  await expect(page.getByRole('list', { name: 'Also here: Rahim Uddin' })).toHaveCount(0);
  await other.close();
});
