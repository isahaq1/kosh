/**
 * Accessibility (CLAUDE.md: keyboard and screen reader; RFC 0007 §5 axe checks): no serious or critical axe
 * violations on the sign-in page, launcher, list, kanban and form, in light and dark themes.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { signIn } from './support.js';

async function check(page: Page, where: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious.map((v) => `${where}: ${v.id} (${v.nodes.length}) ${v.help}`)).toEqual([]);
}

test('sign-in page', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await check(page, 'login');
});

for (const theme of ['Light', 'Dark'] as const)
  test(`launcher, list, kanban and form (${theme})`, async ({ page }) => {
    await signIn(page, 'dina');
    await page.getByRole('button', { name: 'Theme' }).click();
    await page.getByRole('menuitemcheckbox', { name: theme }).click();
    await page.keyboard.press('Escape');
    await check(page, `launcher ${theme}`);
    await page.goto('/contacts/a/contacts.action_partners');
    await expect(page.getByRole('row').nth(1)).toBeVisible();
    await check(page, `list ${theme}`);
    await page.goto('/contacts/a/contacts.action_partners?view=kanban');
    await expect(page.getByRole('region', { name: 'Lead' })).toBeVisible();
    await check(page, `kanban ${theme}`);
    await page.goto('/contacts/a/contacts.action_partners');
    await page.getByRole('row').nth(1).click();
    await expect(page.getByRole('form')).toBeVisible();
    await check(page, `form ${theme}`);
  });

test('keyboard: open a record from the list with Enter, back with the back button', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/contacts/a/contacts.action_partners');
  const first = page.getByRole('row').nth(1);
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('form')).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('row').nth(1)).toBeVisible();
});
