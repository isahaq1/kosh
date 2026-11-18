/**
 * Directory provisioning on screen (RFC 0034 §2.4): an Administrator makes a directory's token in Settings ›
 * Security and sees it once; the directory provisions a person and a group with it; the Administrator says which
 * role the group gives — an Administrator's is refused in the server's words —; the token revoked, the directory is
 * refused. (The protocol itself is proved on the server: `packages/server/test/scim…`.)
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

test('an Administrator makes a token, the directory provisions, a group gives a role, the token is revoked', async ({
  page,
  request,
}) => {
  await signIn(page, 'admin');
  await page.goto('/settings/a/settings.action_security');
  const section = page.getByRole('region', { name: 'Directory provisioning' });
  await expect(section).toBeVisible();
  await expect(section).toContainText('/api/scim/v2');

  const stamp = Date.now();
  const directory = `E2E directory ${stamp}`;
  const form = section.getByRole('form', { name: 'Make a token' });
  await form.getByLabel('Name of the directory').fill(directory);
  await form.getByRole('button', { name: 'Make the token' }).click();
  const shown = section.getByRole('status').filter({ hasText: `The token of ${directory}` });
  await expect(shown).toContainText('it is not shown again');
  const token = (await shown.locator('code').innerText()).trim();
  expect(token).toMatch(/^scim_/);
  const row = section
    .getByRole('list', { name: 'Tokens' })
    .getByRole('listitem')
    .filter({ hasText: directory });
  await expect(row).toContainText('never used');

  // The directory, with its token: a person, and a group they are in.
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' };
  const base = new URL('/api/scim/v2', page.url()).toString();
  const person = await request.post(`${base}/Users`, {
    headers,
    data: JSON.stringify({ userName: `scim-${stamp}@padma.test`, displayName: 'Scim Person' }),
  });
  expect(person.status(), await person.text()).toBe(201);
  const group = `E2E group ${stamp}`;
  const made = await request.post(`${base}/Groups`, {
    headers,
    data: JSON.stringify({
      displayName: group,
      members: [{ value: (await person.json()).id }],
    }),
  });
  expect(made.status(), await made.text()).toBe(201);

  try {
    await page.reload();
    const groups = page
      .getByRole('region', { name: 'Directory provisioning' })
      .getByRole('list', { name: 'Roles from the directory’s groups' });
    const item = groups.getByRole('listitem').filter({ hasText: group });
    await expect(item).toContainText('1 member');
    const roles = item.getByLabel('Roles it gives (codes, separated by commas)');
    await roles.fill('base.admin');
    await item.getByRole('button', { name: 'Save the roles' }).click();
    await expect(item.getByRole('alert')).toContainText('is an Administrator role');
    await roles.fill('settings.people');
    await item.getByRole('button', { name: 'Save the roles' }).click();
    await expect(item.getByRole('status')).toContainText('the roles of 1 person changed');
  } finally {
    // The directory takes its group and its person back, then loses its token.
    await request.delete(`${base}/Groups/${(await made.json()).id}`, { headers });
    await request.delete(`${base}/Users/${(await person.json()).id}`, { headers });
    const again = page.getByRole('region', { name: 'Directory provisioning' });
    await again
      .getByRole('list', { name: 'Tokens' })
      .getByRole('listitem')
      .filter({ hasText: directory })
      .getByRole('button', { name: 'Revoke' })
      .click();
    await expect(again.getByRole('listitem').filter({ hasText: directory })).toHaveCount(0);
  }
  const refused = await request.get(`${base}/Users`, { headers });
  expect(refused.status()).toBe(401);
});
