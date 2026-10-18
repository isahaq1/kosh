/**
 * The "keep at least one administrator" guard (CLAUDE.md, RFC 0003 §5.2): an administrator is an active user with
 * two-factor authentication on and an assignment of a group or role that makes its holder an administrator
 * (`env.access.administratorGroups()`, code groups and runtime roles). A change that leaves none is refused, also
 * for administrators and system scopes: the bypass skips permission checks, not integrity.
 */
import { HttpProblem } from '../errors.js';
import type { Env } from '../orm.js';

interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(
    keys: readonly string[],
  ): Promise<{ read(keys: readonly string[]): Record<string, unknown>[] }>;
}
const search = (env: Env, model: string, where: unknown): Promise<Rows> =>
  (env.model(model as never) as unknown as { search(q: unknown): Promise<Rows> }).search({ where });

async function rows(env: Env, model: string, where: unknown, keys: string[]) {
  const found = await search(env, model, where);
  return found.length === 0 ? [] : (await found.load(keys)).read(keys);
}

/** The ids of the active, 2FA-enabled administrators (read in a superuser scope). */
export async function administrators(env: Env): Promise<number[]> {
  return env.asSuperuser({ reason: 'check administrators' }, async (su) => {
    const codes = [...su.access.administratorGroups()];
    if (codes.length === 0) return [];
    const holders = [
      ...new Set(
        (await rows(su, 'auth.user_group', { group: { in: codes } }, ['user'])).map(
          (r) => r['user'] as number,
        ),
      ),
    ];
    if (holders.length === 0) return [];
    const active = (await search(su, 'res.users', { id: { in: holders } })).ids;
    if (active.length === 0) return [];
    return (
      await rows(su, 'auth.credential', { user: { in: [...active] }, totpEnabled: true }, ['user'])
    ).map((r) => r['user'] as number);
  });
}

/** True when the user holds an administrator group or role (in any company). */
export async function isAdministratorUser(env: Env, user: number): Promise<boolean> {
  return env.asSuperuser({ reason: 'check administrator' }, async (su) => {
    const codes = [...su.access.administratorGroups()];
    return (
      codes.length > 0 &&
      (await search(su, 'auth.user_group', { user, group: { in: codes } })).length > 0
    );
  });
}

export const LAST_ADMINISTRATOR =
  'This change would leave no active administrator with two-factor authentication.';
const HINT = 'Make another user an administrator (with 2FA enabled) first.';

/**
 * Runs `fn` and refuses (409) when it removed the last administrator. Admin APIs wrap every change of roles and
 * assignments with it. @throws {HttpProblem} 409 `last-administrator`
 */
export async function keepingAdministrator<T>(env: Env, fn: () => Promise<T>): Promise<T> {
  const before = (await administrators(env)).length;
  const result = await fn();
  await env.flush();
  if (before > 0 && (await administrators(env)).length === 0)
    throw new HttpProblem(
      409,
      'last-administrator',
      'Last administrator',
      LAST_ADMINISTRATOR,
      HINT,
    );
  return result;
}

/**
 * Shutro constraint check (on `res.users.active` and `auth.credential.totpEnabled`): the records that removed the
 * last administrator. Only changes that take an administrator away count, so installing the first one is possible.
 */
export async function lastAdministratorRemoved(
  records: { readonly env: Env; readonly ids: readonly number[] },
  userOf: (
    env: Env,
    ids: readonly number[],
  ) => Promise<{ id: number; user: number; removed: boolean }[]>,
): Promise<number[]> {
  const env = records.env;
  const changed = (await userOf(env, records.ids)).filter((c) => c.removed);
  if (changed.length === 0) return [];
  const admins: number[] = [];
  for (const c of changed) if (await isAdministratorUser(env, c.user)) admins.push(c.id);
  if (admins.length === 0) return [];
  return (await administrators(env)).length === 0 ? admins : [];
}

export { HINT as LAST_ADMINISTRATOR_HINT };
