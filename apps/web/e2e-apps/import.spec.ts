/**
 * The import screen (RFC 0014 §5.8) on the apps server: a CSV of contacts is read, its columns are matched to the
 * fields, a check finds the error on its row, the fixed file imports, the new contacts are in the list, and undo
 * takes them away again.
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

const csv = (rows: readonly string[]) => ({
  name: 'contacts.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from(['Name,Email,City,Customer', ...rows].join('\n'), 'utf8'),
});

test('a CSV of contacts: columns matched, an error found on its row, the fixed file imported, then undone', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/contacts/a/contacts.action_partners');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import records' });

  // A file with an email the contacts refuse.
  await dialog
    .getByLabel('CSV or Excel file')
    .setInputFiles(
      csv([
        'Meghna Foods,orders@meghna.example,Narayanganj,yes',
        'Surma Tea,not-an-email,Sylhet,yes',
      ]),
    );
  await dialog.getByRole('button', { name: 'Read the file' }).click();
  await expect(dialog.getByText('contacts.csv · 2 rows')).toBeVisible();
  // The headers are the fields' labels: each column found its field.
  await expect(dialog.getByRole('combobox', { name: 'Field: Name' })).toHaveText(/^Name/);
  await expect(dialog.getByRole('combobox', { name: 'Field: Email' })).toHaveText('Email');
  await expect(dialog.getByRole('combobox', { name: 'Field: Customer' })).toHaveText('Customer');
  await dialog.getByRole('button', { name: 'Check' }).click();
  await expect(dialog.getByText('Check finished: 1 to create, 0 to update.')).toBeVisible();
  const error = dialog.getByRole('row').filter({ hasText: 'name@example.com' });
  await expect(error).toContainText('3'); // the row of the file
  await dialog.getByRole('button', { name: 'Import another file' }).click();

  // The fixed file.
  await dialog
    .getByLabel('CSV or Excel file')
    .setInputFiles(
      csv([
        'Meghna Foods,orders@meghna.example,Narayanganj,yes',
        'Surma Tea,sales@surma.example,Sylhet,yes',
      ]),
    );
  await dialog.getByRole('button', { name: 'Read the file' }).click();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByText('Imported: 2 created, 0 updated.')).toBeVisible();
  await expect(dialog.getByText('No errors.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('cell', { name: 'Surma Tea', exact: true })).toBeVisible();

  // Undo, from the screen of that import.
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await dialog
    .getByLabel('CSV or Excel file')
    .setInputFiles(csv(['Padma Fisheries,hello@padma.example,Rajshahi,yes']));
  await dialog.getByRole('button', { name: 'Read the file' }).click();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByText('Imported: 1 created, 0 updated.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Undo this import' }).click();
  await expect(dialog.getByText('Undone: 1 deleted, 0 restored.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('cell', { name: 'Surma Tea', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Padma Fisheries', exact: true })).toHaveCount(0);
});
