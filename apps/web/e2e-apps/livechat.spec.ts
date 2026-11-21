/**
 * Live chat end to end (RFC 0034 §2.6): an operator says they take conversations in their inbox; a visitor with no
 * session at all writes in the channel's chat window and is given to them; the operator answers, the visitor reads
 * it and writes back, ends the conversation and rates it; the operator sees it has ended, and it is kept.
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

test('a visitor writes in the chat window, the operator answers from the inbox, the visitor rates it', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina');
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const headers = { 'x-csrf-token': csrf ?? '' };
  const users = await page.request.get(
    `/api/v1/models/res.users?fields=login&filter=${encodeURIComponent(JSON.stringify({ login: 'dina' }))}`,
  );
  const [me] = ((await users.json()) as { items: { id: number }[] }).items;
  expect(me, await users.text()).toBeDefined();
  const name = `E2E chat ${Date.now()}`;
  const made = await page.request.post('/api/v1/models/livechat.channel', {
    headers,
    data: { name, operators: { set: [me?.id] }, assignment: 'turn', limit: 5 },
  });
  expect(made.status(), await made.text()).toBe(201);
  const channel = ((await made.json()) as { id: number }).id;
  const record = await page.request.get(`/api/v1/models/livechat.channel/${channel}?fields=link`);
  const link = ((await record.json()) as { link: string }).link;

  // The operator opens their inbox and says they take conversations.
  await page.goto('/livechat/a/livechat.action_inbox');
  await page.getByRole('button', { name: 'Not taking conversations' }).click();
  await expect(page.getByRole('button', { name: 'Taking conversations' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // A visitor, with no session at all.
  const visitor = await browser.newContext();
  const chat = await visitor.newPage();
  await chat.goto(new URL(link, page.url()).toString());
  await expect(chat.getByRole('heading', { name, level: 1 })).toBeVisible();
  const who = `Visitor ${Date.now()}`;
  await chat.getByRole('textbox', { name: 'Your name' }).fill(who);
  await chat.getByRole('textbox', { name: 'Your message' }).fill('Do you deliver to Gazipur?');
  await chat.getByRole('button', { name: 'Start the chat' }).click();
  await expect(chat.getByRole('status').first()).toContainText('You are talking with');
  await expect(chat.getByRole('log')).toContainText('Do you deliver to Gazipur?');

  // It is in the operator's inbox, theirs: they open it and answer.
  await page.getByRole('button', { name: `Open the conversation with ${who}` }).click();
  const log = page.getByRole('log', { name: `Conversation with ${who}` });
  await expect(log).toContainText('Do you deliver to Gazipur?');
  const reply = page.getByRole('textbox', { name: 'Your reply' });
  await reply.fill('Yes, within two working days.');
  await reply.press('Enter');
  await expect(log).toContainText('Yes, within two working days.');

  // The visitor reads it, and writes back.
  await expect(chat.getByRole('log')).toContainText('Yes, within two working days.');
  const say = chat.getByRole('textbox', { name: 'Your message' });
  await say.fill('Thank you!');
  await say.press('Enter');
  await expect(log).toContainText('Thank you!');

  // The visitor ends it and rates it.
  await chat.getByRole('button', { name: 'End the chat' }).click();
  await chat.getByRole('button', { name: '5 out of five' }).click();
  await expect(chat.getByText('Thank you.', { exact: true })).toBeVisible();
  await expect(page.getByText('This conversation has ended.')).toBeVisible();
  // The operator makes a deal of it from the inbox: once, with what was said.
  await page.getByRole('button', { name: 'Make a deal of it' }).click();
  await expect(page.getByText('It became: Do you deliver to Gazipur?')).toBeVisible();
  await visitor.close();

  // Kept, with who it was and what they thought.
  await page.goto('/livechat/a/livechat.action_sessions?view=list');
  const row = page.getByRole('row').filter({ hasText: who });
  await expect(row).toContainText(name);
  await expect(row).toContainText('Closed');

  // The deal carries what was said, and shows the chat it came from.
  const found = await page.request.get(
    `/api/v1/models/livechat.session?fields=resModel,resId&filter=${encodeURIComponent(JSON.stringify({ visitorName: who }))}`,
  );
  const [session] = ((await found.json()) as { items: { resModel: string; resId: number }[] })
    .items;
  expect(session?.resModel).toBe('crm.deal');
  const deal = { id: session?.resId };
  await page.goto(`/pipeline/a/pipeline.action_deals/${deal.id}`);
  await expect(page.getByRole('heading', { name: 'Do you deliver to Gazipur?' })).toBeVisible();
  await expect(page.getByText('Chats', { exact: true })).toBeVisible();
  await page.goto('/livechat/a/livechat.action_sessions?view=list');
  await expect(page.getByRole('row').filter({ hasText: who })).toContainText(
    'Do you deliver to Gazipur?',
  );

  // In Bangla, the chat window speaks Bangla.
  const bangla = await browser.newContext();
  const window = await bangla.newPage();
  await window.goto(new URL(`${link}?lang=bn`, page.url()).toString());
  await expect(window.getByRole('button', { name: 'চ্যাট শুরু করুন' })).toBeVisible();
  await bangla.close();
});

test('the assistant answers first, marked as an AI, and hands over to the operator when it does not know', async ({
  page,
  browser,
}) => {
  await signIn(page, 'dina');
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const headers = { 'x-csrf-token': csrf ?? '' };
  const post = async (url: string, data: Record<string, unknown>): Promise<number> => {
    const made = await page.request.post(url, { headers, data });
    expect(made.status(), `${url}: ${await made.text()}`).toBeLessThan(300);
    return ((await made.json()) as { id: number }).id;
  };
  const users = await page.request.get(
    `/api/v1/models/res.users?fields=login&filter=${encodeURIComponent(JSON.stringify({ login: 'dina' }))}`,
  );
  const [me] = ((await users.json()) as { items: { id: number }[] }).items;
  const stamp = Date.now();
  const site = await post('/api/v1/models/website.site', {
    name: `E2E chat site ${stamp}`,
    key: `e2e-chat-${stamp}`,
  });
  const delivery = await post('/api/v1/models/website.page', {
    site,
    path: '/delivery',
    title: 'Delivery',
    blocks: { create: [{ kind: 'text', body: 'We deliver within two working days.' }] },
  });
  await post(`/api/v1/models/website.page/${delivery}/transitions/publish`, {});
  const name = `E2E assisted chat ${stamp}`;
  const channel = await post('/api/v1/models/livechat.channel', {
    name,
    operators: { set: [me?.id] },
    assignment: 'turn',
    limit: 5,
    assistant: true,
    assistantSite: site,
    assistantName: 'Padma',
  });
  // The channel's form shows who answers first.
  await page.goto(`/livechat/a/livechat.action_channels/${channel}`);
  await expect(page.getByText('The assistant answers first')).toBeVisible();
  const record = await page.request.get(`/api/v1/models/livechat.channel/${channel}?fields=link`);
  const link = ((await record.json()) as { link: string }).link;

  await page.goto('/livechat/a/livechat.action_inbox');
  const away = page.getByRole('button', { name: 'Not taking conversations' });
  if (await away.isVisible().catch(() => false)) await away.click();
  await expect(page.getByRole('button', { name: 'Taking conversations' })).toBeVisible();

  const visitor = await browser.newContext();
  const chat = await visitor.newPage();
  await chat.goto(new URL(link, page.url()).toString());
  const who = `Asker ${stamp}`;
  await chat.getByRole('textbox', { name: 'Your name' }).fill(who);
  await chat.getByRole('textbox', { name: 'Your message' }).fill('Do you deliver?');
  await chat.getByRole('button', { name: 'Start the chat' }).click();
  // The assistant answers from the site's page, under a name that says what it is; nobody has joined.
  const log = chat.getByRole('log');
  await expect(log).toContainText('Yes — within two working days.');
  await expect(log).toContainText('Padma · AI');
  await expect(log).not.toContainText('joined');
  // What the pages do not say: it says so, and the operator has the conversation.
  const say = chat.getByRole('textbox', { name: 'Your message' });
  await say.fill('Where is my order 4411?');
  await say.press('Enter');
  await expect(log).toContainText('A person of the team will answer here.');
  await expect(log).toContainText('joined.');
  await expect(chat.getByRole('status').first()).toContainText('You are talking with');
  // In the operator's inbox, theirs, with what the assistant said before them.
  await page.getByRole('button', { name: `Open the conversation with ${who}` }).click();
  const theirs = page.getByRole('log', { name: `Conversation with ${who}` });
  await expect(theirs).toContainText('Padma · AI');
  await expect(theirs).toContainText('Where is my order 4411?');
  const reply = page.getByRole('textbox', { name: 'Your reply' });
  await reply.fill('It left this morning.');
  await reply.press('Enter');
  await expect(log).toContainText('It left this morning.');
  await chat.getByRole('button', { name: 'End the chat' }).click();
  await visitor.close();
});

test('the Live chat overview', async ({ page }) => {
  await signIn(page, 'dina');
  await page.goto('/livechat/a/livechat.action_overview');
  await expect(page.getByText('Waiting now')).toBeVisible();
  await expect(page.getByText('Average wait (seconds)')).toBeVisible();
});
