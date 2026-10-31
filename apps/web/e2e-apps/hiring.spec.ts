/**
 * Hiring end to end (RFC 0021): Dina opens a position for one accountant and adds an applicant; Rahim, an
 * interviewer, sees the applicant but no Hire button and no expected salary; Dina hires them — the applicant is
 * hired and the filled opening closes itself.
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

async function pick(page: Page, field: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: field }).click();
  await page.getByRole('option', { name: option }).click();
}

test('a hiring manager hires an applicant; the filled opening closes', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina'); // hiring manager
  await page.goto('/hiring/a/hiring.action_openings/new');
  await page.getByRole('textbox', { name: 'Opening', exact: true }).fill('E2E Cashier');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/hiring\.action_openings\/\d+$/);
  const opening = page.url().replace(/^https?:\/\/[^/]+/, '');

  await page.goto('/hiring/a/hiring.action_applicants/new');
  await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('Shila Akter');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('shila@example.test');
  await pick(page, 'Opening', 'E2E Cashier');
  await page.getByRole('textbox', { name: 'Expected salary' }).fill('35000');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/hiring\.action_applicants\/\d+$/);
  const applicant = page.url().replace(/^https?:\/\/[^/]+/, '');

  const context = await browser.newContext();
  const rahim = await context.newPage();
  await signIn(rahim, 'rahim'); // interviewer
  await rahim.goto(applicant);
  await expect(rahim.getByRole('heading', { name: 'Shila Akter' })).toBeVisible();
  await expect(rahim.getByRole('button', { name: 'Hire' })).toHaveCount(0);
  await expect(rahim.getByText('35,000')).toHaveCount(0); // salaries: hiring managers only
  await context.close();

  await page.getByRole('button', { name: 'Hire', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('employee in Workforce');
  await dialog.getByRole('button', { name: 'Hire', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Hire', exact: true })).toHaveCount(0);
  await expect(page.getByText('Hired').first()).toBeVisible();

  await page.goto(opening);
  await expect(page.getByRole('button', { name: /^State: Closed/ })).toBeVisible();
});

test('the Hiring overview (RFC 0022 step 2)', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/hiring/a/recruitment.action_overview');
  await expect(page.getByRole('heading', { name: 'Hiring · Overview' })).toBeVisible();
  for (const title of ['Open openings', 'People to hire', 'Applicants by stage'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
