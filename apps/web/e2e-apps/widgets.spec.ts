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

/** A 2 × 2 PNG (red), enough for the browser to draw and shrink. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DwHwyBFIjFAAB+hAX/9k5+ywAAAABJRU5ErkJggg==',
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
  const picture = page.getByRole('img', { name: 'E2E Photo Ltd' });
  await expect(picture).toBeVisible();
  await expect(picture).toHaveAttribute(
    'src',
    /\/api\/v1\/attachments\/\d+\/download\?inline=true&w=256/,
  );
  await page.getByRole('button', { name: 'Save' }).click();
  await page.reload();
  await expect(page.getByRole('img', { name: 'E2E Photo Ltd' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'hello@photo.test' })).toHaveAttribute(
    'href',
    'mailto:hello@photo.test',
  );
});

test("a deal's priority as stars on the board and the list", async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/pipeline/a/pipeline.action_deals/new');
  await page.getByRole('textbox', { name: 'Deal', exact: true }).fill('E2E Starred deal');
  await page.getByRole('radio', { name: 'Very good' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/pipeline\.action_deals\/\d+$/);
  await expect(page.getByLabel(/^Priority: Very good$/)).toBeVisible();
  await page.goto('/pipeline/a/pipeline.action_deals?view=list');
  const row = page.getByRole('row', { name: /E2E Starred deal/ });
  await expect(row.getByRole('img', { name: 'Priority: Very good' })).toBeVisible();
});
