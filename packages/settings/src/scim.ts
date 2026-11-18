/**
 * Settings › Security › Directory provisioning (RFC 0034 §2.4), administrators only: the tokens the company's
 * directory (Entra ID, Okta, any SCIM 2.0 client) provisions people with, and the roles each of its groups gives.
 * A token is shown once, when it is made; only its digest is kept. Everything is audited.
 *
 * - `GET    /api/v1/settings/scim`               the address to give the directory, the tokens, the groups
 * - `POST   /api/v1/settings/scim/tokens`        `{ name, company? }` → the token, once
 * - `DELETE /api/v1/settings/scim/tokens/:id`    revokes it: the directory is refused from now on
 * - `PATCH  /api/v1/settings/scim/groups/:id`    `{ roles: ["sales.user", …] }`: roles that exist, never an
 *                                               Administrator's; given to and taken from its members at once
 */
import { randomBytes } from 'node:crypto';
import { audit, HttpProblem, type ModuleContext, scimTokenHash, syncScimRoles } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import type { FastifyRequest } from 'fastify';

type Row = Record<string, unknown>;
interface Records {
  readonly length: number;
  readonly ids: readonly number[];
  load(keys: readonly string[]): Promise<Records>;
  read(keys: readonly string[]): Row[];
  write(values: Row): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Records>;
  create(rows: readonly Row[]): Promise<Records>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;
const rows = async (set: Records | Promise<Records>, keys: readonly string[]): Promise<Row[]> => {
  const s = await set;
  return s.length === 0 ? [] : (await s.load(keys)).read(['id', ...keys]);
};
const idOf = (v: unknown): number =>
  typeof v === 'object' && v !== null ? Number((v as { id: unknown }).id) : Number(v);
const bad = (detail: string, hint?: string) =>
  new HttpProblem(422, 'invalid', 'Invalid value', detail, hint);

export function registerScimAdminRoutes(
  context: ModuleContext,
  options: { readonly baseUrl: string },
): void {
  const { app } = context;
  const base = `${options.baseUrl.replace(/\/$/, '')}/api/scim/v2`;
  const guarded = <T>(request: FastifyRequest, fn: (env: Env, su: Env) => Promise<T>) =>
    request.env(
      async (env) => {
        if (!env.administrator)
          throw new HttpProblem(
            403,
            'access',
            'Administrators only',
            'Directory provisioning is set up by an Administrator.',
          );
        return env.asSuperuser({ reason: 'directory provisioning settings' }, async (su) => {
          const out = await fn(env, su);
          await su.flush();
          return out;
        });
      },
      { write: true },
    );
  const paramId = (request: FastifyRequest): number => {
    const id = Number((request.params as { id?: unknown }).id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'An id.');
    return id;
  };

  app.get('/api/v1/settings/scim', async (request) =>
    guarded(request, async (_env, su) => {
      const tokens = await rows(
        ref(su, 'auth.scim_token').search({ where: { revoked: false }, order: ['id asc'] }),
        ['name', 'prefix', 'company', 'lastUsedAt', 'createdAt'],
      );
      const companies = new Map(
        (
          await rows(
            ref(su, 'res.company').search({
              where: { id: { in: tokens.map((t) => idOf(t['company'])) } },
            }),
            ['name'],
          )
        ).map((c) => [c['id'] as number, String(c['name'])]),
      );
      const groups = await rows(
        ref(su, 'auth.scim_group').search({ where: {}, order: ['displayName asc'] }),
        ['displayName', 'roles'],
      );
      const members = await rows(ref(su, 'auth.scim_member').search({ where: {} }), ['group']);
      const people = await ref(su, 'auth.scim_user').search({ where: {} });
      return {
        /** What to give the directory as the tenant (SCIM) address. */
        baseUrl: base,
        people: people.length,
        tokens: tokens.map((t) => ({
          id: t['id'] as number,
          name: String(t['name']),
          prefix: String(t['prefix']),
          company: {
            id: idOf(t['company']),
            name: companies.get(idOf(t['company'])) ?? '',
          },
          lastUsedAt: t['lastUsedAt'] ?? null,
          createdAt: t['createdAt'] ?? null,
        })),
        groups: groups.map((g) => ({
          id: g['id'] as number,
          name: String(g['displayName']),
          roles: Array.isArray(g['roles']) ? (g['roles'] as string[]) : [],
          members: members.filter((m) => idOf(m['group']) === g['id']).length,
        })),
      };
    }),
  );

  app.post('/api/v1/settings/scim/tokens', async (request) => {
    const body = (request.body ?? {}) as Row;
    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    if (name === '' || name.length > 60)
      throw bad('The token has a name of at most 60 characters.', 'For example: Entra ID.');
    return guarded(request, async (env, su) => {
      const company = body['company'] === undefined ? env.companyId : Number(body['company']);
      const found = await rows(ref(su, 'res.company').search({ where: { id: company } }), ['name']);
      if (found.length === 0) throw bad('The company does not exist.');
      // 256 bits, shown once: only its digest is kept.
      const token = `scim_${randomBytes(32).toString('base64url')}`;
      const made = await ref(su, 'auth.scim_token').create([
        { name, tokenHash: scimTokenHash(token), prefix: token.slice(0, 10), company },
      ]);
      await audit(su, {
        kind: 'security.scim_token_added',
        summary: `Directory token ${name} made for ${String(found[0]?.['name'])}.`,
        actor: env.userId as number,
        ip: request.ip,
      });
      return { id: made.ids[0] as number, name, token, baseUrl: base };
    });
  });

  app.delete('/api/v1/settings/scim/tokens/:id', async (request) => {
    const id = paramId(request);
    return guarded(request, async (env, su) => {
      const found = await ref(su, 'auth.scim_token').search({ where: { id, revoked: false } });
      const [row] = await rows(found, ['name']);
      if (row === undefined)
        throw new HttpProblem(404, 'missing-record', 'Not found', `No token ${id}.`);
      await found.write({ revoked: true });
      await audit(su, {
        kind: 'security.scim_token_revoked',
        summary: `Directory token ${String(row['name'])} revoked: the directory is refused from now on.`,
        actor: env.userId as number,
        ip: request.ip,
      });
      return { ok: true };
    });
  });

  app.patch('/api/v1/settings/scim/groups/:id', async (request) => {
    const id = paramId(request);
    const value = ((request.body ?? {}) as Row)['roles'];
    if (!Array.isArray(value) || value.some((r) => typeof r !== 'string'))
      throw bad('roles is a list of role codes.');
    const codes = [...new Set((value as string[]).map((r) => r.trim()).filter((r) => r !== ''))];
    const changed = await guarded(request, async (env, su) => {
      const known = context.registry.registry.security.groups;
      const administrators = new Set(su.access.administratorGroups());
      for (const code of codes) {
        if (!known.has(code as never))
          throw bad(
            `There is no role ${code}.`,
            'Roles are named as in Settings › Roles & permissions (sales.user, account.manager).',
          );
        if (administrators.has(code))
          throw bad(
            `${code} is an Administrator role, which a directory never gives.`,
            'Make someone an Administrator in Settings › People.',
          );
      }
      const found = await ref(su, 'auth.scim_group').search({ where: { id }, limit: 1 });
      const [row] = await rows(found, ['displayName', 'roles']);
      if (row === undefined)
        throw new HttpProblem(404, 'missing-record', 'Not found', `No group ${id}.`);
      const before = Array.isArray(row['roles']) ? (row['roles'] as string[]) : [];
      await found.write({ roles: codes });
      await audit(su, {
        kind: 'security.scim_group_roles',
        summary:
          `Directory group ${String(row['displayName'])} gives: ${codes.join(', ') || 'no role'} (before: ${before.join(', ') || 'no role'}).`.slice(
            0,
            500,
          ),
        actor: env.userId as number,
        ip: request.ip,
      });
      // Its members hold the new roles at once; the ones it no longer gives are taken.
      return syncScimRoles(su, 'all', {
        by: `the directory group ${String(row['displayName'])}`,
        ip: request.ip,
        released: before,
      });
    });
    for (const user of changed) context.auth?.forget(user);
    return { ok: true, roles: codes, changed: changed.length };
  });
}
