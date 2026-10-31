/**
 * Workforce end to end (RFC 0021): HR adds Rahim as an employee; Rahim asks for a week's leave — the form counts the
 * working days by the company's week — and submits it; HR approves it. Rahim does not see the personal details.
 */
import { totp } from '@kosh/server';
import { expect, type Page, test } from '@playwright/test';

const PASSWORD = 'correct horse battery';

async function signIn(page: Page, login: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (login === 'admin') {
    await page.getByLabel('Authentication code').fill(totp('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'));
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
}

/** The Sunday at least a week from now and the Saturday after it, as ISO dates. */
function nextWeek(): [string, string] {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7 + ((7 - d.getUTCDay()) % 7));
  const end = new Date(d.getTime() + 6 * 86_400_000);
  return [d.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

async function pick(page: Page, field: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: field }).click();
  await page.getByRole('option', { name: option }).click();
}

test('an employee asks for leave counted in working days; HR approves it', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina'); // HR manager
  await page.goto('/workforce/a/workforce.action_employees/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Rahim Uddin');
  await pick(page, 'User', 'Rahim Uddin');
  await page.getByRole('textbox', { name: 'National ID' }).fill('1990123456789');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/workforce\.action_employees\/\d+$/);

  const context = await browser.newContext();
  const rahim = await context.newPage();
  await signIn(rahim, 'rahim');
  await rahim.goto(page.url().replace(/^https?:\/\/[^/]+/, ''));
  await expect(rahim.getByRole('heading', { name: 'Rahim Uddin' })).toBeVisible();
  await expect(rahim.getByText('1990123456789')).toHaveCount(0); // personal: HR only

  const [from, to] = nextWeek();
  await rahim.goto('/workforce/a/workforce.action_leaves/new');
  await pick(rahim, 'Employee', 'Rahim Uddin');
  await pick(rahim, 'Type', 'Casual leave');
  const start = rahim.getByRole('textbox', { name: 'From', exact: true });
  await start.fill(from);
  await start.blur();
  const end = rahim.getByRole('textbox', { name: 'To', exact: true });
  await end.fill(to);
  await end.blur();
  await expect(rahim.getByRole('textbox', { name: 'Working days' })).toHaveValue('5'); // Sunday–Thursday
  await rahim.getByRole('button', { name: 'Save' }).click();
  await expect(rahim).toHaveURL(/workforce\.action_leaves\/\d+$/);
  await rahim.getByRole('button', { name: 'Submit' }).click();
  await expect(rahim.getByRole('button', { name: /^State: Waiting/ })).toBeVisible();
  const leave = rahim.url().replace(/^https?:\/\/[^/]+/, '');
  await context.close();

  await page.goto(leave);
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('button', { name: /^State: Approved/ })).toBeVisible();
});

test('the Workforce overview (RFC 0022 step 2)', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/workforce/a/hr.action_overview');
  await expect(page.getByRole('heading', { name: 'Workforce · Overview' })).toBeVisible();
  for (const title of ['Employees', 'Leave waiting approval', 'By department'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
