/**
 * Offline (RFC 0010 Phase B): the app opens without the network and shows the screens the user opened recently;
 * a save made offline is kept on the device and sent when the network is back; a record someone else changed
 * meanwhile is a conflict the user settles.
 */
import { expect, type Page, test } from '@playwright/test';
import { signIn } from './support.js';

const CONTACTS = '/contacts/a/contacts.action_partners';

/** The service worker controls the page (its first install is asynchronous). */
async function workerReady(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/sw.js');
    return registration?.active !== null && navigator.serviceWorker.controller !== null;
  });
}

/** The query cache on the device holds the given query key's first part (it is written at most once a second). */
async function persisted(page: Page, key: string): Promise<void> {
  await page.waitForFunction(
    (wanted) =>
      new Promise<boolean>((resolve) => {
        const request = indexedDB.open('kosh', 1);
        request.onerror = () => resolve(false);
        request.onsuccess = () => {
          const get = request.result.transaction('kv', 'readonly').objectStore('kv').get('queries');
          get.onerror = () => resolve(false);
          get.onsuccess = () => {
            const stored = get.result as
              | { uid: number; client: { clientState: { queries: { queryKey: unknown[] }[] } } }
              | undefined;
            resolve(
              stored?.client.clientState.queries.some((q) => q.queryKey[0] === wanted) ?? false,
            );
          };
        };
      }),
    key,
  );
}

test('the app opens offline with the screens opened recently', async ({ page, context }) => {
  await signIn(page, 'dina');
  await page.goto(CONTACTS);
  await page.getByRole('row', { name: /Bengal Steel/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Bengal Steel');
  await workerReady(page);
  await persisted(page, 'record');

  await context.setOffline(true);
  await page.reload(); // the shell from the service worker, the data from the device
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Bengal Steel');
  await expect(page.locator('[data-kosh-offline="offline"]')).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click(); // the list opened before: on the device too
  await expect(page.getByRole('row', { name: /Bengal Steel/ })).toBeVisible();
  await context.setOffline(false);
  await expect(page.locator('[data-kosh-offline]')).toHaveCount(0);
});

test('a save made offline is sent when back online; a conflict is settled by the user', async ({
  page,
  context,
}) => {
  await signIn(page, 'dina');
  await page.goto(CONTACTS);
  await page.getByRole('row', { name: /Bengal Steel/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Bengal Steel');
  const id = Number(/\/(\d+)$/.exec(page.url())?.[1]);
  const city = page.getByLabel('City');
  await expect(city).toHaveValue('Chattogram');

  // Offline: the save is kept on the device.
  await context.setOffline(true);
  await city.fill('Khulna');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved on this device' })).toBeVisible();
  await expect(page.locator('[data-kosh-offline="offline"]')).toHaveText('1');
  await expect(city).toHaveValue('Khulna');

  // Online: sent, and the server has it.
  await context.setOffline(false);
  await expect(page.getByRole('status').filter({ hasText: 'was sent' })).toBeVisible();
  await expect(page.locator('[data-kosh-offline]')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('City')).toHaveValue('Khulna');

  // Offline again; meanwhile the record changes on the server: the queued save is a conflict.
  await context.setOffline(true);
  await page.getByLabel('City').fill('Barishal');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('[data-kosh-offline="offline"]')).toHaveText('1');
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const patched = await page.request.patch(`/api/v1/models/res.partner/${id}`, {
    headers: { 'x-csrf-token': csrf ?? '' },
    data: { city: 'Cumilla' },
  });
  expect(patched.ok()).toBe(true);
  await context.setOffline(false);
  await expect(page.getByRole('status').filter({ hasText: 'could not be sent' })).toBeVisible();
  const cloud = page.locator('[data-kosh-offline="attention"]');
  await expect(cloud).toHaveText('1');
  await cloud.click();
  await expect(page.getByText('Someone else changed this record meanwhile')).toBeVisible();
  await page.getByRole('button', { name: 'Overwrite' }).click();
  await expect(page.locator('[data-kosh-offline]')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('City')).toHaveValue('Barishal');

  // Back to the fixture's value for the other tests.
  await page.getByLabel('City').fill('Chattogram');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();
});
