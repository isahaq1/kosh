/**
 * The notifications bell (RFC 0006 §5.4): a mention in a record's chatter reaches the mentioned user's bell at once,
 * opening it goes to the record and marks it read; "mark all as read" clears the badge.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

const CONTACTS = '/contacts/a/contacts.action_partners';

test('a mention lands in the bell, live; opening it goes to the record', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina');
  await page.goto(CONTACTS);
  await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible(); // nothing unread

  // Rahim mentions Dina on Acme Trading, from his own session.
  const other = await browser.newContext();
  const rahim = await other.newPage();
  await signIn(rahim, 'rahim');
  const ids = await rahim.evaluate(async () => {
    const partners = (await (await fetch('/api/v1/models/res.partner/names?q=Acme')).json()) as {
      items: { id: number }[];
    };
    const users = (await (await fetch('/api/v1/models/res.users/names?q=Dina')).json()) as {
      items: { id: number }[];
    };
    return { partner: partners.items[0]?.id, dina: users.items[0]?.id };
  });
  const csrf = await rahim.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const posted = await rahim.request.post(`/api/v1/chatter/res.partner/${ids.partner}/messages`, {
    headers: { 'x-csrf-token': csrf ?? '' },
    data: {
      kind: 'comment',
      text: `@[Dina Rahman](user:${ids.dina}) can you check the credit limit?`,
    },
  });
  expect(posted.ok()).toBe(true);

  const bell = page.getByRole('button', { name: '1 unread notification' });
  await expect(bell).toBeVisible();
  await bell.click();
  const panel = page.getByRole('list', { name: 'Notifications' });
  await expect(panel.getByRole('button')).toContainText(
    'Rahim Uddin mentioned you on Acme Trading',
  );
  await panel.getByRole('button').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Acme Trading');
  await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible(); // read

  // A second mention, then "mark all as read".
  await rahim.request.post(`/api/v1/chatter/res.partner/${ids.partner}/messages`, {
    headers: { 'x-csrf-token': csrf ?? '' },
    data: { kind: 'comment', text: `@[Dina Rahman](user:${ids.dina}) and the phone number` },
  });
  await page.getByRole('button', { name: '1 unread notification' }).click();
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();
  await other.close();
});
