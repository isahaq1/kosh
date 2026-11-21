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

test('the calendar in full: month, week and day, the meeting at its hour; a new one from an empty hour', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/agenda/a/agenda.action_events?view=calendar');
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  const month = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(
    new Date(),
  );
  await expect(page.getByRole('table', { name: month })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Weekly review' }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Week', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: /Weekly review/ }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Day', exact: true }).click();
  await expect(page.getByRole('button', { name: /Weekly review/ }).first()).toBeVisible();
  // An empty hour starts a new meeting there.
  await page
    .getByRole('button', { name: /^New on .* at 10/ })
    .first()
    .click();
  await expect(page).toHaveURL(/agenda\.action_events\/new/);
});

test('a repeating event: the rule in words, generated into its occurrences, then stopped (RFC 0034)', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/agenda/a/agenda.action_recurrences/new');
  const title = `Board meeting ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  // Monday 3 March 2031 (far ahead: every occurrence is still to come).
  const start = page.getByRole('textbox', { name: 'First starts', exact: true });
  await start.fill('2031-03-03T10:00');
  await start.blur();
  const end = page.getByRole('textbox', { name: 'First ends', exact: true });
  await end.fill('2031-03-03T11:00');
  await end.blur();
  await page.getByRole('textbox', { name: 'Times', exact: true }).fill('3');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/agenda\.action_recurrences\/\d+$/);
  await expect(page.getByText('Every week on Monday, 3 times')).toBeVisible();

  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByRole('button', { name: /^State: Running/ })).toBeVisible();
  // Its three Mondays are events of their own, on the calendar's list.
  await page.goto('/agenda/a/agenda.action_events?view=list');
  await expect(page.getByRole('row', { name: new RegExp(title) })).toHaveCount(3, {
    timeout: 20_000,
  });

  await page.goBack();
  await page.getByRole('button', { name: 'Stop the series' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByRole('button', { name: /^State: Stopped/ })).toBeVisible();
  await page.goto('/agenda/a/agenda.action_events?view=list');
  await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(title) })).toHaveCount(0);
});

test('my calendar address: made on a form, read by another calendar without a sign-in (RFC 0034)', async ({
  page,
  request,
}) => {
  await signIn(page, 'dina');
  await page.goto('/agenda/a/agenda.action_feeds/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`Phone ${Date.now()}`);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/agenda\.action_feeds\/\d+$/);
  const address = page.getByText(/\/api\/v1\/agenda\/feed\/[A-Za-z0-9_-]{32}\.ics/).first();
  await expect(address).toBeVisible();
  const path = /\/api\/v1\/agenda\/feed\/[A-Za-z0-9_-]{32}\.ics/.exec(
    await address.innerText(),
  )?.[0];
  if (path === undefined) throw new Error('no address on the form');
  // As a calendar reads it: no cookie, no token — the secret in the link is the access.
  const read = await request.get(new URL(path, page.url()).toString(), {
    headers: { cookie: '' },
  });
  expect(read.status()).toBe(200);
  expect(read.headers()['content-type']).toContain('text/calendar');
  const body = await read.text();
  expect(body).toContain('BEGIN:VCALENDAR');
  expect(body).toContain('METHOD:PUBLISH');
  const wrong = await request.get(
    new URL(path.replace(/.{6}\.ics$/, 'AAAAAA.ics'), page.url()).toString(),
  );
  expect(wrong.status()).toBe(404);
});

test('my other calendars: connected by saying yes at the provider, synced, disconnected (RFC 0034)', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/agenda/a/agenda.action_sync');
  await expect(page.getByRole('heading', { name: 'My other calendars', level: 1 })).toBeVisible();
  await expect(page.getByText('No calendar is connected yet.')).toBeVisible();
  // To the provider — here the test calendar's own page —, which sends her back connected.
  await page.getByRole('button', { name: 'Connect Test calendar' }).click();
  await expect(page.getByRole('heading', { name: 'Test calendar' })).toBeVisible();
  const calendar = `e2e-${Date.now()}`;
  await page.getByLabel('Calendar to open').fill(calendar);
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page.getByText('The calendar is connected, and was synced.')).toBeVisible();
  const connected = page.getByRole('listitem').filter({ hasText: `${calendar}@fake.example` });
  await expect(connected).toContainText('Test calendar');
  // Her own events went there with the first sync; another one does nothing more.
  await expect(connected).toContainText(/\d+ in, \d+ out, \d+ deleted/);
  await connected.getByRole('button', { name: /^Sync .* now$/ }).click();
  await expect(connected).toContainText('0 in, 0 out, 0 deleted');
  // Disconnected: gone from the list; her events stay.
  await connected.getByRole('button', { name: /^Disconnect / }).click();
  await expect(page.getByText('No calendar is connected yet.')).toBeVisible();
});
