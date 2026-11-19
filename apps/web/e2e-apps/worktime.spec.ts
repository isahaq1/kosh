/**
 * Working time end to end (RFC 0034 §2.4): the company's calendar is there with its week of hours; a manager adds a
 * holiday that moves (an Eid) beside the yearly ones that came with the calendar; someone with the user role sees
 * the calendars and is offered nothing to create. (How time is counted: the engine's and the integration tests.)
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

test('the company’s calendar with its hours; a manager adds a holiday that moves', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/worktime/a/worktime.action_calendars?view=list');
  await expect(page.getByRole('heading', { name: 'Calendars', level: 1 })).toBeVisible();
  const standard = page.getByRole('row', { name: /Standard week/ });
  await expect(standard).toContainText('Asia/Dhaka');
  await standard.getByText('Standard week').click();
  // Its week: two lines a day, the gap between them is the lunch break.
  const hours = page.getByRole('table', { name: 'hours' });
  await expect(hours.getByRole('row', { name: /09:00 13:00/ })).toHaveCount(5);
  await expect(hours.getByRole('row', { name: /14:00 18:00/ })).toHaveCount(5);

  // The yearly holidays came with the calendar; an Eid is added for its year.
  await page.goto('/worktime/a/worktime.action_holidays?view=list');
  await expect(page.getByRole('row', { name: /Victory Day/ })).toBeVisible({ timeout: 20_000 });
  const name = `Eid-ul-Fitr ${Date.now()}`;
  await page.goto('/worktime/a/worktime.action_holidays/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  const from = page.getByRole('textbox', { name: 'From', exact: true });
  await from.fill('2027-03-09');
  await from.blur();
  const to = page.getByRole('textbox', { name: 'To', exact: true });
  await to.fill('2027-03-11');
  await to.blur();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/worktime\.action_holidays\/\d+$/);
  await page.goto('/worktime/a/worktime.action_holidays?view=list');
  await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible({ timeout: 20_000 });
});

test('a user sees the calendars and cannot add one', async ({ page }) => {
  await signIn(page, 'rahim');
  await page.goto('/worktime/a/worktime.action_calendars?view=list');
  await expect(page.getByRole('row', { name: /Standard week/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'New', exact: true })).toHaveCount(0);
});
