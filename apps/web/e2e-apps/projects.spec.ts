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
  await expect(page).toHaveURL(/projects\.action_projects\/\d+$/); // saved, not only typed
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
  await expect(page).toHaveURL(/projects\.action_tasks\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Survey the site' })).toBeVisible();
  await expect(page.getByText('Bengal Steel')).toBeVisible(); // the project's customer, from the onchange

  await page.goto('/projects/a/projects.action_tasks?view=kanban');
  const column = page.getByRole('region', { name: 'New' });
  await expect(column.getByRole('button', { name: 'Survey the site', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Done' }).getByRole('heading')).toContainText('0'); // empty, shown

  await column.getByRole('button', { name: 'Survey the site', exact: true }).click();
  await page.getByRole('combobox', { name: 'Stage' }).click();
  await page.getByRole('option', { name: 'Done' }).click();
  // Wait for the server's answer: Save is also disabled while the save is still on its way.
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/v1/models/project.task/') && r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'Save' }).click();
  expect((await saved).status()).toBeLessThan(300);
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

test('the Projects overview and the projects timeline (RFC 0022 step 2)', async ({ page }) => {
  await signIn(page, 'rahim');
  await page.goto('/projects/a/project.action_overview');
  await expect(page.getByRole('heading', { name: 'Projects · Overview' })).toBeVisible();
  for (const title of ['Open tasks', 'Hours this month', 'Tasks by stage'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
  await page.goto('/projects/a/projects.action_projects?view=gantt');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a phase and a work package of a project; the project shows its structure as a tree (RFC 0026 step 1)', async ({
  page,
}) => {
  await signIn(page, 'rahim');
  await page.goto('/projects/a/projects.action_phases/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Civil works');
  await page.getByRole('combobox', { name: 'Project', exact: true }).click();
  await page.getByRole('option', { name: 'Bridge works' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/projects\.action_phases\/\d+$/);

  await page.goto('/projects/a/projects.action_work_packages/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Piers');
  await page.getByRole('combobox', { name: 'Project', exact: true }).click();
  await page.getByRole('option', { name: 'Bridge works' }).click();
  await page.getByRole('combobox', { name: 'Phase', exact: true }).click();
  await page.getByRole('option', { name: 'Civil works' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/projects\.action_work_packages\/\d+$/);

  await page.goto('/projects/a/projects.action_projects');
  await page
    .getByRole('row', { name: /Bridge works/ })
    .first()
    .click();
  const tree = page.getByRole('region', { name: 'Structure' });
  await expect(tree.getByRole('link', { name: 'Civil works' })).toBeVisible();
  await expect(tree.getByRole('link', { name: 'Piers' })).toBeVisible();
  await expect(tree.getByRole('progressbar', { name: 'Progress of Piers' })).toBeVisible();
});

test('a plan written, approved by its sponsor in the Approvals inbox, and started as a project with its baseline (RFC 0026 step 2)', async ({
  page,
  browser,
}) => {
  await signIn(page, 'rahim');
  await page.goto('/projects/a/projects.action_plans/new');
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Feed mill upgrade');
  await page.getByRole('combobox', { name: 'Sponsor', exact: true }).click();
  await page.getByRole('option', { name: 'Dina Rahman' }).click();
  await page.getByRole('textbox', { name: 'Planned start', exact: true }).fill('2027-03-01');
  await page.getByRole('textbox', { name: 'Planned end', exact: true }).fill('2027-06-30');
  await page.getByRole('textbox', { name: 'Estimated budget', exact: true }).fill('400000');
  await page.getByRole('textbox', { name: 'Objectives', exact: true }).fill('Twice the feed a day');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/projects\.action_plans\/\d+$/);
  const url = page.url();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toHaveCount(0);

  const context = await browser.newContext();
  const dina = await context.newPage();
  await signIn(dina, 'dina');
  await dina.goto('/approvals/a/approvals.action_inbox');
  const card = dina.getByRole('listitem').filter({ hasText: 'Feed mill upgrade' }).first();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(dina.getByText('Approved.')).toBeVisible();
  await context.close();

  await page.goto(url);
  await page.getByRole('button', { name: 'Start the project' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByRole('button', { name: 'Start the project' })).toHaveCount(0);
  await page.goto('/projects/a/projects.action_projects');
  await page
    .getByRole('row', { name: /Feed mill upgrade/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Feed mill upgrade' })).toBeVisible();
  const baseline = page.getByRole('group', { name: 'Baseline' });
  await expect(baseline).toContainText(/30.Jun.2027/); // read-only: managers alone move it
});

test('a team member added at 120 % in total across projects shows over-allocated, in red on the Workload (RFC 0026 step 3)', async ({
  page,
}) => {
  await signIn(page, 'dina');
  for (const [project, allocation] of [
    ['Bridge works', '70'],
    ['Feed mill upgrade', '50'],
  ] as const) {
    await page.goto('/projects/a/projects.action_members/new');
    await page.getByRole('combobox', { name: 'Project', exact: true }).click();
    await page.getByRole('option', { name: project }).click();
    await page.getByRole('combobox', { name: 'Person', exact: true }).click();
    await page.getByRole('option', { name: 'Rahim Uddin' }).click();
    await page.getByRole('textbox', { name: 'Allocation %', exact: true }).fill(allocation);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page).toHaveURL(/projects\.action_members\/\d+$/);
  }
  await page.goto('/projects/a/projects.action_members');
  await expect(page.getByRole('row', { name: /Feed mill upgrade/ })).toContainText('Yes');

  await page.goto('/projects/a/projects.action_workload');
  await expect(page.getByRole('heading', { name: 'Workload' })).toBeVisible();
  await expect(page.getByText('One person is over-allocated in these weeks.')).toBeVisible();
  const rahim = page.getByRole('row', { name: /Rahim Uddin/ });
  await expect(rahim.getByRole('cell').first()).toHaveText('120%');
});

test('money and health on a project (RFC 0026 step 4): a manager refreshes the figures and sets the health with a reason; a user sees no money', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina');
  await page.goto('/projects/a/projects.action_projects');
  await page
    .getByRole('row', { name: /Bridge works/ })
    .first()
    .click();
  await expect(page.getByRole('group', { name: 'Money' })).toBeVisible();
  const refreshed = page.waitForResponse(
    (r) => r.url().includes('/api/v1/projects/refresh') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Refresh the figures' }).click();
  expect((await refreshed).status()).toBe(200);
  const health = page.getByRole('group', { name: 'Health', exact: true });
  await expect(health).toContainText(/On track|At risk|Off track/);

  const context = await browser.newContext();
  const rahim = await context.newPage();
  await signIn(rahim, 'rahim');
  await rahim.goto('/projects/a/projects.action_projects');
  await rahim
    .getByRole('row', { name: /Bridge works/ })
    .first()
    .click();
  await expect(rahim.getByRole('heading', { name: 'Bridge works' })).toBeVisible();
  await expect(rahim.getByRole('group', { name: 'Health', exact: true })).toBeVisible();
  await expect(rahim.getByRole('button', { name: 'Refresh the figures' })).toHaveCount(0);
  await expect(rahim.getByText('Left in the budget')).toHaveCount(0);
  await context.close();
});

test('control and schedule (RFC 0026 step 5): a risk scored critical; the project shows its schedule with the critical path', async ({
  page,
}) => {
  await signIn(page, 'rahim');
  await page.goto('/projects/a/projects.action_risks/new');
  await page.getByRole('textbox', { name: 'Risk', exact: true }).fill('Monsoon floods the site');
  await page.getByRole('combobox', { name: 'Project', exact: true }).click();
  await page.getByRole('option', { name: 'Bridge works' }).click();
  await page.getByRole('textbox', { name: 'Probability', exact: true }).fill('4');
  await page.getByRole('textbox', { name: 'Impact', exact: true }).fill('5');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/projects\.action_risks\/\d+$/);
  await expect(page.getByRole('group', { name: 'Assessment' })).toContainText('Critical');

  await page.goto('/projects/a/projects.action_projects');
  await page
    .getByRole('row', { name: /Bridge works/ })
    .first()
    .click();
  const schedule = page.getByRole('region', { name: 'Schedule' });
  await expect(schedule).toBeVisible();
  await expect(schedule.getByRole('img', { name: /Survey the site/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open risks 1' })).toBeVisible();
});

test('duplicate from the form (RFC 0023 R1): the copy opens, with a new number', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/projects/a/projects.action_projects/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Copy me');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/projects\.action_projects\/\d+$/);
  const original = page.url();
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(page.getByText('Duplicated: this is the copy').first()).toBeVisible();
  await expect(page).not.toHaveURL(original);
  await expect(page).toHaveURL(/projects\.action_projects\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Copy me' })).toBeVisible();
});
