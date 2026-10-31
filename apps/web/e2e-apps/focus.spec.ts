/**
 * Focus end to end (RFC 0021): a person adds a high-priority to-do due today; it is listed, and among what needs them
 * on the home page, where Done closes it. (Checklists and their progress: the integration test.)
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

test('a to-do due today: listed, on the home page, done from there', async ({ page }) => {
  await signIn(page, 'rahim');
  await page.goto('/focus/a/focus.action_tasks/new');
  await page
    .getByRole('textbox', { name: 'To-do', exact: true })
    .fill('Call the bank about the LC');
  const due = page.getByRole('textbox', { name: 'Due', exact: true });
  await due.fill(new Date().toISOString().slice(0, 10));
  await due.blur();
  await page.getByRole('combobox', { name: 'Priority' }).click();
  await page.getByRole('option', { name: 'High' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  // Saved (a new record's title shows before it is): the address carries its id.
  await expect(page).toHaveURL(/focus\.action_tasks\/\d+$/);

  await page.goto('/focus/a/focus.action_tasks?view=list');
  await expect(page.getByRole('heading', { name: 'To-dos', level: 1 })).toBeVisible();
  await expect(page.getByRole('row', { name: /Call the bank about the LC/ })).toContainText(
    'High',
    {
      timeout: 20_000,
    },
  );

  // On the home page, among what needs Rahim; Done closes it.
  await page.goto('/');
  const attention = page.getByRole('region', { name: /Needs your attention/ });
  const item = attention.getByRole('listitem').filter({ hasText: 'Call the bank about the LC' });
  await expect(item).toContainText('due today');
  await item.getByRole('button', { name: 'Done' }).click();
  await expect(item).toHaveCount(0);
  await page.goto('/focus/a/focus.action_tasks?view=list');
  await expect(page.getByRole('row', { name: /Call the bank about the LC/ })).toHaveCount(0); // To do only
});

test('the Focus overview (RFC 0022 step 2)', async ({ page }) => {
  await signIn(page, 'rahim');
  await page.goto('/focus/a/todo.action_overview');
  await expect(page.getByRole('heading', { name: 'Focus · Overview' })).toBeVisible();
  for (const title of ['Open to-dos', 'Shared lists', 'Open by list'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
