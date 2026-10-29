/**
 * Internal chat end to end (RFC 0006 part 6): a group made from the Chat app reaches its member live, with a
 * reaction and a thread reply seen by both sides; a direct message lands in the other user's dock and bell; a
 * user without Messaging has no dock; the chat has no serious accessibility violations.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { signIn } from './support.js';

const CHAT = '/chat/a/messaging.action_chat';

async function openChat(page: Page): Promise<void> {
  await page.goto(CHAT);
  await expect(page.getByRole('heading', { name: 'Chat', level: 1 })).toBeVisible();
}

test('a group: created from the app, live for its member, with a reaction and a thread', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina');
  await openChat(page);
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.getByRole('menuitem', { name: 'New group or channel' }).click();
  const dialog = page.getByRole('dialog', { name: 'New group or channel' });
  await dialog.getByLabel('Name').fill('Bridge works');
  await dialog.getByRole('combobox', { name: 'Add members…' }).fill('Rah');
  await dialog.getByRole('option', { name: 'Rahim Uddin' }).click();
  await expect(dialog.getByRole('list', { name: 'Members' })).toContainText('Rahim Uddin');
  await dialog.getByRole('button', { name: 'Create' }).click();
  const conversation = page.getByRole('region', { name: 'Bridge works' });
  await expect(conversation.getByRole('heading', { name: 'Bridge works' })).toBeVisible();
  await expect(conversation.getByText('2 members')).toBeVisible();
  const box = conversation.getByRole('combobox', { name: /Message Bridge works/ });
  await box.fill('Survey booked for **Monday**');
  await box.press('Control+Enter');
  await expect(conversation.getByRole('article').first().locator('strong')).toHaveText('Monday');

  // Rahim, in his own session, sees the group and the message without reloading; he reacts and replies.
  const other = await browser.newContext();
  const rahim = await other.newPage();
  await signIn(rahim, 'rahim');
  await openChat(rahim);
  await rahim.getByRole('button', { name: /Bridge works/ }).click();
  const theirs = rahim.getByRole('region', { name: 'Bridge works' });
  const message = theirs.getByRole('article').filter({ hasText: 'Survey booked' });
  await expect(message).toBeVisible();
  await message.hover();
  await message.getByRole('button', { name: 'React with 👍' }).click();
  await expect(message.getByRole('button', { name: '👍 1' })).toBeVisible();
  await message.hover();
  await message.getByRole('button', { name: 'Reply in a thread' }).click();
  const thread = rahim.getByRole('complementary', { name: 'Thread' });
  const reply = thread.getByRole('combobox', { name: /Reply in the thread/ });
  await reply.fill('I will be there at 9');
  await reply.press('Control+Enter');
  await expect(thread.getByRole('article').filter({ hasText: 'I will be there' })).toBeVisible();

  // Dina sees both, live.
  const mine = conversation.getByRole('article').filter({ hasText: 'Survey booked' });
  await expect(mine.getByRole('button', { name: '👍 1' })).toBeVisible();
  await expect(mine.getByRole('button', { name: '1 reply' })).toBeVisible();
  await mine.getByRole('button', { name: '1 reply' }).click();
  await expect(
    page.getByRole('complementary', { name: 'Thread' }).getByText('I will be there at 9'),
  ).toBeVisible();
  await other.close();
});

test('a direct message reaches the dock and the bell; no dock without Messaging', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina');
  await page.goto('/contacts/a/contacts.action_partners');
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible(); // nothing unread

  const other = await browser.newContext();
  const rahim = await other.newPage();
  await signIn(rahim, 'rahim');
  await openChat(rahim);
  await rahim.getByRole('button', { name: 'New conversation' }).click();
  await rahim.getByRole('menuitem', { name: 'New message' }).click();
  const dialog = rahim.getByRole('dialog', { name: 'New message' });
  await dialog.getByRole('combobox', { name: 'To…' }).fill('Dina');
  await dialog.getByRole('option', { name: 'Dina Rahman' }).click();
  const direct = rahim.getByRole('region', { name: 'Dina Rahman' });
  const box = direct.getByRole('combobox', { name: /Message Dina Rahman/ });
  await box.fill('Lunch at one?');
  await box.press('Control+Enter');
  await expect(direct.getByText('Lunch at one?')).toBeVisible();

  // Dina's dock counts it, opens it beside the contacts, and the bell tells too.
  const dock = page.getByRole('button', { name: '1 unread chat message' });
  await expect(dock).toBeVisible();
  await dock.click();
  await page
    .getByRole('list', { name: 'Conversations' })
    .getByRole('button', { name: /Rahim Uddin/ })
    .click();
  const panel = page.getByRole('region', { name: 'Rahim Uddin' });
  await expect(panel.getByText('Lunch at one?')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Contacts', level: 1 })).toBeVisible(); // still there
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible(); // read now
  const reply = panel.getByRole('combobox', { name: /Message Rahim Uddin/ });
  await reply.fill('Yes!');
  await reply.press('Control+Enter');
  await expect(direct.getByText('Yes!')).toBeVisible(); // live on Rahim's side
  await page.getByRole('button', { name: '1 unread notification' }).click();
  await expect(page.getByRole('list', { name: 'Notifications' })).toContainText(
    'Rahim Uddin: Lunch at one?',
  );
  await page.getByRole('button', { name: 'Mark all as read' }).click(); // the other specs count unread
  await page.keyboard.press('Escape');
  await other.close();

  // Bob has no Messaging: no dock in his header.
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await signIn(bob, 'bob');
  await expect(bob.getByRole('button', { name: 'Chat', exact: true })).toHaveCount(0);
  await bobContext.close();
});

test('the chat has no serious accessibility violations', async ({ page }) => {
  await signIn(page, 'dina');
  await openChat(page);
  await page.getByRole('button', { name: /Bridge works/ }).click();
  await expect(
    page.getByRole('region', { name: 'Bridge works' }).getByRole('article').first(),
  ).toBeVisible();
  const results = await new AxeBuilder({ page }).include('main').analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious.map((v) => `${v.id} (${v.nodes.length}) ${v.help}`)).toEqual([]);
});
