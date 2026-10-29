/**
 * RFC 0019 step 1 end to end: Settings opens on its overview, whose search finds a section by its words; your
 * profile from the user menu — details saved, this device among the signed-in ones, two-factor sign-in set up with
 * the key shown (recovery codes once) and turned off again. People, Roles; the company's details, and Companies:
 * a new company, switched to and back. Security: two-factor sign-in asked of everyone (set up before anything
 * else), a session signed out by an administrator, the audit log filtered and exported.
 */
import { totp } from '@kosh/server';
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

test('Settings opens on its overview; its search finds a section by its words', async ({
  page,
}) => {
  await signIn(page, 'admin');
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
  await page.getByLabel('Search settings').fill('lakh');
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: /^Company/ })).toBeVisible();
  await expect(main.getByRole('link', { name: /^App manager/ })).toHaveCount(0);
  await main.getByRole('link', { name: /^Company/ }).click();
  await expect(page.getByRole('heading', { name: 'Company', level: 1 })).toBeVisible();
});

test('your profile: details saved, this device listed, two-factor on and off', async ({ page }) => {
  await signIn(page, 'rahim');
  await page.getByRole('button', { name: 'Rahim Uddin' }).click();
  await page.getByRole('menuitem', { name: 'Your profile' }).click();
  await expect(page.getByRole('heading', { name: 'Your profile', level: 1 })).toBeVisible();

  await page.getByLabel('Phone').fill('+880 1711 223344');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Phone')).toHaveValue('+880 1711 223344');

  const devices = page.getByRole('region', { name: 'Signed-in devices' });
  await expect(devices.getByText('This device')).toBeVisible();

  const twoFactor = page.getByRole('region', { name: 'Two-factor sign-in' });
  await twoFactor.getByRole('button', { name: 'Set up' }).click();
  const secret = ((await twoFactor.locator('code').textContent()) ?? '').trim();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await twoFactor.getByLabel('Code').fill(totp(secret));
  await twoFactor.getByRole('button', { name: 'Turn on' }).click();
  await expect(twoFactor.getByText(/Your recovery codes/)).toBeVisible();
  await expect(twoFactor.getByText('On', { exact: true })).toBeVisible();

  await twoFactor.locator('summary').click();
  await twoFactor.getByLabel('Password').fill('correct horse battery');
  await twoFactor.getByLabel('Code').fill(totp(secret));
  await twoFactor.getByRole('button', { name: 'Turn off two-factor sign-in' }).click();
  await expect(twoFactor.getByText('Off', { exact: true })).toBeVisible();
});

test('People: invited with a role, the link opens the password page, then deactivated', async ({
  page,
  browser,
}) => {
  await signIn(page, 'admin');
  await page.goto('/settings/a/settings.action_people');
  await expect(page.getByRole('heading', { name: 'People', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite someone' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Mina Sultana');
  await dialog.getByRole('textbox', { name: 'Email' }).fill('mina@example.test');
  await dialog.getByRole('combobox', { name: 'Contacts' }).click();
  await page.getByRole('option', { name: 'User' }).click();
  await dialog.getByRole('button', { name: 'Send the invitation' }).click();
  const link = ((await dialog.getByTestId('invitation-link').textContent()) ?? '').trim();
  expect(link).toMatch(/\/activate\?token=/);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: /Mina Sultana/ })).toContainText('Invited');

  // Mina, in her own browser: the link, a password, and she is in — with Contacts only.
  const minaContext = await browser.newContext();
  const mina = await minaContext.newPage();
  const url = new URL(link);
  await mina.goto(`${url.pathname}${url.search}`);
  await expect(mina.getByRole('heading', { name: 'Choose your password' })).toBeVisible();
  await mina.getByLabel('Password', { exact: true }).fill('a long new password');
  await mina.getByLabel('Repeat the password').fill('a long new password');
  await mina.getByRole('button', { name: 'Save and sign in' }).click();
  await expect(mina.getByRole('heading', { name: 'Apps' })).toBeVisible();
  await expect(mina.getByRole('main').getByRole('link')).toHaveText([/^Contacts/]);
  await minaContext.close();

  await page.reload();
  await page.getByRole('button', { name: /Mina Sultana/ }).click();
  const person = page.getByRole('dialog', { name: 'Mina Sultana' });
  await expect(person.getByText('Active', { exact: true })).toBeVisible();
  await person.getByRole('button', { name: 'Deactivate' }).click();
  await person.getByRole('button', { name: 'Deactivate' }).last().click();
  await expect(person.getByText('Deactivated', { exact: true })).toBeVisible();
});

test('Roles: a new role opens Contacts; the preview names who gains what before saving', async ({
  page,
}) => {
  await signIn(page, 'admin');
  await page.goto('/settings/a/settings.action_roles');
  await expect(page.getByRole('heading', { name: 'Roles & permissions', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New role' }).click();
  const create = page.getByRole('dialog', { name: 'A new role' });
  await create.getByRole('textbox', { name: 'Name' }).fill('Front desk');
  await expect(create.getByText('company.front_desk')).toBeVisible();
  await create.getByRole('button', { name: 'Create' }).click();

  const role = page.getByRole('dialog', { name: 'Front desk' });
  await role.getByRole('combobox', { name: 'Contacts' }).click();
  await page.getByRole('option', { name: 'User' }).click();
  await role.getByRole('button', { name: 'Review the changes' }).click();
  await expect(role.getByRole('region', { name: 'What saving changes' })).toContainText(
    'No one holds this role yet',
  );
  await role.getByRole('button', { name: 'Save' }).click();
  await expect(role.getByText(/^Saved/)).toBeVisible();
  await page.keyboard.press('Escape');

  // Given to Bob in People, the role's next change is previewed for him.
  await page.goto('/settings/a/settings.action_people');
  await page.getByRole('button', { name: /Bob/ }).click();
  const bob = page.getByRole('dialog', { name: /Bob/ });
  await bob.getByLabel('Front desk').click();
  await bob.getByRole('button', { name: 'Save the roles' }).click();
  await expect(bob.getByText('Front desk').first()).toBeVisible();
  await bob.getByText('What can they do?').click();
  await expect(bob.getByText('Contact', { exact: false }).first()).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto('/settings/a/settings.action_roles');
  await page.getByRole('button', { name: /Front desk/ }).click();
  const again = page.getByRole('dialog', { name: 'Front desk' });
  await again.getByRole('combobox', { name: 'Contacts' }).click();
  await page.getByRole('option', { name: 'Manager' }).click();
  await again.getByRole('button', { name: 'Review the changes' }).click();
  await expect(again.getByRole('region', { name: 'What saving changes' })).toContainText(
    /gains .*Manager/,
  );
  await again.getByRole('button', { name: 'Keep editing' }).click();

  // Deleting the role takes it from Bob again (other tests expect him without roles).
  await again.getByRole('button', { name: 'Delete the role' }).click();
  await expect(again.getByText('Deleting it takes it from 1 people.')).toBeVisible();
  await again.getByRole('button', { name: 'Delete the role' }).last().click();
  await expect(page.getByRole('button', { name: /Front desk/ })).toHaveCount(0);
});

test('Company details saved; Companies: a new company, switched to and back', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/settings/a/settings.action_company');
  await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();
  await page.getByLabel('City', { exact: true }).fill('Chattogram');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/^Saved: everyone/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('City', { exact: true })).toHaveValue('Chattogram');

  await page.goto('/settings/a/settings.action_companies');
  await expect(page.getByRole('heading', { name: 'Companies', level: 1 })).toBeVisible();
  await expect(page.getByText('Current')).toBeVisible();
  await page.getByRole('button', { name: 'New company' }).click();
  const dialog = page.getByRole('dialog', { name: 'A new company' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Karnaphuli Traders');
  await dialog.getByRole('combobox', { name: 'Currency' }).click();
  await page.getByRole('option', { name: 'BDT' }).click();
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole('button', { name: 'Switch to Karnaphuli Traders' }).click();
  await expect(page.getByRole('button', { name: /Karnaphuli Traders/ }).first()).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Karnaphuli Traders' })).toContainText(
    'Current',
  );
  await page.getByRole('button', { name: 'Switch to Dhaka Ltd' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Dhaka Ltd' })).toContainText(
    'Current',
  );
});

test('Security: two-factor for everyone — set up before anything else; sessions signed out; the audit log', async ({
  page,
  browser,
}) => {
  await signIn(page, 'admin');
  const choose = async (label: string) => {
    await page.goto('/settings/a/settings.action_security');
    await page.getByRole('radio', { name: new RegExp(`^${label}`) }).check();
  };
  await choose('Everyone');
  await expect(page.getByText(/have no two-factor sign-in yet \(.*Tariq Hasan/)).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved: it applies from now on.')).toBeVisible();

  const other = await browser.newContext();
  const tariq = await other.newPage();
  try {
    await tariq.goto('/login');
    await tariq.getByLabel('Login').fill('tariq');
    await tariq.getByLabel('Password').fill('correct horse battery');
    await tariq.getByRole('button', { name: 'Sign in' }).click();
    await expect(
      tariq.getByRole('heading', { name: 'Set up two-factor sign-in', level: 1 }),
    ).toBeVisible();
    await tariq.getByRole('button', { name: 'Set it up' }).click();
    const key = ((await tariq.getByTestId('two-factor-key').textContent()) ?? '').trim();
    await tariq.getByLabel('Authentication code').fill(totp(key));
    await tariq.getByRole('button', { name: 'Turn on and continue' }).click();
    await expect(tariq.getByText(/Keep these recovery codes/)).toBeVisible();
    await tariq.getByRole('button', { name: 'Continue' }).click();
    await expect(tariq.getByRole('heading', { name: 'Apps' })).toBeVisible();
  } finally {
    // Back to the default: the other tests sign in without a second factor.
    await choose('Administrators only');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved: it applies from now on.')).toBeVisible();
  }

  // Tariq's device among the signed-in ones; signed out from here.
  await page.reload();
  const devices = page.getByRole('region', { name: 'Signed-in devices' });
  await devices.getByLabel('Search by person or address').fill('Tariq');
  await devices
    .getByRole('button', { name: /^Sign Tariq Hasan out of/ })
    .first()
    .click();
  await expect(devices.getByText('No signed-in devices match.')).toBeVisible();
  await tariq.reload();
  await expect(tariq).toHaveURL(/\/login/);
  await other.close();

  // The audit log: the policy changes, filtered by kind, exported.
  await page.goto('/settings/a/settings.action_audit');
  await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: 'Kind' }).click();
  await page.getByRole('option', { name: 'Security and permissions' }).click();
  await expect(page.getByText(/Signed out a session of tariq/)).toBeVisible();
  await expect(page.getByText(/twoFactor = everyone/).first()).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect((await download).suggestedFilename()).toBe('audit-log.csv');
});

test('a profile photo and a company logo: chosen, made small, shown in the corner and the sidebar', async ({
  page,
}) => {
  // A 64×64 PNG drawn by the browser itself.
  await signIn(page, 'admin');
  const png = Buffer.from(
    (
      await page.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 64;
        const ctx = c.getContext('2d') as CanvasRenderingContext2D;
        ctx.fillStyle = '#0d9488';
        ctx.fillRect(0, 0, 64, 64);
        return c.toDataURL('image/png');
      })
    ).split(',')[1] as string,
    'base64',
  );
  await page.goto('/me/settings.Profile');
  const photo = page.getByRole('region', { name: 'Photo' });
  await photo.locator('input[type=file]').setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(photo.getByRole('button', { name: 'Remove' })).toBeVisible();
  await expect(page.locator('[data-kosh-account] img')).toHaveAttribute(
    'src',
    /\/api\/v1\/images\/user\/\d+\?v=/,
  );

  await page.goto('/settings/a/settings.action_company');
  await page.locator('input[type=file]').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: png,
  });
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  await expect(sidebar.locator('img[src*="/api/v1/images/company/"]')).toBeVisible();
  // Back to none: the other tests' screenshots and checks stay as they were.
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(sidebar.locator('img[src*="/api/v1/images/company/"]')).toHaveCount(0);
  await page.goto('/me/settings.Profile');
  await page.getByRole('region', { name: 'Photo' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('[data-kosh-account] img')).toHaveCount(0);
});
