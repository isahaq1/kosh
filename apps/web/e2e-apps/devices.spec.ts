/**
 * Attendance machines on screen (RFC 0037 §2): a machine that knocks unregistered is listed as waiting for
 * approval and is refused; a manager names it and makes it active; its next punch arrives by itself and is listed
 * with what became of it. (The replay into check-ins and check-outs: the integration test with a simulated machine.)
 */
import { expect, type Page, test } from '@playwright/test';

const PASSWORD = 'correct horse battery';
/** The machine talks to the server itself (the apps' API server of playwright.config.ts), not through the back-office. */
const SERVER = 'http://127.0.0.1:3101';

async function signIn(page: Page, login: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
}

test('a machine knocks, a manager approves it, its punch arrives', async ({ page, request }) => {
  const serial = `E2E${Date.now()}`;
  const punch = () =>
    request.post(`${SERVER}/iclock/cdata?SN=${serial}&table=ATTLOG&Stamp=1`, {
      headers: { 'content-type': 'text/plain' },
      data: '987654\t2026-10-20 08:58:12\t0\t1\t0\t0\n',
    });
  expect((await request.get(`${SERVER}/iclock/cdata?SN=${serial}&options=all`)).status()).toBe(401);
  expect((await punch()).status()).toBe(401);

  await signIn(page, 'dina');
  await page.goto('/attendance/a/attendance.action_devices?view=list');
  await expect(page.getByRole('heading', { name: 'Devices', level: 1 })).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(serial) });
  await expect(row).toContainText('Waiting for approval', { timeout: 20_000 });
  await row.getByText(`Device ${serial}`).click();

  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill(`Gate ${serial}`);
  await name.blur();
  await page.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Active' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Discard' })).toHaveCount(0);
  await expect
    .poll(
      async () => (await request.get(`${SERVER}/iclock/cdata?SN=${serial}&options=all`)).status(),
      {
        timeout: 20_000,
      },
    )
    .toBe(200);

  const sent = await punch();
  expect(sent.status()).toBe(200);
  expect(await sent.text()).toBe('OK: 1');
  await page.goto('/attendance/a/attendance.action_device_punches?view=list');
  const received = page.getByRole('row', { name: /987654/ }).first();
  await expect(received).toContainText('Unknown person', { timeout: 20_000 });
  await expect(received).toContainText(`Gate ${serial}`);
});
