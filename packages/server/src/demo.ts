/**
 * Demo data (RFC 0008 §5.8): each module's `hooks.demo` seeds a realistic sample set, made as demo users through
 * the models so that audit, sequences, approvals and record rules apply as for real data. Loaded once per module
 * (`kosh_module.demo_at`), in dependency order, only when an installation asks for it (`kosh init --demo`); a
 * failed run resumes with the modules still to do. The demo users share one password, {@link DEMO_PASSWORD}.
 */
import type { DemoContext, DemoUser, KoshModule } from '@kosh/modules-sdk';
import { APPS_TABLE, appTableStatements } from './apps.js';
import type { AuthService } from './auth/service.js';
import type { Driver, Env, Shutro } from './orm.js';

/** The demo users' password (every demo user; printed by `kosh init --demo`). */
export const DEMO_PASSWORD = 'shutro demo 2026';

/** What one module's seeder did. */
export interface DemoResult {
  readonly module: string;
  readonly summary: string;
}

export interface InstallDemoOptions {
  readonly shutro: Shutro;
  readonly auth: AuthService;
  readonly driver: Pick<Driver, 'query'>;
  /** The served modules, dependencies first (the registry's order). */
  readonly modules: readonly KoshModule[];
  readonly company: number;
  /** Progress lines (`contacts: 10 partners`). */
  readonly write?: ((line: string) => void) | undefined;
}

type Rows = {
  readonly length: number;
  readonly ids: readonly number[];
  load(spec: unknown): Promise<Rows>;
  read(keys: readonly string[]): Record<string, unknown>[];
};
type Model = {
  search(query: unknown): Promise<Rows>;
  create(rows: readonly unknown[]): Promise<Rows>;
};
const model = (env: Env, name: string): Model => env.model(name as never) as unknown as Model;

/** Loads the demo data of the modules that have none yet. Returns a line per module that seeded something. */
export async function installDemo(options: InstallDemoOptions): Promise<DemoResult[]> {
  const { shutro, auth, driver, company } = options;
  for (const q of appTableStatements()) await driver.query(q);
  const done = new Set(
    (
      await driver.query<{ name: string }>({
        text: `SELECT name FROM ${APPS_TABLE} WHERE demo_at IS NOT NULL`,
        params: [],
      })
    ).map((r) => r.name),
  );
  const users = new Map<string, number>();
  /** The demo user's id: found by login, or created; the groups asked for are added when missing. */
  const userOf = async (user: DemoUser): Promise<number> => {
    const known = users.get(user.login);
    const id =
      known ??
      (await shutro.bootstrap({ reason: `demo user ${user.login}`, company }, async (env) => {
        const found = await model(env, 'res.users').search({ where: { login: user.login } });
        return found.length === 0 ? null : (found.ids[0] as number);
      }));
    if (id === null) {
      const created = await auth.createUser({
        login: user.login,
        name: user.name,
        password: DEMO_PASSWORD,
        company,
        companies: [company],
        groups: [...user.groups],
      });
      users.set(user.login, created);
      return created;
    }
    users.set(user.login, id);
    await shutro.bootstrap({ reason: `demo user ${user.login}`, company }, async (env) => {
      const groups = model(env, 'auth.user_group');
      const held = (await (await groups.search({ where: { user: id } })).load(['group']))
        .read(['group'])
        .map((r) => String(r['group']));
      const missing = user.groups.filter((g) => !held.includes(g));
      if (missing.length > 0) await groups.create(missing.map((group) => ({ user: id, group })));
    });
    return id;
  };
  const groupsOf = (uid: number): Promise<string[]> =>
    shutro.bootstrap({ reason: 'demo identity', company }, async (env) => {
      const rows = await (
        await model(env, 'auth.user_group').search({ where: { user: uid } })
      ).load(['group', 'company']);
      return rows
        .read(['group', 'company'])
        .filter(
          (r) => r['company'] === null || r['company'] === undefined || r['company'] === company,
        )
        .map((r) => String(r['group']));
    });
  const context: DemoContext = {
    company,
    modules: options.modules,
    async as(user, fn) {
      const uid = await userOf(user);
      const groups = await groupsOf(uid);
      return shutro.run(
        { user: uid, company, companies: [company], groups, reason: 'demo data' },
        (env) => fn(env),
      );
    },
    system: (reason, fn) =>
      shutro.bootstrap({ reason: `demo: ${reason}`, company }, (env) => fn(env)),
    date: (days) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    },
  };
  const out: DemoResult[] = [];
  for (const m of options.modules) {
    if (m.hooks?.demo === undefined || done.has(m.name)) continue;
    const summary = await m.hooks.demo(context);
    await driver.query({
      text: `UPDATE ${APPS_TABLE} SET demo_at = now() WHERE name = $1`,
      params: [m.name],
    });
    if (summary !== undefined) {
      out.push({ module: m.name, summary });
      options.write?.(`${m.name}: ${summary}`);
    }
  }
  return out;
}
