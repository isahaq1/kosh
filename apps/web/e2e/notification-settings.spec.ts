/**
 * Notification settings (RFC 0006 part 8): from the bell, a user sets quiet hours, a day off, the digest hour and
 * the fallback channel, sends mentions by email in the daily summary and switches their push off; everything is
 * kept (the server says so after a reload). The dialog passes axe in light and dark themes, and reads in Bangla.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { choose, signIn } from './support.js';

/** The bell is named "Notifications", or "3 unread notifications" when some are unread (earlier specs). */
async function openSettings(
  page: Page,
  bell: RegExp = /^(Notifications|\d+ unread notifications?)$/,
  settings = 'Notification settings',
) {
  // The bell is in an app's page bar (the home page has only the account menu).
  if (!page.url().includes('/a/')) await page.goto('/contacts/a/contacts.action_partners');
  await page.getByRole('button', { name: bell }).click();
  await page.getByRole('button', { name: settings }).click();
  return page.getByRole('dialog', { name: settings });
}

test('quiet hours, a day off, the digest hour, the fallback and the email mode are kept', async ({
  page,
}) => {
  await signIn(page, 'maria');
  const dialog = await openSettings(page);
  await expect(dialog.getByText('Times are in your time zone (UTC).')).toBeVisible();

  await dialog.getByRole('checkbox', { name: 'Quiet hours every day' }).click();
  await expect(dialog.getByLabel('From')).toHaveValue('22:00');
  await dialog.getByLabel('Until').fill('06:30');
  await dialog.getByRole('checkbox', { name: 'Fri' }).click();
  await dialog.getByLabel('Send the daily summary at').fill('09:15');
  await dialog.getByRole('combobox', { name: 'When a channel cannot reach you, use' }).click();
  await page.getByRole('option', { name: 'Push' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Saved');

  // Per kind: mentions by email in the daily summary, and no push for them.
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/notifications/preferences') && r.request().method() === 'PUT',
  );
  await dialog.getByRole('combobox', { name: 'Mentions: Email' }).click();
  await page.getByRole('option', { name: 'Daily summary' }).click();
  expect((await saved).ok()).toBe(true);
  await dialog.getByRole('checkbox', { name: 'Mentions: Push' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Mentions: Push' })).not.toBeChecked();

  // The server kept it all.
  const settings = await (await page.request.get('/api/v1/notifications/settings')).json();
  expect(settings).toMatchObject({
    quietFrom: '22:00',
    quietTo: '06:30',
    quietDays: ['fri'],
    digestHour: '09:15',
    fallback: 'webpush',
  });
  const prefs = (await (await page.request.get('/api/v1/notifications/preferences')).json()) as {
    kinds: { kind: string; emailMode: string; channels: Record<string, boolean> }[];
  };
  expect(prefs.kinds.find((k) => k.kind === 'mention')).toMatchObject({
    emailMode: 'daily',
    channels: { webpush: false, inapp: true },
  });

  // After a reload the dialog shows what the server has.
  await page.reload();
  const again = await openSettings(page);
  await expect(again.getByLabel('Until')).toHaveValue('06:30');
  await expect(again.getByRole('checkbox', { name: 'Fri' })).toBeChecked();
  await expect(
    again.getByRole('combobox', { name: 'When a channel cannot reach you, use' }),
  ).toContainText('Push');
  await expect(again.getByRole('combobox', { name: 'Mentions: Email' })).toContainText(
    'Daily summary',
  );
});

for (const theme of ['Light', 'Dark'] as const)
  test(`the settings dialog passes axe (${theme}) and reads in Bangla`, async ({ page }) => {
    await signIn(page, 'rahim');
    await choose(page, 'Theme', theme);
    const dialog = await openSettings(page);
    await expect(dialog.getByRole('checkbox', { name: 'Mentions: Bell' })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(serious.map((v) => `${v.id} (${v.nodes.length}) ${v.help}`)).toEqual([]);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Language' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'বাংলা' }).click();
    const bangla = await openSettings(page, /^(বিজ্ঞপ্তি|\d+টি অপঠিত বিজ্ঞপ্তি)$/, 'বিজ্ঞপ্তি সেটিংস');
    await expect(bangla.getByText('নীরব সময়', { exact: true })).toBeVisible();
    await expect(bangla.getByRole('checkbox', { name: 'উল্লেখ: পুশ' })).toBeVisible();
  });
