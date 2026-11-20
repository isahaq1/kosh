/**
 * Surveys end to end (RFC 0034 §2.6): a manager opens a survey from its form; a visitor who is not signed in
 * answers it on the public page — a question appears because of an answer, a missing one is said in words — and
 * reads the thanks; the back-office shows the response and the survey's NPS. The page speaks Bangla when asked.
 * (Scoring, invitations, anonymity, the locks: the integration tests.)
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

test('a survey opened on screen, answered by a visitor on the public page, and its result', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina');
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const headers = { 'x-csrf-token': csrf ?? '' };
  const make = async (model: string, data: Record<string, unknown>): Promise<number> => {
    const made = await page.request.post(`/api/v1/models/${model}`, { headers, data });
    expect(made.status(), `${model}: ${await made.text()}`).toBe(201);
    return ((await made.json()) as { id: number }).id;
  };
  const name = `After your visit ${Date.now()}`;
  const survey = await make('survey.survey', { name, thanks: 'Thank you for telling us.' });
  const recommend = await make('survey.question', {
    survey,
    sequence: 10,
    title: 'Would you recommend us?',
    kind: 'nps',
    required: true,
  });
  await make('survey.question', {
    survey,
    sequence: 20,
    title: 'What went wrong?',
    kind: 'long_text',
    required: true,
    showWhenQuestion: recommend,
    showWhenOp: 'lt',
    showWhenValue: '7',
  });

  // Opened from its form.
  await page.goto(`/surveys/a/surveys.action_surveys/${survey}`);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
  const record = await page.request.get(`/api/v1/models/survey.survey/${survey}?fields=link`);
  const link = ((await record.json()) as { link: string }).link;

  // A visitor, with no session at all.
  const visitor = await browser.newContext();
  const form = await visitor.newPage();
  await form.goto(new URL(link, page.url()).toString());
  await expect(form.getByRole('heading', { name, level: 1 })).toBeVisible();
  const reason = form.getByRole('textbox', { name: /What went wrong/ });
  await expect(reason).toBeHidden();
  // Sent empty: the required question is named.
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(form.getByRole('status')).toContainText('Would you recommend us?: needs an answer');
  // A four: the reason is asked for.
  await form
    .getByRole('group', { name: /Would you recommend us/ })
    .getByText('4', { exact: true })
    .click();
  await expect(reason).toBeVisible();
  await reason.fill('The queue was long.');
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(form.getByRole('status')).toHaveText('Thank you for telling us.');
  // In Bangla when asked.
  await form.goto(new URL(`${link}?lang=bn`, page.url()).toString());
  await expect(form.getByRole('button', { name: 'পাঠান' })).toBeVisible();
  await visitor.close();

  // In the back-office: one response, a detractor.
  await page.goto('/surveys/a/surveys.action_surveys?view=list');
  const row = page.getByRole('row', { name: new RegExp(name) });
  await expect(row).toContainText('-100');
  await page.goto('/surveys/a/surveys.action_answers?view=list');
  await expect(page.getByRole('row', { name: /The queue was long\./ })).toBeVisible();
});
