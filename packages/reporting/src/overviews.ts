/**
 * App overviews (RFC 0022 §3.2): the cards an app declares in its manifest become a shared dashboard keyed by the
 * module, installed once (`hooks.defaults`, idempotent: a dashboard a user has since changed is left alone), and
 * opened by the app's generated *Overview* menu through `GET /api/v1/reports/overview?app=`.
 */
import type { KoshModule } from '@kosh/modules-sdk';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';

type Dashboards = {
  search(query: { readonly where: Record<string, unknown>; readonly limit?: number }): Promise<{
    readonly ids: readonly number[];
    read(fields: readonly string[]): Record<string, unknown>[];
    load(
      fields: readonly string[],
    ): Promise<{ read(fields: readonly string[]): Record<string, unknown>[] }>;
  }>;
  create(values: readonly Record<string, unknown>[]): Promise<{ readonly ids: readonly number[] }>;
};
const dashboards = (env: Env): Dashboards =>
  (env as unknown as { model(name: string): Dashboards }).model('report.dashboard');

/** Installs the overview dashboards the served modules declare and do not have yet; returns how many. */
export async function installOverviews(env: Env, modules: readonly KoshModule[]): Promise<number> {
  let created = 0;
  for (const m of modules) {
    if (m.overview === undefined || m.app === undefined) continue;
    const existing = await dashboards(env).search({ where: { key: m.name }, limit: 1 });
    if (existing.ids.length > 0) continue;
    await dashboards(env).create([
      {
        name: `${m.app.label} — Overview`,
        key: m.name,
        shared: true,
        items: m.overview.cards.map((card) => ({ ...card })),
      },
    ]);
    created += 1;
  }
  return created;
}

/**
 * `GET /api/v1/reports/overview?app=sales`: the app's overview — its label and cards — for the Overview page. Read
 * as the system (the dashboard itself needs the reports' access; the cards then query as the user), for any user
 * who may open the app's menu.
 */
export function registerOverviewRoutes(context: ModuleContext): void {
  const { app, registry, shutro } = context;
  app.get('/api/v1/reports/overview', async (request) => {
    const code = String((request.query as { app?: unknown } | null)?.app ?? '');
    const module = registry.loaded.modules.find((m) => m.app?.code === code);
    if (module === undefined || module.overview === undefined)
      throw new HttpProblem(
        404,
        'no-overview',
        'No overview',
        `The app '${code}' has no overview.`,
      );
    // Signed in (the route is not public); the app's visibility is the menu's.
    await request.env(async () => undefined);
    const row = await shutro.bootstrap({ reason: `overview of ${code}` }, async (env) => {
      const found = await dashboards(env as unknown as Env).search({
        where: { key: module.name },
        limit: 1,
      });
      const [first] = (await found.load(['name', 'items'])).read(['id', 'name', 'items']);
      return first;
    });
    if (row === undefined)
      throw new HttpProblem(
        404,
        'no-overview',
        'No overview',
        `The overview of '${code}' is not installed yet (run the apps' defaults).`,
      );
    return {
      id: row['id'],
      name: row['name'],
      app: code,
      label: module.app?.label ?? code,
      cards: row['items'],
    };
  });
}
