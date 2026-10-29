/**
 * Settings › Security (RFC 0019 §3.5), administrators only: the installation's policy — two-factor sign-in for
 * administrators only (the default) or for everyone, and how long a sign-in lasts — with who it would stop until
 * they set two-factor up; and who is signed in where, with sign-out of any session. The audit log has its own route
 * (`/api/v1/admin/audit`, `@kosh/permissions`). Everything is audited.
 *
 * - `GET   /api/v1/settings/security`        the policy; the people without two-factor sign-in
 * - `PATCH /api/v1/settings/security`        `{ twoFactor?: 'administrators' | 'everyone', sessionDays?: 1–90 | null }`
 * - `GET   /api/v1/settings/sessions`        every active session (the person, device, address, last use)
 * - `DELETE /api/v1/settings/sessions/:id`   signs that session out
 */
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
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
const iso = (v: unknown) =>
  v === null || v === undefined ? null : new Date(v instanceof Date ? v : String(v)).toISOString();

export function registerSecurityRoutes(context: ModuleContext): void {
  const { app, registry } = context;
  const auth = context.auth;
  if (auth === undefined) return;
  /** Portal users: not the company's people, the policy is not theirs. */
  const external = new Set(registry.loaded.modules.flatMap((m) => m.externalGroups ?? []));

  const guarded = <T>(request: FastifyRequest, fn: (env: Env, su: Env) => Promise<T>) =>
    request.env(
      async (env) => {
        if (!env.administrator)
          throw new HttpProblem(
            403,
            'access',
            'Administrators only',
            'Security settings need the Administrator role.',
          );
        return env.asSuperuser({ reason: 'security settings' }, async (su) => {
          const out = await fn(env, su);
          await su.flush();
          return out;
        });
      },
      { write: true },
    );

  /** People who sign in (not service accounts, not portal users) without two-factor sign-in. */
  const withoutTwoFactor = async (su: Env) => {
    const people = await rows(
      ref(su, 'res.users').search({ where: { isService: { ne: true } }, order: ['name asc'] }),
      ['name', 'login'],
    );
    const ids = people.map((p) => p['id'] as number);
    if (ids.length === 0) return [];
    const on = new Set(
      (
        await rows(
          ref(su, 'auth.credential').search({ where: { user: { in: ids }, totpEnabled: true } }),
          ['user'],
        )
      ).map((c) => c['user']),
    );
    const groups = await rows(ref(su, 'auth.user_group').search({ where: { user: { in: ids } } }), [
      'user',
      'group',
    ]);
    const isExternal = (id: number) => {
      const own = groups.filter((g) => g['user'] === id).map((g) => String(g['group']));
      return own.length > 0 && own.every((g) => external.has(g));
    };
    return people
      .filter((p) => !on.has(p['id']) && !isExternal(p['id'] as number))
      .map((p) => ({ id: p['id'] as number, name: String(p['name']), login: String(p['login']) }));
  };

  const read = async (su: Env) => ({
    ...(await auth.policy()),
    withoutTwoFactor: await withoutTwoFactor(su),
  });

  app.get('/api/v1/settings/security', async (request) => guarded(request, (_env, su) => read(su)));

  app.patch('/api/v1/settings/security', async (request) => {
    const body = (request.body ?? {}) as Row;
    const values: Row = {};
    if (body['twoFactor'] !== undefined) {
      if (body['twoFactor'] !== 'administrators' && body['twoFactor'] !== 'everyone')
        throw new HttpProblem(
          422,
          'invalid-policy',
          'Invalid policy',
          "Two-factor sign-in is required of 'administrators' or 'everyone'.",
        );
      values['twoFactor'] = body['twoFactor'];
    }
    if (body['sessionDays'] !== undefined) {
      const days = body['sessionDays'];
      if (
        days !== null &&
        !(Number.isInteger(days) && (days as number) >= 1 && (days as number) <= 90)
      )
        throw new HttpProblem(
          422,
          'invalid-policy',
          'Invalid policy',
          'A sign-in lasts 1 to 90 days, or empty for the server’s setting.',
        );
      values['sessionDays'] = days;
    }
    await guarded(request, async (env, su) => {
      if (Object.keys(values).length > 0) {
        const current = await ref(su, 'auth.policy').search({ where: {}, limit: 1 });
        if (current.length === 0) await ref(su, 'auth.policy').create([values]);
        else await current.write(values);
        await audit(env, {
          kind: 'security.policy',
          summary: `Security policy changed: ${Object.entries(values)
            .map(([k, v]) => `${k} = ${v ?? 'default'}`)
            .join(', ')}.`,
          details: values,
          ip: request.ip,
        });
      }
    });
    // After the commit: the policy applies to every request from now on (this node; others within the cache time).
    auth.forgetPolicy();
    return guarded(request, (_env, su) => read(su));
  });

  app.get('/api/v1/settings/sessions', async (request) => {
    const current = await auth.session(request);
    return guarded(request, async (_env, su) => {
      const sessions = await rows(
        ref(su, 'auth.session').search({
          where: { revoked: false, expiresAt: { gt: new Date() } },
          order: ['lastSeenAt desc', 'id desc'],
          limit: 500,
        }),
        ['user', 'ip', 'userAgent', 'lastSeenAt', 'createdAt', 'secondFactor', 'twoFactorVerified'],
      );
      const users = [...new Set(sessions.map((s) => s['user'] as number))];
      const people =
        users.length === 0
          ? []
          : await rows(ref(su, 'res.users').search({ where: { id: { in: users } } }), [
              'name',
              'login',
            ]);
      const person = new Map(people.map((p) => [p['id'], p]));
      return {
        sessions: sessions
          // Sign-ins still waiting for their second factor are not in yet.
          .filter((s) => s['twoFactorVerified'] === true)
          .map((s) => ({
            id: s['id'] as number,
            user: s['user'] as number,
            name: String(person.get(s['user'])?.['name'] ?? ''),
            login: String(person.get(s['user'])?.['login'] ?? ''),
            ip: typeof s['ip'] === 'string' ? s['ip'] : null,
            userAgent: typeof s['userAgent'] === 'string' ? s['userAgent'] : null,
            lastSeenAt: iso(s['lastSeenAt']),
            createdAt: iso(s['createdAt']),
            secondFactor: s['secondFactor'] === true,
            current: s['id'] === current?.id,
          })),
      };
    });
  });

  app.delete('/api/v1/settings/sessions/:id', async (request) => {
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'The id is a positive integer.');
    const current = await auth.session(request);
    if (current?.id === id)
      throw new HttpProblem(
        409,
        'current-session',
        'This is your session',
        'Sign out from the user menu to end your own session.',
      );
    const user = await guarded(request, async (env, su) => {
      const set = await ref(su, 'auth.session').search({ where: { id, revoked: false } });
      const [row] = await rows(set, ['user']);
      if (row === undefined)
        throw new HttpProblem(404, 'missing-record', 'Not found', `There is no session ${id}.`);
      await set.write({ revoked: true });
      const [who] = await rows(ref(su, 'res.users').search({ where: { id: row['user'] } }), [
        'login',
      ]);
      await audit(env, {
        kind: 'security.session_revoked',
        summary: `Signed out a session of ${String(who?.['login'] ?? row['user'])}.`,
        targetModel: 'res.users',
        targetId: row['user'] as number,
        ip: request.ip,
      });
      return row['user'] as number;
    });
    auth.forget(user);
    return { revoked: 1 };
  });
}
