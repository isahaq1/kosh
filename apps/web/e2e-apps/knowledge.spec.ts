/**
 * Knowledge end to end (RFC 0038, step 7): Dina writes an article on screen with its content in rich text, then
 * one inside it; the overview.
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

test('an article written in rich text; another inside it', async ({ page }) => {
  await signIn(page, 'dina'); // Knowledge manager
  const title = `E2E Handbook ${Date.now()}`;
  await page.goto('/knowledge/a/knowledge.action_articles/new');
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  const editor = page.getByRole('textbox', { name: 'Content' });
  await editor.click();
  await page.keyboard.type('How we work here.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/knowledge\.action_articles\/\d+$/);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Content' })).toContainText('How we work here.');

  await page.goto('/knowledge/a/knowledge.action_articles/new');
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(`${title} — Leave`);
  await page.getByRole('combobox', { name: 'Inside' }).click();
  await page.keyboard.type(title);
  await page.getByRole('option', { name: title, exact: true }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/knowledge\.action_articles\/\d+$/);
});

test('the Knowledge overview', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/knowledge/a/knowledge.action_overview');
  await expect(page.getByRole('heading', { name: 'Knowledge · Overview' })).toBeVisible();
  for (const title of ['Articles', 'For everyone', 'Articles by who reads them'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
