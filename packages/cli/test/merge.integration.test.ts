/**
 * Duplicates and merging (RFC 0036 §2.3) on a served installation with Contacts and Accounting: contacts that share
 * an email are found; merging moves every link — a child contact, a draft invoice — to the contact kept and archives
 * the other; Undo puts each back; a contact with a posted invoice is not merged (posted entries keep their partner)
 * and nothing is left half-done; only an Administrator looks, merges and undoes.
 */
import { accounting, installChart } from '@kosh/accounting';
import { base } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { settings } from '@kosh/settings';
import { afterAll, beforeAll, expect, test } from 'vitest';

let erp: TestInstallation;
let keep = 0;
let duplicate = 0;
let child = 0;
let invoice = 0;

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (method: 'GET' | 'POST', url: string, as: string, payload?: unknown) =>
  (await erp.call(method, url, as, payload)) as { status: number; json: Json };
type Loose = {
  search(q: unknown): Promise<{ ids: number[] }>;
  create(v: unknown): Promise<{ ids: number[]; post(): Promise<void> }>;
  browse(ids: number[]): { post(): Promise<void> };
};
const model = (env: Env, name: string) => env.model(name as never) as unknown as Loose;
const system = <T>(fn: (env: Env) => Promise<T>) =>
  erp.host.server.shutro.bootstrap({ reason: 'test', company: erp.company }, fn);
/** The partner each record points at, and whether the duplicate is active. */
const links = () =>
  system(async (env) => {
    const [row] = await env.sql<{ parent: number; partner: number; active: boolean }>`
      SELECT (SELECT parent_id FROM res_partner WHERE id = ${child}) AS parent,
             (SELECT partner_id FROM account_move WHERE id = ${invoice}) AS partner,
             (SELECT active FROM res_partner WHERE id = ${duplicate}) AS active`;
    return row;
  });

beforeAll(async () => {
  erp = await testInstallation({
    modules: [base, settings, accounting],
    users: { maria: ['account.manager', 'contacts.manager'] },
  });
  await system(async (env) => {
    await installChart(env as never, 'generic');
    const partners = model(env, 'res.partner');
    [keep] = (
      await partners.create([
        { name: 'Meghna Stores', isCompany: true, email: 'accounts@meghna.example' },
      ])
    ).ids as [number];
    [duplicate] = (
      await partners.create([
        { name: 'Meghna Store', isCompany: true, email: 'Accounts@Meghna.example' },
      ])
    ).ids as [number];
    [child] = (await partners.create([{ name: 'Rina Akter', parent: duplicate }])).ids as [number];
    await partners.create([{ name: 'Somebody Else', email: 'else@example.com' }]);
    const [journal] = (await model(env, 'account.journal').search({ where: { type: 'sale' } })).ids;
    const [income] = (await model(env, 'account.account').search({ where: { code: '4000' } })).ids;
    const [{ currency_id: currency } = { currency_id: 0 }] = await env.sql<{ currency_id: number }>`
      SELECT currency_id FROM res_company WHERE id = ${erp.company}`;
    [invoice] = (
      await model(env, 'account.move').create([
        {
          kind: 'out_invoice',
          journal,
          partner: duplicate,
          currency,
          date: '2026-11-01',
          lines: {
            create: [
              {
                lineKind: 'product',
                name: 'Rice',
                quantity: '1',
                priceUnit: '500',
                account: income,
              },
            ],
          },
        },
      ])
    ).ids as [number];
    await env.flush();
  });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('contacts that share an email are found, whatever its case; only an Administrator looks', async () => {
  expect((await call('GET', '/api/v1/settings/duplicates', 'maria')).status).toBe(403);
  const found = await call('GET', '/api/v1/settings/duplicates', 'admin');
  expect(found.status, JSON.stringify(found.json)).toBe(200);
  const byEmail = found.json.groups.filter((g: { key: string }) => g.key === 'Email');
  expect(byEmail).toHaveLength(1);
  expect(byEmail[0]).toMatchObject({
    model: 'res.partner',
    label: 'Contact',
    value: 'accounts@meghna.example',
  });
  expect(byEmail[0].records.map((r: { id: number }) => r.id).sort()).toEqual(
    [keep, duplicate].sort(),
  );
  // Their names differ ("Stores" / "Store"): not a duplicate by name.
  expect(found.json.groups.some((g: { key: string }) => g.key === 'Name')).toBe(false);
});

test('a merge moves every link to the contact kept and archives the other; Undo puts each back', {
  retry: 0,
}, async () => {
  expect(await links()).toEqual({ parent: duplicate, partner: duplicate, active: true });
  const refusedFor = await call('POST', '/api/v1/settings/duplicates/merge', 'maria', {
    model: 'res.partner',
    keep,
    merge: [duplicate],
  });
  expect(refusedFor.status).toBe(403);
  const notMerged = await call('POST', '/api/v1/settings/duplicates/merge', 'admin', {
    model: 'account.move',
    keep: 1,
    merge: [2],
  });
  expect(notMerged.status).toBe(400);

  const merged = await call('POST', '/api/v1/settings/duplicates/merge', 'admin', {
    model: 'res.partner',
    keep,
    merge: [duplicate],
  });
  expect(merged.status, JSON.stringify(merged.json)).toBe(200);
  expect(merged.json.moved['res.partner']).toBe(1);
  expect(merged.json.moved['account.move']).toBe(1);
  expect(await links()).toEqual({ parent: keep, partner: keep, active: false });
  // No longer a duplicate.
  const after = await call('GET', '/api/v1/settings/duplicates', 'admin');
  expect(after.json.groups.filter((g: { key: string }) => g.key === 'Email')).toHaveLength(0);

  const log = await call('GET', '/api/v1/settings/merges', 'admin');
  expect(log.status, JSON.stringify(log.json)).toBe(200);
  expect(log.json.merges[0]).toMatchObject({
    id: merged.json.id,
    model: 'res.partner',
    keep,
    merged: [duplicate],
    canUndo: true,
  });
  expect(
    (await call('POST', `/api/v1/settings/merges/${merged.json.id}/undo`, 'maria')).status,
  ).toBe(403);
  const undone = await call('POST', `/api/v1/settings/merges/${merged.json.id}/undo`, 'admin');
  expect(undone.status, JSON.stringify(undone.json)).toBe(200);
  expect(await links()).toEqual({ parent: duplicate, partner: duplicate, active: true });
  const twice = await call('POST', `/api/v1/settings/merges/${merged.json.id}/undo`, 'admin');
  expect(twice.status).toBe(409);
});

test('a contact with a posted invoice is not merged, and nothing is left half-done', {
  retry: 0,
}, async () => {
  await system(async (env) => {
    await model(env, 'account.move').browse([invoice]).post();
    await env.flush();
  });
  const refused = await call('POST', '/api/v1/settings/duplicates/merge', 'admin', {
    model: 'res.partner',
    keep,
    merge: [duplicate],
  });
  expect(refused.status, JSON.stringify(refused.json)).toBe(409);
  expect(refused.json.type).toContain('merge-refused');
  expect(refused.json.detail).toContain('cannot be moved to the record kept');
  // The child contact moved first was rolled back with the rest.
  expect(await links()).toEqual({ parent: duplicate, partner: duplicate, active: true });
});
