/**
 * Kosh Studio end to end (RFC 0012 step 4): a Studio manager turns on Studio mode on a contact, adds a field to a
 * form section, reviews the change (a new module, the SQL), applies it and fills the new field; then adds a column
 * the model has to the list (an upgrade, no SQL). A user without Studio sees no Studio button and is refused by the
 * server.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support.js';

const CONTACTS = '/contacts/a/contacts.action_partners';

test('Studio mode: add a field to a form section, apply, fill it; add a column to the list', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto(CONTACTS);
  await page
    .getByRole('row', { name: /Acme Trading/ })
    .getByText('Acme Trading')
    .click();
  await expect(page.getByRole('heading', { name: 'Acme Trading' })).toBeVisible();

  const toggle = page.getByRole('button', { name: 'Studio', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Add field' }).first().click();
  const add = page.getByRole('dialog', { name: 'Add a field to the form' });
  await add.getByLabel('Label').fill('GST number');
  await add.getByRole('checkbox', { name: /Track changes/ }).click();
  await add.getByRole('button', { name: 'Review changes' }).click();

  const review = page.getByRole('dialog', { name: /Review: Customizations 0\.1\.0/ });
  await expect(review.getByText('Installs the module custom.')).toBeVisible();
  await expect(
    review.getByRole('region', { name: 'src/modules/custom/studio.json' }),
  ).toBeVisible();
  await review.getByRole('tab', { name: /Database/ }).click();
  await expect(review.getByText(/ADD COLUMN "x_custom_gst_number"/)).toBeVisible();
  await review.getByRole('button', { name: 'Apply' }).click();
  await expect(review.getByText('custom 0.1.0 applied. Reloading…')).toBeVisible();

  // The page reloads with the served views: the field is on the form.
  const gst = page.getByLabel('GST number');
  await expect(gst).toBeVisible({ timeout: 15_000 });
  await gst.fill('29ABCDE1234F1Z5');
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/v1/models/res.partner/') && r.request().method() !== 'GET',
  );
  await page.getByRole('button', { name: 'Save' }).click();
  const response = await saved;
  expect(response.status(), await response.text()).toBeLessThan(300);
  await page.reload();
  await expect(page.getByLabel('GST number')).toHaveValue('29ABCDE1234F1Z5');

  // A column the model has, on the list: an upgrade without database changes.
  await page.goto(CONTACTS);
  await expect(page.getByRole('columnheader', { name: 'Phone' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Studio', exact: true }).click();
  await page.getByRole('button', { name: 'Add column' }).click();
  const column = page.getByRole('dialog', { name: 'Add a column' });
  await expect(column.getByRole('combobox', { name: 'Save in module' })).toContainText(
    'Customizations (custom)',
  );
  await column.getByRole('combobox', { name: 'Field' }).click();
  await page.getByRole('option', { name: 'Phone', exact: true }).click();
  await column.getByRole('button', { name: 'Review changes' }).click();
  const upgrade = page.getByRole('dialog', { name: /Review: Customizations 0\.1\.1/ });
  await expect(upgrade.getByText('Upgrades custom from 0.1.0 to 0.1.1.')).toBeVisible();
  await upgrade.getByRole('tab', { name: /Database/ }).click();
  await expect(upgrade.getByText('No database change.')).toBeVisible();
  await upgrade.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('columnheader', { name: 'Phone' })).toBeVisible({ timeout: 15_000 });

  // The Studio app lists the module.
  await page.goto('/studio/a/studio.action_studio');
  await expect(page.getByText('Write mode: changes are applied on this server.')).toBeVisible();
  await expect(page.getByText('version 0.1.1')).toBeVisible();
});

test('without Studio: no Studio button, and the server refuses', async ({ page }) => {
  await signIn(page, 'rahim');
  await page.goto(CONTACTS);
  await expect(page.getByRole('row', { name: /Acme Trading/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Studio', exact: true })).toHaveCount(0);
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const refused = await page.request.post('/api/v1/studio/edit', {
    headers: { 'x-csrf-token': csrf ?? '' },
    data: {
      edit: {
        kind: 'show',
        view: 'res.partner.list',
        field: 'phone',
        anchor: { insertAfter: 'stage' },
      },
    },
  });
  expect(refused.status()).toBe(403);
});
