/**
 * Projects end to end (RFC 0008 step 6) on the business apps' catalogue: a user creates a project and a task from
 * their forms and sees the task on the board under its stage; moving the task to Done from its form closes it;
 * the manager logs a timesheet on the task, and the hours show on the task and in the timesheet list.
 */
import { totp } from '@kosh/server';
import { expect, type Page, test } from '@playwright/test';

const PASSWORD = 'correct horse battery';
const ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

async function signIn(page: Page, login: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (login === 'admin') {
    await page.getByLabel('Authentication code').fill(totp(ADMIN_TOTP_SECRET));
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
}

test('a project and a task from their forms; the board shows the task under its stage; Done closes it', async ({
  page,
}) => {
  await signIn(page, 'rahim');
  await page.goto('/projects/a/projects.action_projects');
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByLabel('Name').fill('Bridge works');
  await page.getByRole('combobox', { name: 'Customer' }).click();
  await page.getByRole('option', { name: 'Bengal Steel' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Bridge works' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Project manager' })).toHaveText('Rahim Uddin'); // the creator

  await page.goto('/projects/a/projects.action_tasks/new');
  await page.getByLabel('Title').fill('Survey the site');
  await page.getByRole('combobox', { name: 'Project' }).click();
  await page.getByRole('option', { name: 'Bridge works' }).click();
  await page.getByRole('combobox', { name: 'Stage' }).click();
  await page.getByRole('option', { name: 'New' }).click();
  await page.getByLabel('Planned hours').fill('8');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Survey the site' })).toBeVisible();
  await expect(page.getByText('Bengal Steel')).toBeVisible(); // the project's customer, from the onchange

  await page.goto('/projects/a/projects.action_tasks?view=kanban');
  const column = page.getByRole('region', { name: 'New' });
  await expect(column.getByRole('button', { name: 'Survey the site', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Done' }).getByRole('heading')).toContainText('0'); // empty, shown

  await column.getByRole('button', { name: 'Survey the site', exact: true }).click();
  await page.getByRole('combobox', { name: 'Stage' }).click();
  await page.getByRole('option', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await page.goto('/projects/a/projects.action_tasks?view=list');
  await expect(page.getByRole('row', { name: /Survey the site/ })).toContainText('Done');
  await page.goto('/projects/a/projects.action_projects');
  await expect(page.getByRole('row', { name: /Bridge works/ })).toContainText('0'); // no open task
});

test('the manager logs a timesheet; the hours show on the task and in the list', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/projects/a/projects.action_timesheets/new');
  await page.getByRole('combobox', { name: 'Task' }).click();
  await page.getByRole('option', { name: 'Survey the site' }).click();
  await page.getByLabel('Hours').fill('2.5');
  await page.getByLabel('Description').fill('Site visit');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await expect(page.getByText('Bridge works')).toBeVisible(); // the project follows the task

  await page.goto('/projects/a/projects.action_timesheets?view=list');
  await expect(page.getByRole('row', { name: /Site visit/ })).toContainText('2.5');
  await page.goto('/projects/a/projects.action_tasks?view=list');
  await expect(page.getByRole('row', { name: /Survey the site/ })).toContainText('2.5');
});
