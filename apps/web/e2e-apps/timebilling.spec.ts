/**
 * Project billing end to end (RFC 0034 §2.5): someone logs hours on a project billed to its customer and submits
 * them from the form; a manager approves them — the rate comes from the project's rate card —, makes a billing
 * statement from the project and its invoice; at month end the work not yet on a posted invoice is recognised as
 * revenue. (Rates, refusals, milestones, once-only, the entries: the integration tests.)
 */
import { expect, type Page, test } from '@playwright/test';

const PASSWORD = 'correct horse battery';

async function signIn(page: Page, login: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
}

async function maker(page: Page) {
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const headers = { 'x-csrf-token': csrf ?? '' };
  return async (model: string, data: Record<string, unknown>): Promise<number> => {
    const made = await page.request.post(`/api/v1/models/${model}`, { headers, data });
    expect(made.status(), `${model}: ${await made.text()}`).toBe(201);
    return ((await made.json()) as { id: number }).id;
  };
}

test('hours submitted, approved at the card’s rate, and invoiced from a billing statement', async ({
  page,
}) => {
  const stamp = Date.now();
  await signIn(page, 'dina');
  let make = await maker(page);
  const service = await make('product.product', {
    name: `Consulting ${stamp}`,
    kind: 'service',
    listPrice: '2000',
  });
  const customer = await make('res.partner', { name: `Surma Agro ${stamp}` });
  const card = await make('project.rate.card', { name: `Rates ${stamp}`, defaultRate: '2000' });
  const project = await make('project.project', {
    name: `Rollout ${stamp}`,
    partner: customer,
    billable: true,
    rateCard: card,
    billingProduct: service,
  });
  const task = await make('project.task', { name: `Workshop ${stamp}`, project });

  // The author logs three hours and submits them from the form.
  await signIn(page, 'rahim');
  make = await maker(page);
  const hours = await make('project.timesheet', { task, hours: '3' });
  await page.goto(`/projects/a/projects.action_timesheets/${hours}`);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toHaveCount(0);

  // A manager approves: 3 h at the card's 2,000.
  await signIn(page, 'dina');
  await page.goto(`/projects/a/projects.action_timesheets/${hours}`);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(page.getByText('6,000').first()).toBeVisible();

  // From the project: a statement, and its invoice.
  await page.goto(`/projects/a/projects.action_projects/${project}`);
  await page.getByRole('button', { name: 'New billing statement' }).click();
  // It arrives filled with the project, and is saved as it is.
  await expect(page).toHaveURL(/projects\.action_statements\/new$/);
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveText(
    `Rollout ${stamp}`,
  );
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/projects\.action_statements\/\d+$/);
  await page.getByRole('button', { name: 'Make the invoice' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByRole('button', { name: 'Release', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'timesheets' }).getByRole('row')).toHaveCount(2);
  await expect(page.getByText('6,000').first()).toBeVisible();

  // Month end: the invoice is still a draft, so its 6,000 is work in progress, recognised as revenue.
  await page.goto('/projects/a/projects.action_recognitions/new');
  await page.getByLabel('Note').fill('Month end');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/projects\.action_recognitions\/\d+$/);
  await page.getByRole('button', { name: 'Recognise', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByRole('button', { name: 'Recognise', exact: true })).toHaveCount(0);
  const recognised = page.getByRole('table', { name: 'lines' });
  await expect(recognised.getByRole('row', { name: new RegExp(`Rollout ${stamp}`) })).toContainText(
    '6,000',
  );
});
