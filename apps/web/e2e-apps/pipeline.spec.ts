/**
 * Pipeline end to end (RFC 0021): a salesperson adds a deal; moving it to Proposal without its revenue and close
 * date is refused with the stage's rule, then accepted with them; marked lost without a reason it is refused, with
 * one it is lost.
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

async function save(page: Page): Promise<number> {
  const saved = page.waitForResponse(
    // The save itself, not the form's onchange calls.
    (r) =>
      /\/api\/v1\/models\/crm\.deal(\/\d+)?$/.test(new URL(r.url()).pathname) &&
      ['POST', 'PATCH'].includes(r.request().method()),
  );
  await page.getByRole('button', { name: 'Save' }).click();
  return (await saved).status();
}

test('a deal: the stage’s rule refuses the move until its details are there; lost only with a reason', async ({
  page,
}) => {
  await signIn(page, 'rahim');
  await page.goto('/pipeline/a/pipeline.action_deals/new');
  await page.getByRole('textbox', { name: 'Deal', exact: true }).fill('Laptops for Meghna Bank');
  await page.getByRole('textbox', { name: 'Company (prospect)' }).fill('Meghna Bank');
  await page.getByRole('combobox', { name: 'Stage' }).click();
  await page.getByRole('option', { name: 'New' }).click();
  expect(await save(page)).toBe(201);
  await expect(page).toHaveURL(/pipeline\.action_deals\/\d+$/);

  await page.getByRole('combobox', { name: 'Stage' }).click();
  await page.getByRole('option', { name: 'Proposal' }).click();
  await expect(page.getByRole('textbox', { name: 'Probability (%)' })).toHaveValue('60'); // from the stage
  expect(await save(page)).toBe(422);
  await expect(page.getByText(/needs more details/).first()).toBeVisible();
  await page.getByRole('textbox', { name: 'Expected revenue' }).fill('850000');
  const close = page.getByRole('textbox', { name: 'Expected close date', exact: true });
  await close.fill('2026-12-15');
  await close.blur();
  expect(await save(page)).toBe(200);

  await page.getByRole('checkbox', { name: 'Lost' }).click();
  expect(await save(page)).toBe(422);
  await expect(page.getByText('A lost deal says why it was lost.').first()).toBeVisible();
  await page.getByRole('combobox', { name: 'Lost because' }).click();
  await page.getByRole('option', { name: 'Chose a competitor' }).click();
  expect(await save(page)).toBe(200);

  await page.goto('/pipeline/a/pipeline.action_deals?view=list');
  await expect(page.getByRole('heading', { name: 'Deals', level: 1 })).toBeVisible();
  await expect(page.getByRole('row', { name: /Laptops for Meghna Bank/ })).toHaveCount(0); // open deals only
});

test('the Pipeline overview (RFC 0022 step 2): the pipeline, its forecast, the funnel', async ({
  page,
}) => {
  await signIn(page, 'rahim');
  await page.goto('/pipeline/a/crm.action_overview');
  await expect(page.getByRole('heading', { name: 'Pipeline · Overview' })).toBeVisible();
  for (const title of ['Pipeline', 'Weighted forecast', 'Deals by stage'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
