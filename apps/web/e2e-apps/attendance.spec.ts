/**
 * Attendance end to end (RFC 0024 §2.2): Dina sets Nadia's kiosk PIN on her employee form; at the gate kiosk Nadia
 * chooses her name and types the PIN on the pad and is welcomed; her phone page then shows her checked in.
 */
import { expect, type Page, test } from '@playwright/test';

const PASSWORD = 'correct horse battery';

async function signIn(page: Page, login: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
}

test('a kiosk PIN set by a manager, a check-in at the kiosk, seen on the phone', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina'); // Attendance and HR manager
  await page.goto('/workforce/a/workforce.action_employees');
  const search = page.getByRole('combobox', { name: 'Search…' });
  await search.fill('Nadia');
  await page.getByRole('option', { name: 'Search Name for: Nadia' }).click();
  await page.getByRole('row', { name: /Nadia Islam/ }).click();
  await expect(page.getByRole('heading', { name: 'Nadia Islam' })).toBeVisible();
  await page.getByRole('button', { name: 'Set the kiosk PIN' }).click();
  const dialog = page.getByRole('dialog', { name: 'Set the kiosk PIN' });
  await dialog.getByLabel('New PIN').fill('2468');
  await dialog.getByRole('button', { name: 'Save the PIN' }).click();
  await expect(page.getByText('PIN saved.')).toBeVisible();

  const gateContext = await browser.newContext();
  const gate = await gateContext.newPage();
  await signIn(gate, 'gate');
  await gate.goto('/attendance/a/attendance.action_kiosk');
  await gate.getByRole('button', { name: 'Nadia Islam' }).click();
  for (const key of ['2', '4', '6', '8'])
    await gate.getByRole('button', { name: key, exact: true }).click();
  await gate.getByRole('button', { name: 'Enter' }).click();
  await expect(gate.getByRole('status').filter({ hasText: 'Welcome' })).toContainText(
    'Welcome, Nadia Islam!',
  );
  await gateContext.close();

  const phoneContext = await browser.newContext();
  const phone = await phoneContext.newPage();
  await signIn(phone, 'nadia');
  await phone.goto('/attendance/a/attendance.action_check');
  await expect(phone.getByRole('status').filter({ hasText: 'Checked in' })).toContainText(
    'Checked in since',
  );
  await expect(phone.getByRole('button', { name: 'Check out' })).toBeVisible();
  await phoneContext.close();
});

test('the Attendance overview', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/attendance/a/attendance.action_overview');
  await expect(page.getByRole('heading', { name: 'Attendance · Overview' })).toBeVisible();
  for (const title of ['Days to review', 'Absences this month', 'Days by status'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
