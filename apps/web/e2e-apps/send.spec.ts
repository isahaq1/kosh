/**
 * Sending a document by email (RFC 0029 §3.3): Send on a sales order opens the dialog with the template's subject
 * and the PDF (a customer without an address is said so); the edited message is sent and lands on the chatter with
 * the PDF.
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

test('a sales order sent by email: the dialog filled from the template, the message on the chatter', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await signIn(page, 'dina');
  await page.goto('/sales/a/sales.action_orders');
  await page
    .getByRole('row', { name: /Bengal Steel/ })
    .first()
    .click();
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toContainText('SO/');
  const name = ((await heading.textContent()) ?? '').match(/SO\/\d+\/\d+/)?.[0] ?? '';

  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Send by email' });
  await expect(dialog).toBeVisible();
  // The customer has no address yet: the dialog says so, and one is typed.
  await expect(dialog.getByText(/has no email address/)).toBeVisible();
  await dialog.getByLabel('To').fill('orders@bengalsteel.example');
  await expect(dialog.getByLabel('Subject')).toHaveValue(new RegExp(name.replaceAll('/', '\\/')));
  await expect(dialog.getByText(`${name.replaceAll('/', '-')}.pdf`)).toBeVisible();
  await dialog.getByLabel('Message').fill('Dear Bengal Steel,\n\nYour order is attached.');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole('status').filter({ hasText: 'Sent:' })).toBeVisible();
  await expect(page.getByText('Your order is attached.').first()).toBeVisible();
  await expect(page.getByText(`${name.replaceAll('/', '-')}.pdf`).first()).toBeVisible();
});

test('documents sent from a list: the selection sent at once, the ones without an address said so', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/sales/a/sales.action_orders');
  const rows = page.getByRole('row', { name: /Bengal Steel/ });
  await rows.first().getByRole('checkbox').check();
  const bar = page.getByRole('toolbar', { name: /selected/ });
  await bar.getByRole('button', { name: 'Send by email' }).click();
  const dialog = page.getByRole('dialog', { name: /Send 1 documents by email/ });
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  // Bengal Steel has no address: nothing is sent, and the reason is given.
  await expect(
    page.getByText('0 sent by email. 1 not sent: Bengal Steel has no email address.', {
      exact: true,
    }),
  ).toBeVisible();
});
