/**
 * A role in full, and the effect of changing it (RFC 0019 §3.3), for Settings › Roles & permissions. Administrators
 * only.
 *
 * - `GET  /api/v1/admin/roles/:code`          the role: its label, access levels, holders, and per model and feature
 *                                              permission what it grants — from code (locked), through the roles it
 *                                              includes, and its own runtime grants (editable) — with its record rules
 *                                              and field security; the models and permissions to choose from
 * - `POST /api/v1/admin/roles/:code/preview`  `{ accessLevels?, implies?, access?, permissions? }` (the role's own
 *                                              proposed state): who gains and who loses which app access and feature
 *                                              permission — counting their other roles —, and the model changes
 *
 * Runtime security is read through Shutro (`securityAdmin.describe()`, request #30), never from its tables.
 */
import type { KoshModule } from '@kosh/modules-sdk';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env, RuntimeSecurityDescription } from '@kosh/server/orm';
import type { FastifyRequest } from 'fastify';
import { requireAdministrator } from './admin.js';

type Row = Record<string, unknown>;
const PERMS = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;
type Perm = (typeof PERMS)[number];

interface Records {
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
}
const find = async (env: Env, model: string, where: unknown, keys: string[]) => {
  const set = (await (
    env.model(model as never) as unknown as {
      search(q: unknown): Promise<Records>;
    }
  ).search({ where, order: ['id asc'] })) as Records;
  return set.length === 0 ? [] : (await set.load(keys)).read(['id', ...keys]);
};
const bad = (detail: string) => new HttpProblem(400, 'invalid-body', 'Invalid request', detail);

export function registerRoleRoutes(context: ModuleContext): void {
  const { app, registry } = context;
  const reg = registry.registry;
  const loaded = registry.loaded;
  const modules = loaded.modules as readonly KoshModule[];
  const hidden = new Set(modules.flatMap((m) => m.privateModels ?? []));
  const appOf = new Map(modules.map((m) => [m.name, m.app?.label ?? null]));

  /** Every group a set of roles amounts to: declared groups' closure, runtime roles followed through. */
  const closureOf = (codes: Iterable<string>, runtime: RuntimeSecurityDescription): Set<string> => {
    const roles = new Map(runtime.roles.map((r) => [r.code, r]));
    const seen = new Set<string>();
    const queue = [...codes];
    while (queue.length > 0) {
      const code = queue.pop() as string;
      if (seen.has(code)) continue;
      seen.add(code);
      for (const next of roles.get(code)?.implies ?? []) queue.push(next);
    }
    return new Set([
      ...seen,
      ...reg.security.closure([...seen].filter((c) => reg.security.groups.has(c))),
    ]);
  };
  /** What a set of groups grants: per model the permissions, and the feature permissions. */
  const grants = (
    groups: ReadonlySet<string>,
    runtime: RuntimeSecurityDescription,
    except?: string,
  ) => {
    const models = new Map<string, Set<Perm>>();
    for (const [name, model] of reg.models) {
      const access = (model.model.access ?? {}) as Readonly<Record<string, readonly string[]>>;
      const perms = new Set<Perm>();
      for (const g of groups) for (const p of access[g] ?? []) perms.add(p as Perm);
      if (perms.size > 0) models.set(name, perms);
    }
    for (const a of runtime.access)
      if (groups.has(a.role) && a.role !== except)
        for (const p of a.perms) {
          const set = models.get(a.model) ?? new Set<Perm>();
          set.add(p as Perm);
          models.set(a.model, set);
        }
    const permissions = new Set<string>();
    for (const p of reg.security.permissions.values())
      if (p.groups.some((g) => groups.has(g))) permissions.add(p.code);
    for (const g of runtime.permissions)
      if (groups.has(g.role) && g.role !== except) permissions.add(g.permission);
    const levels = new Set(
      [...loaded.accessLevels.entries()]
        .filter(([, level]) => level.groups.length > 0 && level.groups.every((g) => groups.has(g)))
        .map(([code]) => code),
    );
    return { models, permissions, levels };
  };
  const levelLabel = (code: string) => {
    const level = loaded.accessLevels.get(code);
    return level === undefined
      ? code
      : `${appOf.get(level.module) ?? level.module} · ${level.label}`;
  };
  const permissionLabel = (code: string) => reg.security.permissions.get(code)?.label ?? code;
  /** The role, whether declared in code or made at runtime. */
  const roleOf = (code: string, runtime: RuntimeSecurityDescription) => {
    const declared = reg.security.groups.get(code);
    if (declared !== undefined)
      return {
        code,
        label: declared.label ?? code,
        implies: [...(declared.implies ?? [])],
        builtIn: true,
      };
    const made = runtime.roles.find((r) => r.code === code);
    if (made === undefined)
      throw new HttpProblem(404, 'missing-record', 'Not found', `There is no role '${code}'.`);
    return { code, label: made.label, implies: [...made.implies], builtIn: false };
  };
  const holdersOf = async (env: Env, code: string) =>
    env.asSuperuser({ reason: 'role holders' }, async (su) => {
      const assigned = await find(su, 'auth.user_group', { group: code }, ['user']);
      const ids = [...new Set(assigned.map((a) => a['user'] as number))];
      if (ids.length === 0) return [];
      return (await find(su, 'res.users', { id: { in: ids } }, ['name', 'login'])).map((u) => ({
        id: u['id'] as number,
        name: String(u['name']),
        login: String(u['login']),
      }));
    });
  const codeParam = (request: FastifyRequest) => String((request.params as Row)['code'] ?? '');

  app.get('/api/v1/admin/roles/:code', async (request) => {
    const code = codeParam(request);
    return request.env(
      async (env) => {
        requireAdministrator(env);
        const runtime = await env.securityAdmin.describe();
        const role = roleOf(code, runtime);
        const closure = closureOf([code], runtime);
        // Locked: what code and the included roles give; own: this role's runtime grants.
        const locked = grants(closure, runtime, code);
        const own = new Map(
          runtime.access.filter((a) => a.role === code).map((a) => [a.model, [...a.perms]]),
        );
        const ownPermissions = runtime.permissions
          .filter((p) => p.role === code)
          .map((p) => p.permission);
        return {
          ...role,
          administrator: env.access.administratorGroups().has(code),
          accessLevels: [...grants(closureOf(role.implies, runtime), runtime).levels],
          holders: await holdersOf(env, code),
          models: [...reg.models]
            .filter(([name]) => !hidden.has(name) && !name.startsWith('shutro.'))
            .map(([name, model]) => ({
              name,
              label: (model.model as { label?: string }).label ?? name,
              app: appOf.get(model.module) ?? null,
              locked: [...(locked.models.get(name) ?? [])],
              own: own.get(name) ?? [],
            }))
            // Apps first (by name), technical models last.
            .sort(
              (a, b) =>
                Number(a.app === null) - Number(b.app === null) ||
                (a.app ?? '').localeCompare(b.app ?? '') ||
                a.label.localeCompare(b.label),
            ),
          permissions: [...reg.security.permissions.values()].map((p) => ({
            code: p.code,
            label: p.label ?? p.code,
            locked: locked.permissions.has(p.code),
            own: ownPermissions.includes(p.code),
          })),
          rules: runtime.rules.filter((r) => r.role === code),
          fields: runtime.fields.filter((f) => f.read.includes(code) || f.write.includes(code)),
        };
      },
      { write: true },
    );
  });

  app.post('/api/v1/admin/roles/:code/preview', async (request) => {
    const code = codeParam(request);
    const body = (request.body ?? {}) as Row;
    const list = (v: unknown, what: string): string[] | undefined => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))
        throw bad(`${what} is a list of codes.`);
      return v as string[];
    };
    const levels = list(body['accessLevels'], 'accessLevels');
    const implies = list(body['implies'], 'implies');
    const permissions = list(body['permissions'], 'permissions');
    const access = body['access'];
    if (
      access !== undefined &&
      (typeof access !== 'object' || access === null || Array.isArray(access))
    )
      throw bad('access is { model: [permissions] }.');
    return request.env(
      async (env) => {
        requireAdministrator(env);
        const runtime = await env.securityAdmin.describe();
        const role = roleOf(code, runtime);
        // The role's proposed state, as a runtime overlay of itself.
        const levelGroups = (levels ?? []).flatMap((l) => {
          const level = loaded.accessLevels.get(l);
          if (level === undefined) throw bad(`'${l}' is not an access level.`);
          return [...level.groups];
        });
        const proposedImplies =
          levels === undefined && implies === undefined
            ? role.implies
            : [...new Set([...levelGroups, ...(implies ?? [])])];
        const ownAccess = (access ??
          Object.fromEntries(
            runtime.access.filter((a) => a.role === code).map((a) => [a.model, a.perms]),
          )) as Record<string, readonly string[]>;
        const proposed: RuntimeSecurityDescription = {
          ...runtime,
          roles: role.builtIn
            ? runtime.roles
            : runtime.roles.map((r) => (r.code === code ? { ...r, implies: proposedImplies } : r)),
          access: [
            ...runtime.access.filter((a) => a.role !== code),
            ...Object.entries(ownAccess).map(([model, perms]) => ({
              role: code,
              model,
              perms: perms as Perm[],
            })),
          ],
          permissions:
            permissions === undefined
              ? runtime.permissions
              : [
                  ...runtime.permissions.filter((p) => p.role !== code),
                  ...permissions.map((permission) => ({ role: code, permission })),
                ],
        };
        const before = grants(closureOf([code], runtime), runtime);
        const after = grants(closureOf([code], proposed), proposed);
        const holders = await holdersOf(env, code);
        const others = await env.asSuperuser({ reason: 'role preview' }, (su) =>
          find(su, 'auth.user_group', { user: { in: holders.map((h) => h.id) } }, [
            'user',
            'group',
          ]),
        );
        const people = holders
          .map((h) => {
            const elsewhere = grants(
              closureOf(
                others
                  .filter((o) => o['user'] === h.id && o['group'] !== code)
                  .map((o) => String(o['group'])),
                runtime,
              ),
              runtime,
            );
            const diff = (from: Set<string>, to: Set<string>, kept: Set<string>) =>
              [...to].filter((x) => !from.has(x) && !kept.has(x));
            return {
              id: h.id,
              name: h.name,
              gains: [
                ...diff(before.levels, after.levels, elsewhere.levels).map(levelLabel),
                ...diff(before.permissions, after.permissions, elsewhere.permissions).map(
                  permissionLabel,
                ),
              ],
              losses: [
                ...diff(after.levels, before.levels, elsewhere.levels).map(levelLabel),
                ...diff(after.permissions, before.permissions, elsewhere.permissions).map(
                  permissionLabel,
                ),
              ],
            };
          })
          .filter((p) => p.gains.length > 0 || p.losses.length > 0);
        const models = [...new Set([...before.models.keys(), ...after.models.keys()])]
          .map((name) => {
            const was = before.models.get(name) ?? new Set<Perm>();
            const will = after.models.get(name) ?? new Set<Perm>();
            return {
              model: name,
              label: (reg.models.get(name)?.model as { label?: string } | undefined)?.label ?? name,
              added: PERMS.filter((p) => will.has(p) && !was.has(p)),
              removed: PERMS.filter((p) => was.has(p) && !will.has(p)),
            };
          })
          .filter((m) => m.added.length > 0 || m.removed.length > 0);
        return { holders: holders.length, people, models };
      },
      { write: true },
    );
  });
}
