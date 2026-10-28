/**
 * The portal on a phone (RFC 0015 step 3): staff invite a customer's contact; the contact opens the invitation,
 * chooses a password and lands on the home page with the quotation to sign and the invoice due; signs and accepts
 * the quotation, writes on it, downloads the invoice, pays it online, and reads the portal in Bangla.
 */
import { expect, type Page, test } from '@playwright/test';

const API = 'http://127.0.0.1:3102';
const PASSWORD = 'correct horse battery';

/** As staff, through the API: the contact's invitation link. */
async function invite(): Promise<string> {
  const login = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'maria', password: PASSWORD }),
  });
  const { token } = (await login.json()) as { token: string };
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const filter = encodeURIComponent(JSON.stringify({ email: 'rina@acme.test' }));
  const found = await fetch(`${API}/api/v1/models/res.partner?filter=${filter}&fields=id`, {
    headers,
  });
  const [rina] = ((await found.json()) as { items: { id: number }[] }).items;
  const granted = await fetch(`${API}/api/v1/portal/access`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ partner: rina?.id }),
  });
  expect(granted.status).toBe(201);
  return ((await granted.json()) as { activationUrl: string }).activationUrl;
}

async function openDocument(page: Page, nav: string, name: RegExp): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: nav }).click();
  await page.getByRole('link', { name }).first().click();
}

test('invited, activated, signs the quotation, writes, downloads and pays the invoice, reads Bangla', async ({
  page,
}) => {
  const link = new URL(await invite());
  await page.goto(`${link.pathname}${link.search}`);
  await expect(page.getByRole('heading', { name: 'Choose your password' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat the password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Save and sign in' }).click();

  // Home: what needs the customer.
  await expect(page.getByRole('heading', { name: 'Needs your attention' })).toBeVisible();
  await expect(page.getByText('Padma Traders')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Quotations and orders/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Invoices/ })).toBeVisible();

  // The quotation: sign and accept.
  await openDocument(page, 'Quotations and orders', /^SO/);
  await expect(page.getByText('Quotation sent')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Jute bag' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Accept and sign' }).click();
  const dialog = page.getByRole('dialog', { name: 'Accept and sign' });
  await expect(dialog.getByRole('button', { name: 'Sign and accept' })).toBeDisabled();
  await dialog.getByLabel('Full name').fill('Rina Akter');
  await dialog.getByRole('button', { name: 'Use my typed name as signature' }).click();
  await dialog.getByRole('button', { name: 'Sign and accept' }).click();
  await expect(page.getByText('Done.')).toBeVisible();
  await expect(page.getByText('Sales order', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept and sign' })).toHaveCount(0);
  await expect(page.getByText(/signed as “Rina Akter”/)).toBeVisible();

  // A message on it.
  await page.getByLabel('Write a message').fill('Please deliver to the Narayanganj warehouse.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Please deliver to the Narayanganj warehouse.')).toBeVisible();

  // The invoice's PDF.
  await openDocument(page, 'Invoices', /^INV/);
  await expect(page.getByText('Not paid')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download the PDF' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/);

  // Pay it online: the (test) provider's page, and back.
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByRole('heading', { name: 'Test payment' })).toBeVisible();
  await page.getByRole('button', { name: 'Pay', exact: true }).click();
  await expect(page.getByText(/Thank you: your payment of [\d.]+ BDT is received\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay now' })).toHaveCount(0);

  // Bangla.
  await page.getByRole('link', { name: 'Rina Akter' }).click();
  await page.getByRole('combobox', { name: 'Language' }).click();
  await page.getByRole('option', { name: 'বাংলা' }).click();
  await expect(page.getByRole('heading', { name: 'প্রোফাইল' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'হোম' })).toBeVisible();
});

test('the back-office and its API stay closed to the customer', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('rina@acme.test');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Needs your attention' })).toBeVisible();
  const status = await page.evaluate(async () => (await fetch('/api/v1/models/sale.order')).status);
  expect(status).toBe(403);
});
