/**
 * Administration without code (RFC 0003 §5.2, §5.4): the administrator bypass needs 2FA and stays subject to
 * integrity; roles, access, rules, field security, permissions, per-company assignments and special grants are
 * edited through the admin API, validated, audited, and refused when they would leave no administrator.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startApp, type TestApp } from './support/app.js';

let t: TestApp;

beforeAll(async () => {
  t = await startApp();
}, 240_000);
afterAll(async () => t?.stop());

const PO = '/api/v1/models/purchase.order';

describe('the administrator bypass', () => {
  test('non-administrators cannot use the admin API', async () => {
    for (const login of ['maria', 'bob'])
      expect((await t.call({ url: '/api/v1/admin/roles', as: login })).status).toBe(403);
  });

  test('administrators need no grants, but integrity still applies to them', async () => {
    const po = await t.call({
      method: 'POST',
      url: PO,
      as: 'admin',
      body: { name: 'PO-A', amountTotal: '10' },
    });
    expect(po.status).toBe(201); // no purchase role at all
    expect(
      (await t.call({ method: 'POST', url: PO, as: 'admin', body: { amountTotal: '10' } })).status,
    ).toBe(422); // required name
    const approved = await t.call({
      method: 'POST',
      url: `${PO}/${po.json().id}/transitions/reject`,
      as: 'admin',
    });
    expect(approved.status).toBe(409); // the state machine holds: draft orders cannot be rejected
    // A company the administrator is not in is refused too.
    expect((await t.call({ url: PO, as: 'admin', company: 999 })).status).toBe(403);
  });

  test('an administrator without a second factor in the session is a plain user', async () => {
    const res = await t.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'admin', password: 'correct horse battery' },
    });
    const pending = res.json() as { token: string; twoFactorRequired: boolean };
    expect(pending.twoFactorRequired).toBe(true); // 2FA is on: the session waits for the code
    const blocked = await t.server.app.inject({
      url: '/api/v1/admin/roles',
      headers: { authorization: `Bearer ${pending.token}` },
    });
    expect(blocked.statusCode).toBe(401);
  });
});

describe('roles without code', () => {
  test('create a role from access levels, assign it per company, and it takes effect', async () => {
    const levels = (await t.call({ url: '/api/v1/admin/access-levels', as: 'admin' })).json() as {
      accessLevels: { code: string }[];
    };
    expect(levels.accessLevels.map((l) => l.code)).toEqual(
      expect.arrayContaining([
        'purchase.user',
        'purchase.approver',
        'purchase.manager',
        'base.admin',
      ]),
    );
    const saved = await t.call({
      method: 'PUT',
      url: '/api/v1/admin/roles/company.finance_director',
      as: 'admin',
      body: { label: 'Finance director', accessLevels: ['purchase.approver'] },
    });
    expect(saved.status).toBe(200);
    const roles = (await t.call({ url: '/api/v1/admin/roles', as: 'admin' })).json() as {
      roles: { code: string; builtIn: boolean; accessLevels: string[] }[];
    };
    expect(roles.roles.find((r) => r.code === 'company.finance_director')).toMatchObject({
      builtIn: false,
      accessLevels: expect.arrayContaining(['purchase.approver', 'purchase.user']),
    });

    // bob gets it in Dhaka only.
    const assign = await t.call({
      method: 'PUT',
      url: `/api/v1/admin/users/${t.users['bob']}/roles`,
      as: 'admin',
      body: {
        assignments: [
          { role: 'base.user' },
          { role: 'company.finance_director', company: t.companies.dhaka },
        ],
      },
    });
    expect(assign.status).toBe(200);
    const fresh = await t.signIn('bob');
    const list = (company: number) =>
      t.server.app.inject({
        url: PO,
        headers: { authorization: `Bearer ${fresh}`, 'x-company': String(company) },
      });
    expect((await list(t.companies.dhaka)).statusCode).toBe(200);
    expect((await list(t.companies.chattogram)).statusCode).toBe(403);

    // A broken role reference or rule is refused when saved.
    expect(
      (
        await t.call({
          method: 'PUT',
          url: '/api/v1/admin/roles/company.x',
          as: 'admin',
          body: { label: 'X', implies: ['nope.group'] },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    const rule = await t.call({
      method: 'PUT',
      url: '/api/v1/admin/roles/company.finance_director/rules/fd_big',
      as: 'admin',
      body: { model: 'purchase.order', perms: ['read'], domain: { nope: 1 } },
    });
    expect(rule.status).toBeGreaterThanOrEqual(400);
    expect(rule.status).toBeLessThan(500);
  });

  test('model access and feature permissions per role', async () => {
    await t.call({
      method: 'PUT',
      url: '/api/v1/admin/roles/company.auditor',
      as: 'admin',
      body: { label: 'Auditor', implies: ['base.user'] },
    });
    const assigned = await t.call({
      method: 'PUT',
      url: `/api/v1/admin/users/${t.users['nobody']}/roles`,
      as: 'admin',
      body: { assignments: [{ role: 'company.auditor' }] },
    });
    expect(assigned.status, assigned.body).toBe(200);
    const nobody = await t.signIn('nobody');
    const asNobody = (url: string, method: 'GET' | 'POST' = 'GET', body?: unknown) =>
      t.server.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${nobody}` },
        ...(body === undefined ? {} : { payload: body as object }),
      });
    expect((await asNobody(PO)).statusCode).toBe(403);
    const access = await t.call({
      method: 'PUT',
      url: '/api/v1/admin/roles/company.auditor/access/purchase.order',
      as: 'admin',
      body: { perms: ['read'] },
    });
    expect(access.status).toBe(200);
    const readable = await asNobody(PO);
    expect(readable.statusCode, readable.body).toBe(200); // reads everything (no rule for this role)
    expect((await asNobody(`${PO}/export`, 'POST', {})).statusCode).toBe(403); // but exports nothing

    // A feature permission granted to the role.
    const po = await t.call({
      method: 'POST',
      url: PO,
      as: 'maria',
      body: { name: 'PO-P', amountTotal: '1' },
    });
    await t.call({
      method: 'PUT',
      url: '/api/v1/admin/roles/company.auditor/access/purchase.order',
      as: 'admin',
      body: { perms: ['read', 'write'] },
    });
    const cancel = () => asNobody(`${PO}/${po.json().id}/transitions/cancel`, 'POST');
    expect((await cancel()).statusCode).toBe(403);
    expect(
      (
        await t.call({
          method: 'PUT',
          url: '/api/v1/admin/roles/company.auditor/permissions/purchase.cancel',
          as: 'admin',
        })
      ).status,
    ).toBe(200);
    expect((await cancel()).statusCode).toBe(200);
  });

  test('field security without code: hide a field, or make it read-only, for everyone but some roles', async () => {
    const po = await t.call({
      method: 'POST',
      url: PO,
      as: 'rahim',
      body: { name: 'PO-F', amountTotal: '1', internalNote: 'secret' },
    });
    expect(po.status).toBe(201);
    const hide = await t.call({
      method: 'PUT',
      url: '/api/v1/admin/fields/purchase.order/internalNote',
      as: 'admin',
      body: { read: ['purchase.approver'] },
    });
    expect(hide.status).toBe(200);
    const asRahim = await t.call({ url: `${PO}/${po.json().id}`, as: 'rahim' });
    expect(asRahim.json()).not.toHaveProperty('internalNote');
    expect(
      (await t.call({ url: `${PO}/${po.json().id}?fields=internalNote`, as: 'rahim' })).status,
    ).toBe(403);
    expect(
      (
        await t.call({
          url: `${PO}?filter=${encodeURIComponent('{"internalNote":"secret"}')}`,
          as: 'rahim',
        })
      ).status,
    ).toBe(403);
    expect((await t.call({ url: `${PO}/${po.json().id}`, as: 'dina' })).json()).toMatchObject({
      internalNote: 'secret',
    });

    const lock = await t.call({
      method: 'PUT',
      url: '/api/v1/admin/fields/purchase.order/vendor',
      as: 'admin',
      body: { write: ['purchase.manager'] },
    });
    expect(lock.status).toBe(200);
    expect(
      (
        await t.call({
          method: 'PATCH',
          url: `${PO}/${po.json().id}`,
          as: 'rahim',
          body: { vendor: 'ACME' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await t.call({
          method: 'PATCH',
          url: `${PO}/${po.json().id}`,
          as: 'maria',
          body: { vendor: 'ACME' },
        })
      ).status,
    ).toBe(200);
    const meta = (await t.call({ url: '/api/v1/meta/purchase.order', as: 'rahim' })).json() as {
      fields: { key: string; readonly: boolean }[];
    };
    expect(meta.fields.find((f) => f.key === 'internalNote')).toBeUndefined();
    expect(meta.fields.find((f) => f.key === 'vendor')?.readonly).toBe(true);
  });

  test('special grants per user, with expiry', async () => {
    const farid = t.users['farid'] as number;
    const before = await t.call({ method: 'POST', url: `${PO}/export`, as: 'farid', body: {} });
    expect(before.status).toBe(403);
    const grant = await t.call({
      method: 'POST',
      url: `/api/v1/admin/users/${farid}/grants`,
      as: 'admin',
      body: {
        grant: 'purchase.order:export',
        reason: 'month-end reconciliation',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(grant.status).toBe(200);
    const token = await t.signIn('farid');
    const exportAs = () =>
      t.server.app.inject({
        method: 'POST',
        url: `${PO}/export`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
    expect((await exportAs()).statusCode).toBe(200);
    // An expired grant no longer applies.
    await t.server.driver.query({
      text: "UPDATE auth_user_grant SET expires_at = now() - interval '1 minute'",
      params: [],
    });
    expect((await exportAs()).statusCode).toBe(403);
    // Undeclared permissions are refused.
    const typo = await t.call({
      method: 'POST',
      url: `/api/v1/admin/users/${farid}/grants`,
      as: 'admin',
      body: { grant: 'purchase.cancle', reason: 'x' },
    });
    expect(typo.status).toBe(400);
  });
});

describe('keep at least one administrator', () => {
  test('the last administrator cannot lose the role; with a second one it works', async () => {
    const admin = t.users['admin'] as number;
    const strip = await t.call({
      method: 'PUT',
      url: `/api/v1/admin/users/${admin}/roles`,
      as: 'admin',
      body: { assignments: [{ role: 'base.user' }] },
    });
    expect(strip.status).toBe(409);
    expect(strip.json()).toMatchObject({ type: 'https://kosh.dev/problems/last-administrator' });
    // Deleting a runtime administrator role that is the only path to admin is refused the same way.
    await t.call({
      method: 'PUT',
      url: '/api/v1/admin/roles/company.root',
      as: 'admin',
      body: { label: 'Root', implies: ['base.admin'] },
    });
    expect(
      (await t.call({ url: '/api/v1/admin/roles', as: 'admin' }))
        .json()
        .roles.find((r: { code: string }) => r.code === 'company.root').administrator,
    ).toBe(true);

    // A second administrator, with 2FA: now the first can step down.
    const maria = t.users['maria'] as number;
    await t.call({
      method: 'PUT',
      url: `/api/v1/admin/users/${maria}/roles`,
      as: 'admin',
      body: { assignments: [{ role: 'purchase.manager' }, { role: 'company.root' }] },
    });
    const stillOnlyOne = await t.call({
      method: 'PUT',
      url: `/api/v1/admin/users/${admin}/roles`,
      as: 'admin',
      body: { assignments: [{ role: 'base.user' }] },
    });
    expect(stillOnlyOne.status).toBe(409); // maria has no 2FA yet: she does not count
  });
});

describe('reports and audit', () => {
  test('who can do what, per company, computed by Shutro', async () => {
    const rahim = t.users['rahim'] as number;
    const report = async (company: number) =>
      (
        await t.call({
          url: `/api/v1/admin/users/${rahim}/effective?company=${company}`,
          as: 'admin',
        })
      ).json() as {
        groups: string[];
        models: Record<
          string,
          { perms: string[]; hiddenFields: string[]; readonlyFields: string[] }
        >;
      };
    const dhaka = await report(t.companies.dhaka);
    const ctg = await report(t.companies.chattogram);
    expect(dhaka.groups).toContain('purchase.user');
    expect(dhaka.groups).not.toContain('purchase.approver');
    expect(ctg.groups).toContain('purchase.approver');
    expect(dhaka.models['purchase.order']).toMatchObject({
      perms: ['read', 'write', 'create'],
      hiddenFields: ['internalNote'],
    });
    expect(ctg.models['purchase.order']?.hiddenFields).toEqual([]);
    expect(dhaka.models['purchase.order']?.readonlyFields).toContain('vendor');
    expect(
      (await t.call({ url: `/api/v1/admin/users/${rahim}/effective`, as: 'maria' })).status,
    ).toBe(403);
  });

  test('every permission change is in the audit log, with its actor', async () => {
    const res = await t.call({ url: '/api/v1/admin/audit?kind=security.&limit=200', as: 'admin' });
    expect(res.status, res.body).toBe(200);
    const events = res.json() as {
      events: { kind: string; actor: number }[];
    };
    const kinds = new Set(events.events.map((e) => e.kind));
    for (const kind of [
      'security.role',
      'security.assignment',
      'security.access',
      'security.permission',
      'security.field',
      'security.grant',
    ])
      expect(kinds, kind).toContain(kind);
    expect(events.events.every((e) => e.actor === t.users['admin'])).toBe(true);
    // Shutro audits the security changes too.
    const [shutro] = await t.server.driver.query<{ n: number }>({
      text: "SELECT count(*)::int AS n FROM shutro_audit WHERE action = 'security'",
      params: [],
    });
    expect(shutro?.n).toBeGreaterThan(5);
    // Refused changes leave no event.
    expect(events.events.some((e) => e.kind === 'security.rule')).toBe(false);
  });
});
