/**
 * Campaigns ↔ Sales on real PostgreSQL (RFC 0038 step 3): a confirmed order is credited to the campaign whose
 * link its customer followed — by the contact the message went to, or by its address —; not without a click, not
 * for somebody else, not after 30 days; once; and nobody writes the credit by hand.
 */
import { createMemoryMailer, type OutboundMail } from '@kosh/mail';
import { campaignWorker, configureCampaigns } from '@kosh/marketing';
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { marketingSale, marketingSaleWorkers } from '../src/index.js';

const BASE = 'https://erp.test';
const O = '/api/v1/models/sale.order';
const mailer = createMemoryMailer();
let erp: TestInstallation;
let drain: () => Promise<void>;
const ids: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, as: string, body?: unknown) => {
  const res = await erp.call(method, url, as, body);
  return { status: res.status, json: res.json as Json };
};
const make = async (model: string, as: string, values: Record<string, unknown>) => {
  const made = await call('POST', `/api/v1/models/${model}`, as, values);
  expect(made.status, `${model}: ${JSON.stringify(made.json)}`).toBe(201);
  return made.json.id as number;
};
const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  erp.host.server.driver.query<T>({ text, params });
const mailTo = (to: string): OutboundMail => {
  const mail = [...mailer.sent].reverse().find((m) => m.to === to);
  if (mail === undefined) throw new Error(`no mail to ${to}`);
  return mail;
};
/** The recipient follows the first link of their message. */
const click = async (to: string) => {
  const link = new RegExp(`${BASE}(/api/v1/public/campaigns/c/[^"\\s]+)`).exec(mailTo(to).html);
  const res = await erp.host.server.app.inject({ method: 'GET', url: link?.[1] ?? '/' });
  expect(res.statusCode).toBe(302);
};
/** A campaign to the list, sent. */
const campaign = async (name: string) => {
  const id = await make('marketing.campaign', 'mia', {
    name,
    subject: name,
    body: '<p><a href="https://shop.test/offers">Offers</a></p>',
    lists: { set: [ids['list']] },
  });
  const sent = await call(
    'POST',
    `/api/v1/models/marketing.campaign/${id}/transitions/send`,
    'mia',
  );
  expect(sent.status, JSON.stringify(sent.json)).toBe(200);
  await drain();
  return id;
};
/** An order of the customer, confirmed; what it was credited to. */
const order = async (customer: string) => {
  const id = await make('sale.order', 'sam', {
    partner: ids[customer],
    currency: ids['currency'],
    lines: { create: [{ product: ids['product'], name: 'Jute bag', quantity: '2' }] },
  });
  const confirmed = await call('POST', `${O}/${id}/transitions/confirm`, 'sam');
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  await drain();
  const seen = (await call('GET', `${O}/${id}?fields=campaign`, 'sam')).json as Json;
  return { id, campaign: (seen.campaign?.id ?? seen.campaign ?? null) as number | null };
};

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  configureCampaigns({ mailer, baseUrl: BASE, workers: false });
  erp = await testInstallation({
    modules: [marketingSale],
    users: {
      mia: ['marketing.manager', 'contacts.manager'],
      sam: ['sales.manager', 'product.manager', 'marketing_sale.user'],
    },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
  const sending = campaignWorker({ shutro: erp.host.server.shutro }, { mailer, baseUrl: BASE });
  const crediting = marketingSaleWorkers({ shutro: erp.host.server.shutro });
  drain = async () => {
    for (let round = 0; round < 20; round += 1) {
      let done = await sending.drain();
      for (const w of crediting) done += await w.drain();
      if (done === 0) break;
    }
  };
  ids['currency'] = Number(
    (await sql<{ id: number }>('SELECT currency_id AS id FROM res_company LIMIT 1'))[0]?.id,
  );
  ids['product'] = await make('product.product', 'sam', { name: 'Jute bag', listPrice: '250' });
  ids['nadia'] = await make('res.partner', 'mia', {
    name: 'Nadia Karim',
    email: 'nadia@example.com',
  });
  // The same person under the address of the list, with capitals: found by the address.
  ids['karim'] = await make('res.partner', 'mia', {
    name: 'Karim Traders',
    email: 'Karim@Example.com',
  });
  ids['other'] = await make('res.partner', 'mia', {
    name: 'Other Ltd',
    email: 'other@example.com',
  });
  ids['list'] = await make('marketing.list', 'mia', { name: 'Customers' });
  await make('marketing.subscriber', 'mia', {
    list: ids['list'],
    email: 'nadia@example.com',
    partner: ids['nadia'],
  });
  await make('marketing.subscriber', 'mia', { list: ids['list'], email: 'karim@example.com' });
  await make('marketing.subscriber', 'mia', { list: ids['list'], email: 'other@example.com' });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('an order after a click is credited to the campaign; without a click it is nobody’s', async () => {
  ids['winter'] = await campaign('Winter offer');
  // Opened by nobody yet: an order now is not the campaign's.
  expect((await order('nadia')).campaign).toBeNull();
  await click('nadia@example.com');
  await click('karim@example.com');
  expect((await order('nadia')).campaign).toBe(ids['winter']);
  // By the address, whatever its capitals, when the message was not sent to a contact.
  expect((await order('karim')).campaign).toBe(ids['winter']);
  // Somebody who got the message and did not click.
  expect((await order('other')).campaign).toBeNull();
});

test('the last campaign clicked has the order; a click older than 30 days has none', async () => {
  ids['spring'] = await campaign('Spring news');
  await click('nadia@example.com');
  expect((await order('nadia')).campaign).toBe(ids['spring']);
  // Karim clicked the winter campaign only — 31 days ago, now.
  await sql(
    `UPDATE marketing_delivery SET clicked_at = now() - interval '31 days'
      WHERE campaign_id = $1 AND email = 'karim@example.com'`,
    [ids['winter']],
  );
  expect((await order('karim')).campaign).toBeNull();
});

test('the credit is the server’s: nobody writes it, and a campaign shows its orders', async () => {
  const mine = await order('other');
  expect(
    (await call('PATCH', `${O}/${mine.id}`, 'sam', { campaign: ids['winter'] })).status,
  ).toBeGreaterThanOrEqual(400);
  const [winter] = await sql<{ n: string }>(
    `SELECT count(*)::text AS n FROM sale_order WHERE campaign_id = $1 AND state IN ('sale', 'done')`,
    [ids['winter']],
  );
  expect(Number(winter?.n)).toBe(2);
  // The campaign's form carries the tiles.
  const view = (await call('GET', '/api/v1/views/marketing.campaign.form', 'sam')).json as Json;
  expect(JSON.stringify(view)).toContain('campaign_ordered');
});
