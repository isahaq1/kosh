/**
 * The automation builder end to end (RFC 0011): a manager makes a rule in the editor (a model, a trigger, an
 * action with a template), tests it on a record without running it, runs the pending changes, and sees the run
 * in the log and the note on the record's chatter.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

const RULES = '/automation/a/automation.action_rules';

test('a rule made in the editor fires on a new contact: dry run, run now, the log, the note', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto(RULES);
  await page.getByRole('button', { name: 'New' }).click();
  await expect(page.getByRole('heading', { name: 'New rule' })).toBeVisible();
  await page.getByLabel('Name').fill('Welcome note');
  await page.getByRole('combobox', { name: 'Model' }).click();
  await page.getByRole('option', { name: 'res.partner', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Trigger' })).toContainText(
    'A record is created',
  );
  await page.getByRole('button', { name: 'Add an action' }).click();
  const action = page.getByRole('listitem', { name: /1\. / });
  await action.getByRole('combobox', { name: 'Action' }).click();
  await page.getByRole('option', { name: 'Post a note' }).click();
  await action.getByLabel('Text').fill('Welcome, {{name}} from {{city}}!');
  await page.getByRole('combobox', { name: 'Run as' }).click();
  await page.getByRole('option', { name: 'The system' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  // Saved: the editor reopens on the record (its heading is the name).
  await expect(page.getByRole('heading', { name: 'Welcome note' })).toBeVisible();

  // A dry run on an existing contact: nothing runs, the rendered action is shown.
  const test = page.getByRole('region', { name: 'Test on a record' });
  await test.getByRole('combobox', { name: 'Search a record…' }).fill('Acme');
  await test.getByRole('option', { name: 'Acme Trading' }).click();
  await test.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(test.getByText('The record matches the condition')).toBeVisible();
  await expect(test.getByText('Welcome, Acme Trading from Dhaka!')).toBeVisible();

  // A new contact, then "run pending changes now": the rule posts its note.
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const created = await page.request.post('/api/v1/models/res.partner', {
    headers: { 'x-csrf-token': csrf ?? '' },
    data: { name: 'Khulna Shipyard', city: 'Khulna' },
  });
  expect(created.ok()).toBe(true);
  const partner = (await created.json()) as { id: number };
  await page.getByRole('button', { name: 'Run pending changes now' }).click();
  await expect(page.getByText(/Checked \d+ change\(s\), 1 run\(s\)\./)).toBeVisible();
  const chatter = await page.request.get(`/api/v1/chatter/res.partner/${partner.id}`);
  const items = ((await chatter.json()) as { items: { type: string; body?: string }[] }).items;
  expect(items.find((i) => i.type === 'message')?.body).toBe(
    '<p>Welcome, Khulna Shipyard from Khulna!</p>',
  );

  // The run log.
  await page.goto('/automation/a/automation.action_runs');
  const row = page.getByRole('row', { name: /Welcome note/ }).first();
  await expect(row).toContainText('Done');
  await expect(row).toContainText('res.partner');

  // The other specs count the contacts: the new one goes, and the rule rests.
  expect(
    (
      await page.request.delete(`/api/v1/models/res.partner/${partner.id}`, {
        headers: { 'x-csrf-token': csrf ?? '' },
      })
    ).ok(),
  ).toBe(true);
  const rules = (await (
    await page.request.get('/api/v1/models/automation.rule?fields=id')
  ).json()) as { items: { id: number }[] };
  for (const r of rules.items)
    expect(
      (
        await page.request.patch(`/api/v1/models/automation.rule/${r.id}`, {
          headers: { 'x-csrf-token': csrf ?? '' },
          data: { enabled: false },
        })
      ).ok(),
    ).toBe(true);
});
