/**
 * Helpdesk end to end (RFC 0024 §2.4): Dina opens a ticket for a customer on the Support team's board, puts it on
 * waiting, then solves it; the overview counts the tickets.
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

test('a ticket opened, waiting on the customer, then solved', async ({ page }) => {
  await signIn(page, 'dina'); // Helpdesk manager
  await page.goto('/helpdesk/a/helpdesk.action_tickets/new');
  await page.getByRole('textbox', { name: 'Subject' }).fill('The printer in Accounts is jammed');
  await page.getByRole('textbox', { name: 'Customer email' }).fill('accounts@example.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/helpdesk\.action_tickets\/\d+$/);
  await expect(page.getByRole('button', { name: /^State: Open/ })).toBeVisible();
  await page.getByRole('button', { name: 'Waiting on the customer' }).click();
  await expect(page.getByRole('button', { name: /^State: Waiting on the customer/ })).toBeVisible();
  await page.getByRole('button', { name: 'Solved' }).click();
  await expect(page.getByRole('button', { name: /^State: Solved/ })).toBeVisible();
});

test('the Helpdesk overview', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/helpdesk/a/helpdesk.action_overview');
  await expect(page.getByRole('heading', { name: 'Helpdesk · Overview' })).toBeVisible();
  for (const title of ['Open tickets', 'SLA breached', 'Tickets by SLA'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});

test('a ticket’s description is rich text: typed, made bold and a list from the toolbar, kept after a reload (RFC 0034)', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/helpdesk/a/helpdesk.action_tickets/new');
  await page.getByRole('textbox', { name: 'Subject' }).fill(`Formatted ${Date.now()}`);
  await page.getByRole('textbox', { name: 'Customer email' }).fill('rich@example.test');
  const editor = page.getByRole('textbox', { name: 'Description' });
  await editor.click();
  await page.keyboard.type('Steps to see it');
  // The toolbar acts on the selection, and says what is on.
  await page.keyboard.press('ControlOrMeta+a');
  const toolbar = page.getByRole('toolbar', { name: 'Formatting' });
  await toolbar.getByRole('button', { name: 'Bold' }).click();
  await expect(toolbar.getByRole('button', { name: 'Bold' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await toolbar.getByRole('button', { name: 'Bold' }).click();
  await toolbar.getByRole('button', { name: 'Bulleted list' }).click();
  await page.keyboard.type('Open the cart');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Press Pay');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/helpdesk\.action_tickets\/\d+$/);

  await page.reload();
  const saved = page.getByRole('textbox', { name: 'Description' });
  await expect(saved.locator('strong')).toHaveText('Steps to see it');
  await expect(saved.locator('ul > li')).toHaveText(['Open the cart', 'Press Pay']);
  // What the server keeps is the allow-list's: nothing but the tags a note needs.
  const id = /\/(\d+)$/.exec(page.url())?.[1];
  const stored = await page.evaluate(async (ticket) => {
    const response = await fetch(`/api/v1/models/helpdesk.ticket/${ticket}?fields=description`, {
      credentials: 'include',
    });
    return ((await response.json()) as { description: string }).description;
  }, id);
  expect(stored).toBe(
    '<p><strong>Steps to see it</strong></p><ul><li><p>Open the cart</p></li><li><p>Press Pay</p></li></ul>',
  );
});

test('a note in the chatter with formatting and a mention; edited by its author (RFC 0034)', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/helpdesk/a/helpdesk.action_tickets/new');
  await page.getByRole('textbox', { name: 'Subject' }).fill(`Chatter ${Date.now()}`);
  await page.getByRole('textbox', { name: 'Customer email' }).fill('chatter@example.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/helpdesk\.action_tickets\/\d+$/);

  await page.getByRole('button', { name: 'Log note' }).click();
  const formatting = page.getByRole('button', { name: 'Formatting', exact: true });
  await formatting.click();
  await expect(formatting).toHaveAttribute('aria-pressed', 'true');
  const editor = page.getByRole('textbox', { name: 'Log note' });
  await editor.click();
  await page.keyboard.type('Called the customer');
  await page.keyboard.press('ControlOrMeta+a');
  // The note's own toolbar: the description above it on the page has one too.
  const toolbar = page.getByRole('toolbar', { name: 'Formatting' }).last();
  await toolbar.getByRole('button', { name: 'Bold' }).click();
  await page.keyboard.press('End');
  await toolbar.getByRole('button', { name: 'Bold' }).click();
  await page.keyboard.type(' — over to ');
  // A person is mentioned from the toolbar: searched by name, picked from the list.
  await toolbar.getByRole('button', { name: 'Mention someone' }).click();
  await page.getByRole('textbox', { name: 'Who? Type a name' }).fill('Rahim');
  await page.getByRole('button', { name: 'Rahim Uddin' }).click();
  await page.getByRole('button', { name: 'Log', exact: true }).click();

  const note = page.getByRole('article').filter({ hasText: 'Called the customer' });
  await expect(note.locator('strong')).toHaveText('Called the customer');
  await expect(note.locator('[data-type="mention"]')).toHaveText('@Rahim Uddin');

  // Its author edits it in the editor it was written in.
  await note.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const editing = note.getByRole('textbox', { name: 'Edit' });
  await editing.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' today');
  await note.getByRole('button', { name: 'Save' }).click();
  await expect(note).toContainText('over to @Rahim Uddin today');
  await expect(note).toContainText('(edited)');
  await expect(note.locator('[data-type="mention"]')).toHaveText('@Rahim Uddin'); // still a mention
});
