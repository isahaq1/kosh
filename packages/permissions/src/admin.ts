/**
 * Administration APIs (RFC 0003 §5.4): roles, model access, record rules, field security, feature permissions,
 * per-company role assignments, special grants, the "who can do what" report and the audit log, without code.
 * Administrators only (the audit log and the report also for `permissions.view_audit`). Each change runs in the
 * administrator's own transaction through Shutro's `securityAdmin` (validated when saved, audited by Shutro,
 * reloaded by every process), is written to the Kosh audit log, and is refused when it would leave no
 * administrator.
 *
 * Approval policies are data: administrators edit `approval.policy` / `approval.level` through the generated API.
 */
import {
  audit,
  HttpProblem,
  keepingAdministrator,
  type ModuleContext,
  timeOf,
} from '@isahaq/kosh-server';
import type { Env } from '@isahaq/kosh-server/orm';
import type { FastifyRequest } from 'fastify';

type Row = Record<string, unknown>;
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
  unlink(): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Rows>;
  browse(ids: readonly number[]): Rows;
  create(rows: readonly unknown[]): Promise<Rows>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;
async function find(env: Env, model: string, where: unknown, keys: string[]): Promise<Row[]> {
  const set = await ref(env, model).search({ where, order: ['id asc'] });
  return set.length === 0 ? [] : (await set.load(keys)).read(keys);
}

const PERMS = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;
const RULE_PERMS = ['read', 'write', 'create', 'unlink'] as const;
const CODE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

function bad(detail: string, hint?: string): HttpProblem {
  return new HttpProblem(400, 'invalid-body', 'Invalid request', detail, hint);
}
function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const b = request.body;
  if (typeof b !== 'object' || b === null || Array.isArray(b))
    throw bad('The body must be a JSON object.');
  return b as Record<string, unknown>;
}
function strings(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
    throw bad(`${what} must be an array of strings.`);
  return value as string[];
}
function param(request: FastifyRequest, key: string): string {
  return String((request.params as Record<string, unknown>)[key] ?? '');
}
function idParam(request: FastifyRequest, key = 'id'): number {
  const id = Number(param(request, key));
  if (!Number.isSafeInteger(id) || id <= 0) throw bad(`${key} must be a positive integer.`);
  return id;
}

/** Refuses non-administrators (or, with `permission`, users without it). */
function requireAdministrator(env: Env, permission?: string): void {
  if (env.administrator) return;
  if (permission !== undefined && env.access.has(permission)) return;
  throw new HttpProblem(
    403,
    'access',
    'Administrators only',
    'Managing security needs the Administrator role (with two-factor authentication).',
    'Sign in as an administrator and complete the second factor.',
  );
}

/** Registers `/api/v1/admin/*`. */
export function registerAdminApi(context: ModuleContext): void {
  const { app, registry, shutro } = context;
  const reg = registry.registry;
  const loaded = registry.loaded;

  /** Runs a change as the administrator: guarded, audited. */
  const change = (
    request: FastifyRequest,
    kind: string,
    summary: string,
    details: unknown,
    fn: (env: Env) => Promise<void>,
  ) =>
    request.env(async (env) => {
      requireAdministrator(env);
      await keepingAdministrator(env, () => fn(env));
      await audit(env, { kind, summary, details, ip: request.ip });
      return { ok: true };
    });

  // ------------------------------------------------------------------------------------------- catalogue

  app.get('/api/v1/admin/access-levels', async (request) =>
    request.env(async (env) => {
      requireAdministrator(env);
      return {
        accessLevels: [...loaded.accessLevels.entries()].map(([code, level]) => ({
          code,
          module: level.module,
          label: level.label,
          groups: level.groups,
          implies: (level.implies ?? []).map((k) => `${level.module}.${k}`),
        })),
      };
    }),
  );

  app.get('/api/v1/admin/permissions', async (request) =>
    request.env(async (env) => {
      requireAdministrator(env);
      return {
        permissions: [...reg.security.permissions.values()].map((p) => ({
          code: p.code,
          label: p.label,
          groups: p.groups,
        })),
      };
    }),
  );

  // ------------------------------------------------------------------------------------------- roles

  const groupsOfLevels = (codes: readonly string[]): string[] =>
    codes.flatMap((code) => {
      const level = loaded.accessLevels.get(code);
      if (level === undefined)
        throw bad(
          `'${code}' is not an access level.`,
          'GET /api/v1/admin/access-levels lists them.',
        );
      return [...level.groups];
    });

  app.get('/api/v1/admin/roles', async (request) =>
    request.env(async (env) => {
      requireAdministrator(env);
      const runtime = await context.driver.query<{
        code: string;
        label: string;
        implies: string[];
        administrator: boolean;
      }>({
        text: 'SELECT code, label, implies, administrator FROM shutro_role ORDER BY code',
        params: [],
      });
      const admins = env.access.administratorGroups();
      const levelsOf = (implies: readonly string[]) => {
        const closure = reg.security.closure(implies.filter((c) => reg.security.groups.has(c)));
        return [...loaded.accessLevels.entries()]
          .filter(([, level]) => level.groups.every((g) => closure.has(g)))
          .map(([code]) => code);
      };
      return {
        roles: [
          ...[...reg.security.groups.values()].map((g) => ({
            code: g.code,
            label: g.label,
            implies: g.implies,
            administrator: admins.has(g.code),
            builtIn: true,
            accessLevels: levelsOf(g.implies),
          })),
          ...runtime.map((r) => ({
            code: r.code,
            label: r.label,
            implies: r.implies,
            administrator: admins.has(r.code),
            builtIn: false,
            accessLevels: levelsOf(r.implies),
          })),
        ],
      };
    }),
  );

  app.put('/api/v1/admin/roles/:code', async (request) => {
    const code = param(request, 'code');
    const b = bodyOf(request);
    if (!CODE.test(code))
      throw bad(`'${code}' is not a role code.`, "Use 'module.name', e.g. 'company.procurement'.");
    if (typeof b['label'] !== 'string' || b['label'] === '') throw bad('label is required.');
    const implies = [
      ...new Set([
        ...groupsOfLevels(strings(b['accessLevels'], 'accessLevels')),
        ...strings(b['implies'], 'implies'),
      ]),
    ];
    const administrator = b['administrator'] === true;
    return change(
      request,
      'security.role',
      `Role ${code} saved.`,
      { code, implies, administrator },
      (env) =>
        env.securityAdmin.saveRole({ code, label: b['label'] as string, implies, administrator }),
    );
  });

  app.delete('/api/v1/admin/roles/:code', async (request) => {
    const code = param(request, 'code');
    return change(
      request,
      'security.role_deleted',
      `Role ${code} deleted.`,
      { code },
      async (env) => {
        const assignments = await ref(env, 'auth.user_group').search({ where: { group: code } });
        if (assignments.length > 0) await assignments.unlink();
        await env.securityAdmin.deleteRole(code);
      },
    );
  });

  app.put('/api/v1/admin/roles/:code/access/:model', async (request) => {
    const role = param(request, 'code');
    const model = param(request, 'model');
    const perms = strings(bodyOf(request)['perms'], 'perms');
    for (const p of perms)
      if (!(PERMS as readonly string[]).includes(p))
        throw bad(`'${p}' is not a permission.`, `Use ${PERMS.join(', ')}.`);
    return change(
      request,
      'security.access',
      `${role} on ${model}: ${perms.join(', ') || 'none'}.`,
      { role, model, perms },
      (env) => env.securityAdmin.setAccess(role, model, perms as (typeof PERMS)[number][]),
    );
  });

  app.put('/api/v1/admin/roles/:code/rules/:name', async (request) => {
    const role = param(request, 'code');
    const name = param(request, 'name');
    const b = bodyOf(request);
    const perms = strings(b['perms'], 'perms');
    for (const p of perms)
      if (!(RULE_PERMS as readonly string[]).includes(p))
        throw bad(`'${p}' is not a rule permission.`);
    if (typeof b['model'] !== 'string') throw bad('model is required.');
    const domain = b['domain'];
    if (typeof domain !== 'object' || domain === null || Array.isArray(domain))
      throw bad('domain must be a Shutro domain object.');
    return change(
      request,
      'security.rule',
      `Rule ${name} for ${role} saved.`,
      { role, name, model: b['model'], perms, domain },
      (env) =>
        env.securityAdmin.saveRule({
          name,
          role,
          model: b['model'] as string,
          perms: perms as (typeof RULE_PERMS)[number][],
          domain: domain as Record<string, unknown>,
        }),
    );
  });

  app.delete('/api/v1/admin/rules/:name', async (request) => {
    const name = param(request, 'name');
    return change(request, 'security.rule_deleted', `Rule ${name} deleted.`, { name }, (env) =>
      env.securityAdmin.deleteRule(name),
    );
  });

  app.put('/api/v1/admin/roles/:code/permissions/:permission', async (request) => {
    const role = param(request, 'code');
    const permission = param(request, 'permission');
    return change(
      request,
      'security.permission',
      `${permission} granted to ${role}.`,
      { role, permission },
      (env) => env.securityAdmin.grantPermission(role, permission),
    );
  });

  app.delete('/api/v1/admin/roles/:code/permissions/:permission', async (request) => {
    const role = param(request, 'code');
    const permission = param(request, 'permission');
    return change(
      request,
      'security.permission_revoked',
      `${permission} revoked from ${role}.`,
      { role, permission },
      (env) => env.securityAdmin.revokePermission(role, permission),
    );
  });

  app.put('/api/v1/admin/fields/:model/:field', async (request) => {
    const model = param(request, 'model');
    const field = param(request, 'field');
    const b = bodyOf(request);
    const read = strings(b['read'], 'read');
    const write = strings(b['write'], 'write');
    return change(
      request,
      'security.field',
      `Field security of ${model}.${field} set.`,
      { model, field, read, write },
      (env) => env.securityAdmin.setFieldGroups(model, field, { read, write }),
    );
  });

  // ------------------------------------------------------------------------------------------- users

  app.get('/api/v1/admin/users/:id/roles', async (request) => {
    const user = idParam(request);
    return request.env(async (env) => {
      requireAdministrator(env);
      return {
        assignments: (await find(env, 'auth.user_group', { user }, ['group', 'company'])).map(
          (a) => ({
            id: a['id'],
            role: a['group'],
            company: a['company'] ?? null,
          }),
        ),
      };
    });
  });

  app.put('/api/v1/admin/users/:id/roles', async (request) => {
    const user = idParam(request);
    const input = bodyOf(request)['assignments'];
    if (!Array.isArray(input)) throw bad('assignments must be an array of { role, company }.');
    const assignments = input.map((a: unknown) => {
      const { role, company } = (a ?? {}) as { role?: unknown; company?: unknown };
      if (typeof role !== 'string' || !CODE.test(role))
        throw bad('Each assignment has a role code.');
      if (company !== undefined && company !== null && !Number.isSafeInteger(company))
        throw bad('company is a company id or null (every company).');
      return { user, group: role, company: (company as number | null | undefined) ?? null };
    });
    return change(
      request,
      'security.assignment',
      `Roles of user ${user} set.`,
      { user, assignments },
      async (env) => {
        const known = new Set([
          ...reg.security.groups.keys(),
          ...(
            await context.driver.query<{ code: string }>({
              text: 'SELECT code FROM shutro_role',
              params: [],
            })
          ).map((r) => r.code),
        ]);
        for (const a of assignments)
          if (!known.has(a.group))
            throw bad(`'${a.group}' is not a role.`, 'GET /api/v1/admin/roles lists them.');
        const [target] = await find(env, 'res.users', { id: user }, ['company']);
        if (target === undefined)
          throw new HttpProblem(404, 'missing-record', 'Not found', `No active user ${user}.`);
        const existing = await ref(env, 'auth.user_group').search({ where: { user } });
        if (existing.length > 0) await existing.unlink();
        if (assignments.length > 0) await ref(env, 'auth.user_group').create(assignments);
      },
    );
  });

  app.get('/api/v1/admin/users/:id/grants', async (request) => {
    const user = idParam(request);
    return request.env(async (env) => {
      requireAdministrator(env);
      return {
        grants: await find(env, 'auth.user_grant', { user }, [
          'grant',
          'company',
          'expiresAt',
          'reason',
        ]),
      };
    });
  });

  app.post('/api/v1/admin/users/:id/grants', async (request) => {
    const user = idParam(request);
    const b = bodyOf(request);
    const grant = b['grant'];
    if (typeof grant !== 'string' || !/^[a-z][\w.]*(:[a-z]+)?$/.test(grant))
      throw bad("grant is a permission code ('account.backdate') or 'model:perm'.");
    if (typeof b['reason'] !== 'string' || b['reason'] === '')
      throw bad('reason is required (audited).');
    const expiresAt =
      b['expiresAt'] === undefined || b['expiresAt'] === null
        ? null
        : new Date(String(b['expiresAt']));
    if (expiresAt !== null && Number.isNaN(expiresAt.getTime()))
      throw bad('expiresAt is an ISO date-time.');
    const company = b['company'] ?? null;
    return change(
      request,
      'security.grant',
      `${grant} granted to user ${user}.`,
      { user, grant, company, expiresAt, reason: b['reason'] },
      async (env) => {
        if (!grant.includes(':') && !reg.security.permissions.has(grant))
          throw bad(
            `'${grant}' is not a declared permission.`,
            'GET /api/v1/admin/permissions lists them.',
          );
        await ref(env, 'auth.user_grant').create([
          { user, grant, company, expiresAt, reason: b['reason'] },
        ]);
      },
    );
  });

  app.delete('/api/v1/admin/grants/:id', async (request) => {
    const id = idParam(request);
    return change(
      request,
      'security.grant_revoked',
      `Grant ${id} revoked.`,
      { id },
      async (env) => {
        const set = await ref(env, 'auth.user_grant').search({ where: { id } });
        if (set.length === 0)
          throw new HttpProblem(404, 'missing-record', 'Not found', `No grant ${id}.`);
        await set.unlink();
      },
    );
  });

  /**
   * Who can do what: the user's effective permissions in a company, computed by Shutro itself (a read-only scope
   * as that user), so the report and enforcement can never disagree.
   */
  app.get('/api/v1/admin/users/:id/effective', async (request) => {
    const user = idParam(request);
    const asked = Number((request.query as { company?: unknown }).company);
    const { groups, company, grants } = await request.env(async (env) => {
      requireAdministrator(env, 'permissions.view_audit');
      const [target] = await find(env, 'res.users', { id: user }, ['company']);
      if (target === undefined)
        throw new HttpProblem(404, 'missing-record', 'Not found', `No active user ${user}.`);
      const companyId =
        Number.isSafeInteger(asked) && asked > 0
          ? asked
          : ((target['company'] as number | null) ?? env.companyId);
      const assigned = await find(env, 'auth.user_group', { user }, ['group', 'company']);
      const now = Date.now();
      const granted = await find(env, 'auth.user_grant', { user }, [
        'grant',
        'company',
        'expiresAt',
      ]);
      return {
        company: companyId,
        groups: [
          ...new Set(
            assigned
              .filter((a) => a['company'] === null || a['company'] === companyId)
              .map((a) => String(a['group'])),
          ),
        ],
        grants: granted
          .filter(
            (g) =>
              (g['company'] === null || g['company'] === companyId) &&
              (timeOf(g['expiresAt']) ?? Number.POSITIVE_INFINITY) > now,
          )
          .map((g) => String(g['grant'])),
      };
    });
    return shutro.run({ user, company, groups, grants, readOnly: true }, async (env) => {
      const models = [...reg.models.keys()].filter((name) => !privateModel(name)).sort();
      return {
        user,
        company,
        groups: [...env.groups].sort(),
        administrator: env.administrator,
        grants,
        models: Object.fromEntries(
          models.map((name) => [
            name,
            {
              perms: PERMS.filter((p) => env.access.can(name as never, p)),
              hiddenFields: Object.keys(reg.get(name).model.fields).filter(
                (k) => !env.access.canField(name as never, k, 'read'),
              ),
              readonlyFields: Object.keys(reg.get(name).model.fields).filter(
                (k) =>
                  env.access.canField(name as never, k, 'read') &&
                  !env.access.canField(name as never, k, 'write'),
              ),
            },
          ]),
        ),
        permissions: [...reg.security.permissions.keys()]
          .filter((code) => env.access.has(code))
          .sort(),
      };
    });
  });

  const hidden = new Set(loaded.modules.flatMap((m) => m.privateModels ?? []));
  const privateModel = (name: string) => hidden.has(name);

  // ------------------------------------------------------------------------------------------- audit log

  app.get('/api/v1/admin/audit', async (request) => {
    const q = (request.query ?? {}) as { kind?: unknown; limit?: unknown; before?: unknown };
    const limit = q.limit === undefined ? 100 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw bad('limit must be 1–1000.');
    return request.env(
      async (env) => {
        requireAdministrator(env, 'permissions.view_audit');
        return env.asSuperuser({ reason: 'read audit log' }, async (su) => {
          const where: Record<string, unknown> = {};
          if (typeof q.kind === 'string' && q.kind !== '')
            where['kind'] = q.kind.endsWith('.') ? { like: `${q.kind}%` } : q.kind;
          if (q.before !== undefined) where['id'] = { lt: Number(q.before) };
          const set = await ref(su, 'audit.event').search({ where, order: ['id desc'], limit });
          const keys = [
            'kind',
            'actor',
            'company',
            'targetModel',
            'targetId',
            'summary',
            'details',
            'ip',
            'createdAt',
          ];
          return { events: set.length === 0 ? [] : (await set.load(keys)).read(keys) };
        });
      },
      { write: true },
    ); // the system read of the log is itself audited
  });
}
