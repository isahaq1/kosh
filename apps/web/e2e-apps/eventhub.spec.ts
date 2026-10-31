/**
 * Event Hub end to end (RFC 0021): Dina sets up an event with a ticket and opens registrations; Rahim registers an
 * attendee and confirms them — a check-in code is on the registration —; at the door, the code goes into the event's
 * check-in box: checked in, and a second scan is refused.
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

/** A month from now at `hour`, as a datetime-local input takes it. */
const inAMonth = (hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
};

test('an event opened, an attendee registered and confirmed, checked in at the door once', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina'); // Event Hub manager
  await page.goto('/eventhub/a/eventhub.action_events/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Supplier day');
  for (const [field, hour] of [
    ['Starts', 9],
    ['Ends', 17],
  ] as const) {
    const box = page.getByRole('textbox', { name: field, exact: true });
    await box.fill(inAMonth(hour));
    await box.blur();
  }
  const tickets = page.getByRole('table', { name: 'tickets' });
  await tickets.locator('..').getByRole('button', { name: 'Add a line' }).click();
  await tickets.locator('tbody tr').last().getByRole('textbox').first().fill('Standard');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/eventhub\.action_events\/\d+$/);
  await page.getByRole('button', { name: 'Open registrations' }).click();
  await expect(page.getByRole('button', { name: /^State: Open for registration/ })).toBeVisible();
  const eventPage = page.url().replace(/^https?:\/\/[^/]+/, '');

  const context = await browser.newContext();
  const rahim = await context.newPage();
  await signIn(rahim, 'rahim'); // Event Hub user
  await rahim.goto('/eventhub/a/eventhub.action_registrations/new');
  await rahim.getByRole('combobox', { name: 'Event' }).click();
  await rahim.getByRole('option', { name: 'E2E Supplier day' }).click();
  await rahim.getByRole('textbox', { name: 'Attendee' }).fill('Nusrat Jahan');
  await rahim.getByRole('button', { name: 'Save' }).click();
  await expect(rahim).toHaveURL(/eventhub\.action_registrations\/\d+$/);
  const codeBox = rahim.getByRole('textbox', { name: 'Check-in code' });
  await expect(codeBox).not.toHaveValue('');
  const code = await codeBox.inputValue();
  await rahim.getByRole('button', { name: 'Confirm' }).click();
  await expect(rahim.getByRole('button', { name: /^State: Confirmed/ })).toBeVisible();
  await context.close();

  // At the door: the code scanned (here typed) into the event's check-in box.
  await page.goto(eventPage);
  await page.getByRole('textbox', { name: 'Ticket code' }).fill(code);
  await page.getByRole('textbox', { name: 'Ticket code' }).press('Enter');
  await expect(page.getByText('Nusrat Jahan checked in')).toBeVisible();
  await page.getByRole('textbox', { name: 'Ticket code' }).fill(code);
  await page.getByRole('button', { name: 'Check in', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'was checked in at' })).toBeVisible();
});
