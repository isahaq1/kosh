/**
 * Settings › Security › Single sign-on (RFC 0034 §2.4), administrators only: the OpenID Connect providers people may
 * sign in with. A provider is its issuer and this installation's client id there; its client secret is never typed
 * here — it is read from the environment, and the page says which variable and whether it is set. Everything is
 * audited.
 *
 * - `GET    /api/v1/settings/sso`            the providers, each with its callback address and its secret's state
 * - `POST   /api/v1/settings/sso`            `{ key, name, issuer, clientId, scopes?, trustEmail?, enabled? }`
 * - `PATCH  /api/v1/settings/sso/:id`        the same fields but `key`; `groupsClaim` and `groupMap`
 *                                           (`{ "<group at the provider>": ["<role>", …] }`: roles that exist,
 *                                           never an Administrator's)
 * - `DELETE /api/v1/settings/sso/:id`        the provider and the links people have to it
 * - `POST   /api/v1/settings/sso/:id/test`   reads the provider's configuration: reachable, and the issuer it says
 */
import { audit, discover, HttpProblem, type ModuleContext, ssoSecretName } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import type { FastifyRequest } from 'fastify';

type Row = Record<string, unknown>;
interface Records {
  readonly length: number;
  readonly ids: readonly number[];
  load(keys: readonly string[]): Promise<Records>;
  read(keys: readonly string[]): Row[];
  write(values: Row): Promise<void>;
  unlink(): Promise<void>;
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
const KEYS = [
  'key',
  'name',
  'issuer',
  'clientId',
  'scopes',
  'trustEmail',
  'enabled',
  'groupsClaim',
  'groupMap',
];
const bad = (detail: string, hint?: string) =>
  new HttpProblem(422, 'invalid', 'Invalid provider', detail, hint);

export function registerSsoAdminRoutes(
  context: ModuleContext,
  options: { readonly baseUrl: string },
): void {
  const { app } = context;
  const base = options.baseUrl.replace(/\/$/, '');
  const guarded = <T>(request: FastifyRequest, fn: (env: Env, su: Env) => Promise<T>) =>
    request.env(
      async (env) => {
        if (!env.administrator)
          throw new HttpProblem(
            403,
            'access',
            'Administrators only',
            'Single sign-on is set up by an Administrator.',
          );
        return env.asSuperuser({ reason: 'single sign-on settings' }, async (su) => {
          const out = await fn(env, su);
          await su.flush();
          return out;
        });
      },
      { write: true },
    );
  const idOf = (request: FastifyRequest): number => {
    const id = Number((request.params as { id?: unknown }).id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'A provider id.');
    return id;
  };
  const shown = (row: Row, people = 0) => {
    const key = String(row['key']);
    const secret = process.env[ssoSecretName(key)];
    return {
      id: row['id'] as number,
      key,
      name: String(row['name']),
      issuer: String(row['issuer']),
      clientId: String(row['clientId']),
      scopes: String(row['scopes']),
      trustEmail: row['trustEmail'] === true,
      enabled: row['enabled'] !== false,
      groupsClaim: String(row['groupsClaim'] ?? 'groups'),
      groupMap: (row['groupMap'] as Record<string, string[]> | null) ?? {},
      /** What to register at the provider as the redirect address. */
      callbackUrl: `${base}/api/v1/auth/sso/${key}/callback`,
      /** Where the client secret is read from, and whether it is there: without it nobody is offered the provider. */
      secretName: ssoSecretName(key),
      secretSet: secret !== undefined && secret !== '',
      people,
    };
  };
  /** A map of provider groups to roles: roles that exist, and none an Administrator's. */
  const groupMapOf = (
    value: unknown,
    administrators: ReadonlySet<string>,
  ): Record<string, string[]> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw bad('groupMap maps each group at the provider to a list of roles.');
    const known = context.registry.registry.security.groups;
    const out: Record<string, string[]> = {};
    for (const [group, roles] of Object.entries(value as Row)) {
      const name = group.trim();
      if (name === '' || name.length > 200) throw bad('A group at the provider has a name.');
      if (!Array.isArray(roles) || roles.some((r) => typeof r !== 'string'))
        throw bad(`${name}: its roles are a list of role codes.`);
      const codes = [...new Set((roles as string[]).map((r) => r.trim()).filter((r) => r !== ''))];
      for (const code of codes) {
        if (!known.has(code as never))
          throw bad(
            `${name}: there is no role ${code}.`,
            'Roles are named as in Settings › Roles & permissions (sales.user, account.manager).',
          );
        if (administrators.has(code))
          throw bad(
            `${name}: ${code} is an Administrator role, which a provider never gives.`,
            'Make someone an Administrator in Settings › People.',
          );
      }
      if (codes.length > 0) out[name] = codes;
    }
    return out;
  };
  /** The fields of a request, checked. */
  const values = (body: Row, creating: boolean): Row => {
    const out: Row = {};
    const text = (name: string, max: number): string | undefined => {
      const v = body[name];
      if (v === undefined) return undefined;
      if (typeof v !== 'string' || v.trim() === '' || v.length > max)
        throw bad(`${name} is a text of at most ${max} characters.`);
      return v.trim();
    };
    const key = text('key', 31);
    if (creating) {
      if (key === undefined || !/^[a-z][a-z0-9-]{1,30}$/.test(key))
        throw bad(
          'The key is 2 to 31 lower-case letters, digits and hyphens, starting with a letter.',
          'It is in the sign-in address and in the name of the secret: google, microsoft, keycloak.',
        );
      out['key'] = key;
    }
    for (const [name, max] of [
      ['name', 60],
      ['clientId', 300],
      ['scopes', 200],
    ] as const) {
      const v = text(name, max);
      if (v !== undefined) out[name] = v;
    }
    const issuer = text('issuer', 300);
    if (issuer !== undefined) {
      // Tokens are only as good as the connection they came over.
      if (
        !/^https:\/\/[^\s/]+/.test(issuer) &&
        !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(issuer)
      )
        throw bad(
          'The issuer is an https address.',
          'For example https://accounts.google.com, or your Keycloak realm’s address.',
        );
      out['issuer'] = issuer.replace(/\/$/, '');
    }
    if (typeof out['scopes'] === 'string' && !out['scopes'].split(/\s+/).includes('openid'))
      throw bad('The scopes include openid.');
    for (const flag of ['trustEmail', 'enabled'])
      if (body[flag] !== undefined) {
        if (typeof body[flag] !== 'boolean') throw bad(`${flag} is true or false.`);
        out[flag] = body[flag];
      }
    const claim = text('groupsClaim', 100);
    if (claim !== undefined) out['groupsClaim'] = claim;
    if (creating)
      for (const required of ['name', 'issuer', 'clientId'])
        if (out[required] === undefined) throw bad(`${required} is needed.`);
    return out;
  };

  app.get('/api/v1/settings/sso', async (request) =>
    guarded(request, async (_env, su) => {
      const providers = await rows(
        ref(su, 'auth.sso_provider').search({ where: {}, order: ['name asc'] }),
        KEYS,
      );
      const out = [];
      for (const p of providers) {
        const linked = await ref(su, 'auth.sso_identity').search({ where: { provider: p['id'] } });
        out.push(shown(p, linked.length));
      }
      return { providers: out };
    }),
  );

  app.post('/api/v1/settings/sso', async (request) => {
    const body = (request.body ?? {}) as Row;
    const fields = values(body, true);
    return guarded(request, async (env, su) => {
      if (body['groupMap'] !== undefined)
        fields['groupMap'] = groupMapOf(body['groupMap'], new Set(su.access.administratorGroups()));
      const taken = await ref(su, 'auth.sso_provider').search({ where: { key: fields['key'] } });
      if (taken.length > 0)
        throw new HttpProblem(
          409,
          'taken',
          'Key taken',
          `A provider has the key ${fields['key']}.`,
        );
      const made = await ref(su, 'auth.sso_provider').create([fields]);
      const [row] = await rows(made, KEYS);
      await audit(su, {
        kind: 'security.sso_provider_added',
        summary: `Single sign-on provider ${String(fields['name'])} (${String(fields['issuer'])}) added.`,
        actor: env.userId as number,
        ip: request.ip,
      });
      return shown(row as Row);
    });
  });

  app.patch('/api/v1/settings/sso/:id', async (request) => {
    const id = idOf(request);
    const body = (request.body ?? {}) as Row;
    const fields = values(body, false);
    return guarded(request, async (env, su) => {
      if (body['groupMap'] !== undefined)
        fields['groupMap'] = groupMapOf(body['groupMap'], new Set(su.access.administratorGroups()));
      const found = await ref(su, 'auth.sso_provider').search({ where: { id }, limit: 1 });
      if (found.length === 0)
        throw new HttpProblem(404, 'missing-record', 'Not found', `No provider ${id}.`);
      if (Object.keys(fields).length > 0) await found.write(fields);
      const [row] = await rows(ref(su, 'auth.sso_provider').search({ where: { id } }), KEYS);
      await audit(su, {
        kind: 'security.sso_provider_changed',
        summary: `Single sign-on provider ${String(row?.['name'])} changed: ${Object.keys(fields).join(', ') || 'nothing'}.`,
        actor: env.userId as number,
        ip: request.ip,
      });
      return shown(row as Row);
    });
  });

  app.delete('/api/v1/settings/sso/:id', async (request) => {
    const id = idOf(request);
    return guarded(request, async (env, su) => {
      const found = await ref(su, 'auth.sso_provider').search({ where: { id }, limit: 1 });
      const [row] = await rows(found, ['name']);
      if (row === undefined)
        throw new HttpProblem(404, 'missing-record', 'Not found', `No provider ${id}.`);
      await found.unlink();
      await audit(su, {
        kind: 'security.sso_provider_removed',
        summary: `Single sign-on provider ${String(row['name'])} removed; people sign in with their password again.`,
        actor: env.userId as number,
        ip: request.ip,
      });
      return { ok: true };
    });
  });

  app.post('/api/v1/settings/sso/:id/test', async (request) => {
    const id = idOf(request);
    const issuer = await guarded(request, async (_env, su) => {
      const [row] = await rows(ref(su, 'auth.sso_provider').search({ where: { id } }), ['issuer']);
      if (row === undefined)
        throw new HttpProblem(404, 'missing-record', 'Not found', `No provider ${id}.`);
      return String(row['issuer']);
    });
    try {
      const found = await discover(issuer);
      return { ok: true, issuer: found.issuer, authorization: found.authorization_endpoint };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
