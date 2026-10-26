/**
 * The business apps end to end (RFC 0008 step 7, RFC 0009): on a real installation of Sales, Purchase and
 * Accounting with their bridges, a salesperson invoices a confirmed order from its form; an accountant registers
 * a payment on an invoice from its form and sees it paid; the manager's settings page shows the chart and takes
 * a lock date; the aged balances and the trial balance show the ledger; open items are matched by hand.
 */
import { totp } from '@kosh/server';
import { expect, type Page, test } from '@playwright/test';

const PASSWORD = 'correct horse battery';
const ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

async function signIn(page: Page, login: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (login === 'admin') {
    await page.getByLabel('Authentication code').fill(totp(ADMIN_TOTP_SECRET));
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
}

test('a confirmed sales order is invoiced from its form; the invoice is a draft customer invoice', async ({
  page,
}) => {
  await signIn(page, 'rahim');
  await page.goto('/sales/a/sales.action_orders');
  await page
    .getByRole('row', { name: /Bengal Steel/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('SO/');
  await expect(page.getByText('To invoice')).toBeVisible();
  await page.getByRole('button', { name: 'Create invoice' }).click();
  await expect(page.getByText('Invoiced', { exact: true })).toBeVisible();
  await page.goto('/accounting/a/accounting.action_customer_invoices');
  const rows = page.getByRole('row', { name: /Bengal Steel/ });
  await expect(rows).toHaveCount(2); // the seeded posted one, and the draft from the order
  await expect(page.getByRole('row', { name: /Draft/ })).toHaveCount(1);
});

test('register payment on a posted invoice marks it paid; the aging and the trial balance show the ledger', async ({
  page,
}) => {
  await signIn(page, 'rahim');
  await page.goto('/accounting/a/accounting.action_customer_invoices');
  await page
    .getByRole('row', { name: /Posted/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('INV/');
  await expect(page.getByText('Not paid')).toBeVisible();
  await page.getByRole('button', { name: 'Register payment' }).click();
  const dialog = page.getByRole('dialog', { name: 'Register a payment' });
  await dialog.getByRole('combobox', { name: 'Journal' }).click();
  await page.getByRole('option', { name: /BNK/ }).click();
  await expect(dialog.getByLabel('Amount')).toHaveValue('5750.00'); // 5 × 1,000 + 15 % VAT
  await dialog.getByRole('button', { name: 'Pay' }).click();
  await expect(page.getByText('Paid', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Register payment' })).toHaveCount(0);

  await page.goto('/accounting/a/accounting.action_aging');
  await expect(page.getByRole('heading', { name: 'Aged balances' })).toBeVisible();
  await expect(page.getByText('Nothing open.')).toBeVisible(); // the only invoice is paid
  await page.getByRole('button', { name: 'Payables' }).click();
  await expect(page.getByText('Nothing open.')).toBeVisible();

  await page.goto('/accounting/a/accounting.action_trial_balance');
  await expect(page.getByText(/1100 Accounts receivable/)).toBeVisible();
  await expect(page.getByText(/1010 Bank/)).toBeVisible();
});

test('the settings page shows the chart and takes a lock date; the reconciliation page matches open items', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto('/accounting/a/accounting.action_settings');
  await expect(page.getByRole('heading', { name: 'Accounting settings' })).toBeVisible();
  await expect(page.getByText('Installed: Bangladesh')).toBeVisible();
  await page.getByLabel('Tax lock date').fill('2020-12-31');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();

  // An open payment and an unpaid invoice for Acme: matched by hand on the receivable account.
  const csrf = await page.evaluate(() => sessionStorage.getItem('kosh.csrf'));
  const headers = { 'x-csrf-token': csrf ?? '' };
  const acme = (
    (await (await page.request.get('/api/v1/models/res.partner/names?q=Acme')).json()) as {
      items: { id: number }[];
    }
  ).items[0];
  const journals = (
    (await (await page.request.get('/api/v1/models/account.journal?fields=id,code')).json()) as {
      items: { id: number; code: string }[];
    }
  ).items;
  const currency = (
    (await (await page.request.get('/api/v1/models/res.currency?fields=id,name')).json()) as {
      items: { id: number; name: string }[];
    }
  ).items.find((c) => c.name === 'BDT');
  const invoice = (await (
    await page.request.post('/api/v1/models/account.move', {
      headers,
      data: {
        kind: 'out_invoice',
        journal: journals.find((j) => j.code === 'INV')?.id,
        partner: acme?.id,
        currency: currency?.id,
        lines: {
          create: [{ lineKind: 'product', name: 'Consulting', quantity: '1', priceUnit: '300' }],
        },
      },
    })
  ).json()) as { id: number };
  expect(
    (
      await page.request.post(`/api/v1/models/account.move/${invoice.id}/transitions/post`, {
        headers,
      })
    ).ok(),
  ).toBe(true);
  const payment = (await (
    await page.request.post('/api/v1/models/account.payment', {
      headers,
      data: {
        kind: 'inbound',
        partner: acme?.id,
        journal: journals.find((j) => j.code === 'CSH')?.id,
        currency: currency?.id,
        amount: '300',
      },
    })
  ).json()) as { id: number };
  expect(
    (
      await page.request.post(`/api/v1/models/account.payment/${payment.id}/transitions/post`, {
        headers,
      })
    ).ok(),
  ).toBe(true);

  await page.goto('/accounting/a/accounting.action_reconcile');
  await expect(page.getByRole('heading', { name: 'Reconciliation' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Account' }).click();
  await page.getByRole('option', { name: /1100/ }).click();
  await page.getByLabel('Partner (name)').fill('Acme');
  const boxes = page.getByRole('checkbox');
  await expect(boxes).toHaveCount(2);
  await boxes.nth(0).click();
  await boxes.nth(1).click();
  await expect(page.getByText(/2 lines selected, balance 0/)).toBeVisible();
  await page.getByRole('button', { name: 'Reconcile' }).click();
  await expect(page.getByText('1 match made.')).toBeVisible();
  await expect(page.getByText('Nothing open on this account.')).toBeVisible();
});
