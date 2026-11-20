/**
 * The careers page end to end (RFC 0034 §2.6): a hiring manager puts an opening on the careers page from its
 * form; a visitor who is not signed in finds it on the site's public API and applies with a CV; the application
 * is an applicant in Hiring, from the website, with the letter. (What is listed, duplicates, robots, the emails
 * at each stage: the integration tests.)
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

test('an opening put on the careers page; a visitor applies; the applicant is in Hiring', async ({
  page,
  playwright,
}) => {
  await signIn(page, 'dina');
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const headers = { 'x-csrf-token': csrf ?? '' };
  const stamp = Date.now();
  const name = `Store keeper ${stamp}`;
  const key = `careers${stamp}`;
  for (const [model, data] of [
    ['website.site', { name: `Careers ${stamp}`, key }],
    ['hiring.opening', { name, description: 'Keeps the main store in order.' }],
  ] as const) {
    const made = await page.request.post(`/api/v1/models/${model}`, { headers, data });
    expect(made.status(), `${model}: ${await made.text()}`).toBe(201);
  }
  // A visitor: a client of its own, with no session.
  const visitor = await playwright.request.newContext({ baseURL: new URL(page.url()).origin });
  const careers = `/api/v1/public/sites/${key}/careers`;
  const before = (await (await visitor.get(careers)).json()) as { openings: { name: string }[] };
  expect(before.openings.map((o) => o.name)).not.toContain(name);

  // Put on the careers page from the opening's form.
  await page.goto('/hiring/a/hiring.action_openings?view=list');
  await page
    .getByRole('row', { name: new RegExp(name) })
    .getByText(name)
    .click();
  await page.getByLabel('Place of work').fill('Gazipur');
  await page.getByRole('checkbox', { name: 'On the careers page' }).check();
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/v1/models/hiring.opening/') && r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'Save' }).click();
  expect((await saved).status()).toBe(200);

  const listed = (await (await visitor.get(careers)).json()) as {
    openings: { id: number; name: string; location: string | null }[];
  };
  const opening = listed.openings.find((o) => o.name === name);
  expect(opening?.location).toBe('Gazipur');
  const applied = await visitor.post(`${careers}/${opening?.id}/apply`, {
    data: {
      name: 'Shafiq Islam',
      email: `shafiq${stamp}@example.com`,
      cover: 'I kept a store of spare parts for five years.',
      cv: {
        name: 'Shafiq CV',
        mediaType: 'application/pdf',
        data: Buffer.from('%PDF-1.4 a CV').toString('base64'),
      },
    },
  });
  expect(applied.status(), await applied.text()).toBe(201);
  await visitor.dispose();

  // In Hiring: the applicant, from the website, with the letter.
  await page.goto('/hiring/a/hiring.action_applicants?view=list');
  await page
    .getByRole('row', { name: /Shafiq Islam/ })
    .getByText('Shafiq Islam')
    .click();
  await expect(page.getByRole('heading', { name: 'Shafiq Islam' })).toBeVisible();
  await expect(page.getByText('I kept a store of spare parts for five years.')).toBeVisible();
  await expect(page.getByText('Website').first()).toBeVisible();
});
