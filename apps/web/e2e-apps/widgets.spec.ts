/**
 * Richer widgets end to end (RFC 0022 §3.3): a contact gets a photo from a chosen file (shrunk in the browser,
 * uploaded with its thumbnail, shown from the thumbnail), its email is a link; a deal's priority shows as stars on
 * the board and the list.
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

/** A 1 × 1 PNG, enough for the browser to draw and shrink. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('a contact: a photo chosen, uploaded and shown; the email a link', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/contacts/a/contacts.action_partners/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Photo Ltd');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('hello@photo.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/contacts\.action_partners\/\d+$/);
  await page.getByLabel('Choose a picture').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  const picture = page.getByRole('img', { name: 'E2E Photo Ltd' }).first();
  await expect(picture).toBeVisible();
  await expect(picture).toHaveAttribute(
    'src',
    /\/api\/v1\/attachments\/\d+\/download\?inline=true&w=256/,
  );
  await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().includes('/res.partner/'),
    ),
    page.getByRole('button', { name: 'Save' }).click(),
  ]);
  await page.reload();
  await expect(page.getByRole('img', { name: 'E2E Photo Ltd' }).first()).toBeVisible();
  // On the list (display only) the email is a link; on the editable form it is the input.
  await page.goto('/contacts/a/contacts.action_partners?view=list');
  await expect(
    page
      .getByRole('row', { name: /E2E Photo Ltd/ })
      .getByRole('link', { name: 'hello@photo.test' }),
  ).toHaveAttribute('href', 'mailto:hello@photo.test');
});

test("a deal's priority as stars on the board and the list", async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/pipeline/a/pipeline.action_deals/new');
  await page.getByRole('textbox', { name: 'Deal', exact: true }).fill('E2E Starred deal');
  await page.getByRole('combobox', { name: 'Priority' }).click();
  await page.getByRole('option', { name: 'Very good' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/pipeline\.action_deals\/\d+$/);
  await page.goto('/pipeline/a/pipeline.action_deals?view=kanban');
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: 'E2E Starred deal' })
      .getByRole('img', { name: 'Priority: Very good' }),
  ).toBeVisible();
  await page.goto('/pipeline/a/pipeline.action_deals?view=list');
  const row = page.getByRole('row', { name: /E2E Starred deal/ });
  await expect(row.getByRole('img', { name: 'Priority: Very good' })).toBeVisible();
});
