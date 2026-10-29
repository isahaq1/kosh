/**
 * A role in full and the effect of a change, before saving (RFC 0019 §3.3): what a runtime role grants from code and
 * the roles it includes (locked) versus its own grants, who holds it; the preview of a change names who gains and who
 * loses which app access and feature permission — counting their other roles — and the model changes. Read through
 * Shutro's `securityAdmin.describe()`; administrators only.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startApp, type TestApp } from './support/app.js';

let t: TestApp;

beforeAll(async () => {
  t = await startApp();
  const put = async (url: string, body: unknown) =>
    expect((await t.call({ method: 'PUT', url, as: 'admin', body })).status).toBe(200);
  await put('/api/v1/admin/roles/company.buyer', {
    label: 'Buyer',
    accessLevels: ['purchase.user'],
  });
  await put(`/api/v1/admin/users/${t.users['bob']}/roles`, {
    assignments: [{ role: 'base.user' }, { role: 'company.buyer' }],
  });
  await put(`/api/v1/admin/users/${t.users['farid']}/roles`, {
    assignments: [{ role: 'purchase.user', company: t.companies.dhaka }, { role: 'company.buyer' }],
  });
}, 240_000);
afterAll(async () => t?.stop());

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;

test('a role in full: code rights locked, its own grants, its holders', async () => {
  const role = (
    await t.call({ url: '/api/v1/admin/roles/company.buyer', as: 'admin' })
  ).json() as Json;
  expect(role).toMatchObject({
    code: 'company.buyer',
    label: 'Buyer',
    builtIn: false,
    administrator: false,
  });
  expect(role.accessLevels).toContain('purchase.user');
  expect(role.holders.map((h: Json) => h.login).sort()).toEqual(['bob', 'farid']);
  const po = role.models.find((m: Json) => m.name === 'purchase.order');
  expect(po.locked.sort()).toEqual(['create', 'read', 'write']);
  expect(po.own).toEqual([]);
  expect(role.permissions.find((p: Json) => p.code === 'purchase.cancel')).toMatchObject({
    locked: false,
    own: false,
  });

  // Its own grants show as its own.
  await t.call({
    method: 'PUT',
    url: '/api/v1/admin/roles/company.buyer/access/purchase.order',
    as: 'admin',
    body: { perms: ['export'] },
  });
  await t.call({
    method: 'PUT',
    url: '/api/v1/admin/roles/company.buyer/permissions/purchase.cancel',
    as: 'admin',
  });
  const after = (
    await t.call({ url: '/api/v1/admin/roles/company.buyer', as: 'admin' })
  ).json() as Json;
  expect(after.models.find((m: Json) => m.name === 'purchase.order').own).toEqual(['export']);
  expect(after.permissions.find((p: Json) => p.code === 'purchase.cancel').own).toBe(true);

  const list = (await t.call({ url: '/api/v1/admin/roles', as: 'admin' })).json() as Json;
  expect(list.roles.find((r: Json) => r.code === 'company.buyer').holders).toBe(2);
  expect((await t.call({ url: '/api/v1/admin/roles/company.nothing', as: 'admin' })).status).toBe(
    404,
  );
  expect((await t.call({ url: '/api/v1/admin/roles/company.buyer', as: 'maria' })).status).toBe(
    403,
  );
});

test('the preview: who gains and who loses what, counting their other roles; nothing saved', async () => {
  const preview = async (body: unknown) =>
    (
      await t.call({
        method: 'POST',
        url: '/api/v1/admin/roles/company.buyer/preview',
        as: 'admin',
        body,
      })
    ).json() as Json;

  const up = await preview({ accessLevels: ['purchase.manager'] });
  expect(up.holders).toBe(2);
  const bob = up.people.find((p: Json) => p.name === 'bob');
  expect(bob.gains.join(' | ')).toContain('Manager');
  expect(bob.losses).toEqual([]);
  expect(up.models.find((m: Json) => m.model === 'purchase.order').added).toEqual(
    expect.arrayContaining(['unlink', 'import']),
  );

  // Taking the access away: bob loses it, farid keeps it through his own Purchase role.
  const down = await preview({ accessLevels: [], access: {}, permissions: [] });
  expect(down.people.find((p: Json) => p.name === 'bob').losses.join(' | ')).toContain('Requester');
  const farid = down.people.find((p: Json) => p.name === 'farid');
  expect(farid?.losses.join(' | ') ?? '').not.toContain('Requester');
  expect(down.people.find((p: Json) => p.name === 'bob').losses).toContain(
    'Cancel purchase orders',
  );

  // Nothing was saved.
  const role = (
    await t.call({ url: '/api/v1/admin/roles/company.buyer', as: 'admin' })
  ).json() as Json;
  expect(role.accessLevels).not.toContain('purchase.manager');
  expect(
    (
      await t.call({
        method: 'POST',
        url: '/api/v1/admin/roles/company.buyer/preview',
        as: 'maria',
        body: {},
      })
    ).status,
  ).toBe(403);
});
