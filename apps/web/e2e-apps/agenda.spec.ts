/**
 * Agenda end to end (RFC 0021): a manager adds a room and books it for a meeting today — the end follows the start
 * by the default length —; booking the same room at the same time is refused; the meeting is among today's on the
 * home page.
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

/** Today at `hour`, as a datetime-local input takes it. */
const today = (hour: number) => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
};

async function newEvent(page: Page, title: string): Promise<void> {
  await page.goto('/agenda/a/agenda.action_events/new');
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  await page.getByRole('textbox', { name: 'Start', exact: true }).fill(today(22));
  await page.getByRole('textbox', { name: 'Start', exact: true }).blur();
  await expect(page.getByRole('textbox', { name: 'End', exact: true })).toHaveValue(today(23)); // the default length
  await page.getByRole('combobox', { name: 'Room' }).click();
  // Typing searches again: the room made a moment ago is found even under load.
  await page.getByRole('textbox', { name: 'Room' }).fill('Board');
  await page.getByRole('option', { name: 'Board room' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
}

test('a room booked for a meeting today; the same slot refused; the meeting on the home page', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/agenda/a/agenda.action_rooms/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Board room');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/agenda\.action_rooms\/\d+$/); // saved: a new record's title shows before
  await expect(page.getByRole('heading', { name: 'Board room' })).toBeVisible();

  await newEvent(page, 'Weekly review');
  await expect(page).toHaveURL(/agenda\.action_events\/\d+$/);

  await newEvent(page, 'Clash');
  await expect(page.getByText('The room is already booked at that time.').first()).toBeVisible();

  await page.goto('/');
  const meetings = page.getByRole('region', { name: 'Today’s meetings' });
  await expect(meetings.getByText('Weekly review')).toBeVisible();
  await expect(meetings.getByText('Clash')).toHaveCount(0);
});

test('the Agenda overview (RFC 0022 step 2)', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/agenda/a/calendar.action_overview');
  await expect(page.getByRole('heading', { name: 'Agenda · Overview' })).toBeVisible();
  for (const title of ['Meetings this month', 'Rooms', 'Meetings by room'])
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
});
