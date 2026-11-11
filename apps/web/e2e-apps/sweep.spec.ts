/**
 * Every menu of every app opens without an error screen. The page that crashed on the Sales overview
 * ("Something went wrong! value.map is not a function") passed every other test, because none opened it with
 * data; this sweep opens each menu's action — and, where the view has rows, the first record's form — as a user
 * who holds the apps, and fails on the router's error screen, an uncaught page error or a server 5xx.
 */
import { expect, type Page, test } from '@playwright/test';

const PASSWORD = 'correct horse battery';

interface MenuNode {
  readonly id: string;
  readonly label: string;
  readonly action?: string;
  readonly children: readonly MenuNode[];
}

async function signIn(page: Page, login: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
}

const flatten = (nodes: readonly MenuNode[]): MenuNode[] =>
  nodes.flatMap((n) => [n, ...flatten(n.children)]);

test('every menu of every app opens without an error screen', async ({ page }) => {
  test.setTimeout(900_000);
  await signIn(page, 'dina');
  const crashes: string[] = [];
  let where = '';
  page.on('pageerror', (error) => crashes.push(`${where}: uncaught ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 500) crashes.push(`${where}: ${response.status()} ${response.url()}`);
  });

  const apps = (
    (await (await page.request.get('/api/v1/apps')).json()) as { apps: { code: string }[] }
  ).apps;
  expect(apps.length).toBeGreaterThan(10);
  let opened = 0;
  for (const app of apps) {
    const menus = (
      (await (await page.request.get(`/api/v1/menus?app=${app.code}`)).json()) as {
        menus: MenuNode[];
      }
    ).menus;
    for (const menu of flatten(menus)) {
      if (menu.action === undefined) continue;
      where = `${app.code} › ${menu.label} (${menu.action})`;
      await page.goto(`/${app.code}/a/${menu.action}`);
      // The page settles: the shell's main region is there, and no request is still loading the view.
      await expect(page.getByRole('main')).toBeVisible();
      await page.waitForLoadState('networkidle');
      if ((await page.getByText(/Something went wrong/i).count()) > 0) {
        const detail = (await page.getByRole('main').innerText())
          .slice(0, 200)
          .replace(/\s+/g, ' ');
        crashes.push(`${where}: error screen — ${detail}`);
      }
      opened += 1;
    }
  }
  expect(opened).toBeGreaterThan(100);
  expect(crashes, crashes.join('\n')).toEqual([]);
});
