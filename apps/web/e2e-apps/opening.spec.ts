/**
 * The opening-balance kit on screen (RFC 0036 §2.1): an Administrator downloads the workbook, checks a filled one —
 * every error with its sheet and row, nothing kept, Load not offered — and sees the proof of one that is right;
 * an accountant who is not an Administrator is told it is not theirs. Nothing is loaded here: the data set's books
 * stay as the other specs expect them (the load and the undo are proved in `packages/cli/test/opening…`).
 */
import { readFile } from 'node:fs/promises';
import { readXlsx } from '@kosh/import';
import { type Cell, workbook } from '@kosh/reporting';
import { totp } from '@kosh/server';
import { expect, type Page, test } from '@playwright/test';
import { choose } from '../e2e/support.js';

const PASSWORD = 'correct horse battery';
const PAGE = '/accounting/a/accounting.action_opening';

async function signIn(page: Page, login: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (login === 'admin') {
    await page.getByLabel('Authentication code').fill(totp('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'));
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
}

/** A workbook of the kit's five sheets with these trial balance rows, at a cut-off before the data set's books. */
function filled(balances: Cell[][]): Buffer {
  return workbook([
    {
      name: 'Trial balance',
      rows: [['Account code', 'Account name', 'Debit', 'Credit'], ...balances],
    },
    {
      name: 'Receivables',
      rows: [
        ['Kind', 'Number', 'Customer', 'Date', 'Due date', 'Amount left'],
        ['Invoice', 'OLD-1', 'Nobody We Know Ltd', '2019-12-01', null, { decimal: '100' }],
      ],
    },
    { name: 'Payables', rows: [['Kind', 'Number', 'Vendor', 'Date', 'Due date', 'Amount left']] },
    {
      name: 'Stock',
      rows: [
        [
          'Product code',
          'Product',
          'Location',
          'Lot / serial number',
          'Expiry date',
          'Quantity',
          'Unit cost',
        ],
      ],
    },
    {
      name: 'Control totals',
      rows: [
        ['What', 'Value'],
        ['Cut-off date', '2019-12-31'],
        ['Total receivable', null],
        ['Total payable', null],
        ['Stock value', null],
      ],
    },
  ]);
}
const upload = (page: Page, buffer: Buffer) =>
  page.getByLabel('The filled workbook (.xlsx)').setInputFiles({
    name: 'opening-balances.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
  });

test('an Administrator downloads the workbook and checks one: every error on its row, nothing kept', async ({
  page,
}) => {
  await signIn(page, 'admin');
  await page.goto(PAGE);
  await expect(
    page.getByRole('heading', { name: 'Start from your figures', level: 1 }),
  ).toBeVisible();

  // The workbook lists the company's accounts.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download the workbook' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('opening-balances.xlsx');
  const template = await readFile(await download.path());
  const accounts = readXlsx(template, 'Trial balance').rows;
  expect(accounts[0]).toEqual(['Account code', 'Account name', 'Debit', 'Credit']);
  expect(accounts.length).toBeGreaterThan(10);

  // Load is not offered before a check passes.
  const load = page.getByRole('button', { name: 'Load', exact: true });
  await expect(load).toBeDisabled();

  // A workbook that balances but names an account and a customer Kosh does not have.
  await upload(
    page,
    filled([
      ['NOPE-1', 'An account we do not have', { decimal: '100' }, null],
      ['NOPE-2', 'Another', null, { decimal: '100' }],
    ]),
  );
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Refused: nothing was kept.' })).toBeVisible();
  await expect(
    page.getByRole('row', { name: /Trial balance 2 No account NOPE-1 in the chart/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('row', { name: /Receivables 2 No contact named Nobody We Know Ltd\./ }),
  ).toBeVisible();
  await expect(load).toBeDisabled();

  // A trial balance that does not balance is said as it is.
  await upload(page, filled([['NOPE-1', 'An account we do not have', { decimal: '100' }, null]]));
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(
    page.getByRole('row', {
      name: /The trial balance does not balance: debits less credits leave 100\.00\./,
    }),
  ).toBeVisible();
  // Nothing was loaded: the page still offers the first step.
  await expect(page.getByRole('heading', { name: '1. Get the workbook' })).toBeVisible();
});

test('an accountant who is not an Administrator is told the opening is not theirs', async ({
  page,
}) => {
  await signIn(page, 'dina');
  await page.goto(PAGE);
  // The page is an Administrator's: the server does not serve it to anyone else.
  await expect(page.getByRole('alert')).toContainText('is not available to this user');
  await expect(page.getByRole('button', { name: 'Download the workbook' })).toHaveCount(0);
});

test('in Bangla, the page speaks Bangla', async ({ page }) => {
  await signIn(page, 'admin');
  await choose(page, 'Language', 'বাংলা');
  await page.goto(PAGE);
  await expect(
    page.getByRole('heading', { name: 'আপনার হিসাব থেকে শুরু করুন', level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'ওয়ার্কবুক ডাউনলোড করুন' })).toBeVisible();
});
