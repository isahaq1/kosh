/**
 * Leave accruals end to end (RFC 0034 §2.5): an HR manager writes a plan for a leave type on screen — two days a
 * month —, the run writes the months that are over to the ledger, and the person's balance shows what they
 * earned; a formula that does not read is refused in the form. (Probation, caps, carry-over, expiry, leave
 * against the balance: the integration tests.)
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

test('a plan written on screen; the run fills the ledger; the balance shows it', async ({
  page,
}) => {
  await signIn(page, 'dina');
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const headers = { 'x-csrf-token': csrf ?? '' };
  const make = async (model: string, data: Record<string, unknown>): Promise<number> => {
    const made = await page.request.post(`/api/v1/models/${model}`, { headers, data });
    expect(made.status(), `${model}: ${await made.text()}`).toBe(201);
    return ((await made.json()) as { id: number }).id;
  };
  const stamp = Date.now();
  const person = `Accrual Tester ${stamp}`;
  const type = `Sabbatical ${stamp}`;
  // Someone who joined long ago, and a leave type of their own (the other specs' types keep their days per year).
  await make('hr.employee', { name: person, hireDate: '2024-01-01' });
  await make('hr.leave.type', { name: type });

  await page.goto('/workforce/a/workforce.action_accrual_plans/new');
  await page.getByLabel('Name').fill(`Two days a month ${stamp}`);
  await page.getByRole('combobox', { name: 'Leave type' }).click();
  await page.getByRole('option', { name: type }).click();
  // A formula that reads what a plan does not know is refused, in words.
  await page.getByRole('textbox', { name: 'Days a month' }).fill('WAGE / 30');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/The formula does not read/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Days a month' }).fill('2');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/workforce\.action_accrual_plans\/\d+$/);

  // The run: the months of this year that are over, two days each.
  const run = await page.request.post('/api/v1/leave-accruals/run', { headers });
  expect(run.status(), await run.text()).toBe(200);
  const months = new Date().getUTCMonth(); // January is 0: the months before this one
  expect(((await run.json()) as { lines: number }).lines).toBeGreaterThanOrEqual(months);
  // Twice: nothing more.
  const again = await page.request.post('/api/v1/leave-accruals/run', { headers });
  expect(((await again.json()) as { lines: number }).lines).toBe(0);

  await page.goto('/workforce/a/workforce.action_leave_balances?view=list');
  await expect(page.getByRole('heading', { name: 'Leave balances', level: 1 })).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(person) });
  await expect(row).toContainText(type);
  await expect(row).toContainText(String(months * 2));
  // The ledger behind it.
  await page.goto('/workforce/a/workforce.action_leave_ledger?view=list');
  await expect(page.getByRole('row', { name: new RegExp(person) }).first()).toContainText(
    'Accrued',
  );
});
