/**
 * RFC 0019 step 1 end to end: Settings opens on its overview, whose search finds a section by its words; your
 * profile from the user menu — details saved, this device among the signed-in ones, two-factor sign-in set up with
 * the key shown (recovery codes once) and turned off again.
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
