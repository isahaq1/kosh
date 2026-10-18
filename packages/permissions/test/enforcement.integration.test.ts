/**
 * Forbidden users are blocked at the server for every endpoint type (CLAUDE.md "Permission tests"), generated from
 * the metadata so new models are covered: for every served model and every endpoint (list, read, create, update,
 * delete, aggregate, onchange, export, import, metadata, transitions), the server refuses exactly what Shutro
 * says the user may not do. Then: installing a module grants nothing, navigation is filtered per user, action
 * permissions and per-company roles hold, and exports need the export permission and are audited.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startApp, type TestApp } from './support/app.js';

let t: TestApp;

beforeAll(async () => {
  t = await startApp();
}, 240_000);
afterAll(async () => t?.stop());

type Perm = 'read' | 'write' | 'create' | 'unlink' | 'export' | 'import';

/** What Shutro says `login` may do on `model` (in Dhaka), from a real scope as that user. */
async function allowed(login: string, model: string, perm: Perm): Promise<boolean> {
  const groups = (
    await t.server.driver.query<{ group: string }>({
      text: 'SELECT "group" FROM auth_user_group WHERE user_id = $1 AND (company_id IS NULL OR company_id = $2)',
      params: [t.users[login] as number, t.companies.dhaka],
    })
  ).map((r) => r.group);
  return t.server.shutro.run(
    { user: t.users[login] as number, company: t.companies.dhaka, groups, readOnly: true },
    async (env) => env.access.can(model as never, perm),
  );
}

describe('every endpoint type, every served model', () => {
  test('a forbidden user gets 403 wherever Shutro denies, never a success', async () => {
    const document = (await t.call({ url: '/api/v1/openapi.json', as: 'bob' })).json() as {
      paths: Record<string, unknown>;
    };
    const models = Object.keys(document.paths)
      .map((p) => /^\/api\/v1\/models\/([^/{]+)$/.exec(p)?.[1])
      .filter((m): m is string => m !== undefined);
    expect(models).toEqual(
      expect.arrayContaining(['purchase.order', 'res.users', 'approval.policy']),
    );
    expect(models).not.toContain('approval.request'); // private

    const transitions = (model: string) =>
      Object.keys(document.paths)
        .map(
          (p) =>
            new RegExp(
              `^/api/v1/models/${model.replace('.', '\\.')}/\\{id\\}/transitions/(\\w+)$`,
            ).exec(p)?.[1],
        )
        .filter((n): n is string => n !== undefined);

    const checked: string[] = [];
    for (const login of ['bob', 'nobody'])
      for (const model of models) {
        const base = `/api/v1/models/${model}`;
        const endpoints: [string, Perm, Parameters<TestApp['call']>[0]][] = [
          ['list', 'read', { url: base }],
          ['read', 'read', { url: `${base}/1` }],
          ['meta', 'read', { url: `/api/v1/meta/${model}` }],
          [
            'aggregate',
            'read',
            { method: 'POST', url: `${base}/aggregate`, body: { measures: { n: 'count' } } },
          ],
          ['create', 'create', { method: 'POST', url: base, body: {} }],
          [
            'onchange',
            'create',
            { method: 'POST', url: `${base}/onchange`, body: { values: {}, changed: [] } },
          ],
          ['update', 'write', { method: 'PATCH', url: `${base}/1`, body: {} }],
          ['delete', 'unlink', { method: 'DELETE', url: `${base}/1` }],
          ['export', 'export', { method: 'POST', url: `${base}/export`, body: { format: 'json' } }],
          ['import', 'import', { method: 'POST', url: `${base}/import`, body: { rows: [{}] } }],
          ...transitions(model).map(
            (name) =>
              [
                `transition ${name}`,
                'write',
                { method: 'POST', url: `${base}/1/transitions/${name}` },
              ] as [string, Perm, Parameters<TestApp['call']>[0]],
          ),
        ];
        for (const [kind, perm, request] of endpoints) {
          const may = await allowed(login, model, perm);
          const res = await t.call({ ...request, as: login });
          const where = `${login} ${kind} ${model} → ${res.status}`;
          if (!may) {
            expect(res.status, where).toBe(403);
            checked.push(where);
          } else expect(res.status, where).not.toBe(500);
        }
      }
    // The matrix is not vacuous: most combinations are forbidden for these users.
    expect(checked.length).toBeGreaterThan(40);
  }, 120_000);
});

describe('installing a module grants nothing', () => {
  test('a user without a purchase role sees no app, menu or action, and no order', async () => {
    expect((await t.call({ url: '/api/v1/apps', as: 'bob' })).json()).toEqual({ apps: [] });
    expect((await t.call({ url: '/api/v1/menus', as: 'bob' })).json()).toEqual({ menus: [] });
    expect(
      (await t.call({ url: '/api/v1/actions/purchase.action_orders', as: 'bob' })).status,
    ).toBe(403);
    expect((await t.call({ url: '/api/v1/models/purchase.order', as: 'bob' })).status).toBe(403);
  });

  test('menus follow the roles: requesters see orders, managers also settings, admins everything', async () => {
    const tree = async (login: string) =>
      (
        (await t.call({ url: '/api/v1/menus', as: login })).json() as {
          menus: { id: string; children: { id: string }[] }[];
        }
      ).menus.map((m) => [m.id, m.children.map((c) => c.id)]);
    expect(await tree('rahim')).toEqual([['purchase.root', ['purchase.orders']]]);
    expect(await tree('maria')).toEqual([
      ['purchase.root', ['purchase.orders', 'purchase.settings']],
    ]);
    expect(await tree('admin')).toEqual([
      ['purchase.root', ['purchase.orders', 'purchase.settings']],
    ]);
    expect(
      (await t.call({ url: '/api/v1/actions/purchase.action_settings', as: 'rahim' })).status,
    ).toBe(403);
    expect(
      (await t.call({ url: '/api/v1/actions/purchase.action_settings', as: 'maria' })).status,
    ).toBe(200);
    expect((await t.call({ url: '/api/v1/apps', as: 'rahim' })).json()).toEqual({
      apps: [{ code: 'purchase', label: 'Purchase', icon: 'cart', sequence: 10 }],
    });
  });
});

describe('model, record, action and company permissions', () => {
  test('requesters see only their own orders; approvers all; record rules apply to reads by id', async () => {
    const mine = await t.call({
      method: 'POST',
      url: '/api/v1/models/purchase.order',
      as: 'rahim',
      body: { name: 'PO-R1', amountTotal: '1000' },
    });
    expect(mine.status).toBe(201);
    const theirs = await t.call({
      method: 'POST',
      url: '/api/v1/models/purchase.order',
      as: 'farid',
      body: { name: 'PO-F1', amountTotal: '1000' },
    });
    expect(theirs.status).toBe(201);
    const names = async (login: string) =>
      (
        (
          await t.call({ url: '/api/v1/models/purchase.order?fields=name&order=name', as: login })
        ).json() as { items: { name: string }[] }
      ).items.map((i) => i.name);
    expect(await names('rahim')).toEqual(['PO-R1']);
    expect(await names('dina')).toEqual(expect.arrayContaining(['PO-F1', 'PO-R1']));
    expect([403, 404]).toContain(
      (await t.call({ url: `/api/v1/models/purchase.order/${theirs.json().id}`, as: 'rahim' }))
        .status,
    );
    expect([403, 404]).toContain(
      (
        await t.call({
          method: 'PATCH',
          url: `/api/v1/models/purchase.order/${theirs.json().id}`,
          as: 'rahim',
          body: { vendor: 'X' },
        })
      ).status,
    );
  });

  test('action permissions: cancel needs purchase.cancel (managers), not just write access', async () => {
    const po = await t.call({
      method: 'POST',
      url: '/api/v1/models/purchase.order',
      as: 'dina',
      body: { name: 'PO-C', amountTotal: '10' },
    });
    const cancel = (login: string) =>
      t.call({
        method: 'POST',
        url: `/api/v1/models/purchase.order/${po.json().id}/transitions/cancel`,
        as: login,
      });
    expect((await cancel('dina')).status).toBe(403);
    const ok = await cancel('maria');
    expect(ok.status).toBe(200);
    expect(ok.json().state).toBe('cancelled');
  });

  test('roles are per company: rahim requests in Dhaka and approves in Chattogram', async () => {
    const meta = async (company: number) =>
      (await t.call({ url: '/api/v1/models/purchase.order?fields=name', as: 'rahim', company }))
        .status;
    expect(await meta(t.companies.dhaka)).toBe(200);
    expect(await meta(t.companies.chattogram)).toBe(200);
    // In Chattogram he is an approver: he sees orders he did not create there.
    const po = await t.call({
      method: 'POST',
      url: '/api/v1/models/purchase.order',
      as: 'maria',
      company: t.companies.chattogram,
      body: { name: 'PO-CTG', amountTotal: '10' },
    });
    expect(po.status).toBe(201);
    const ctg = await t.call({
      url: '/api/v1/models/purchase.order?fields=name',
      as: 'rahim',
      company: t.companies.chattogram,
    });
    expect((ctg.json() as { items: { name: string }[] }).items.map((i) => i.name)).toContain(
      'PO-CTG',
    );
    const dhaka = await t.call({
      url: '/api/v1/models/purchase.order?fields=name',
      as: 'rahim',
      company: t.companies.dhaka,
    });
    expect((dhaka.json() as { items: { name: string }[] }).items.map((i) => i.name)).not.toContain(
      'PO-F1',
    );
  });

  test('exports need the export permission and are audited; imports need import', async () => {
    const asUser = await t.call({
      method: 'POST',
      url: '/api/v1/models/purchase.order/export',
      as: 'dina',
      body: {},
    });
    expect(asUser.status).toBe(403);
    const csv = await t.call({
      method: 'POST',
      url: '/api/v1/models/purchase.order/export',
      as: 'maria',
      body: { fields: ['name', 'amountTotal'], order: ['name asc'] },
    });
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    expect(csv.body.split('\r\n')[0]).toBe('id,name,amountTotal');
    const [event] = await t.server.driver.query<{
      kind: string;
      actor_id: number;
      target_model: string;
    }>({
      text: "SELECT kind, actor_id, target_model FROM audit_event WHERE kind = 'data.export' ORDER BY id DESC LIMIT 1",
      params: [],
    });
    expect(event).toEqual({
      kind: 'data.export',
      actor_id: t.users['maria'],
      target_model: 'purchase.order',
    });

    expect(
      (
        await t.call({
          method: 'POST',
          url: '/api/v1/models/purchase.order/import',
          as: 'dina',
          body: { rows: [{ name: 'X' }] },
        })
      ).status,
    ).toBe(403);
    const imported = await t.call({
      method: 'POST',
      url: '/api/v1/models/purchase.order/import',
      as: 'maria',
      body: {
        rows: [
          { name: 'PO-I1', amountTotal: '5' },
          { name: 'PO-I2', amountTotal: '6' },
        ],
      },
    });
    expect(imported.status).toBe(201);
    expect(imported.json().created).toHaveLength(2);
  });

  test('CSV exports neutralize formulas (spreadsheet injection)', async () => {
    await t.call({
      method: 'POST',
      url: '/api/v1/models/purchase.order',
      as: 'maria',
      body: { name: '=HYPERLINK("x")', amountTotal: '1' },
    });
    const csv = await t.call({
      method: 'POST',
      url: '/api/v1/models/purchase.order/export',
      as: 'maria',
      body: { fields: ['name'] },
    });
    expect(csv.body).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
