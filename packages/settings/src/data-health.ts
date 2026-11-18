/**
 * Settings › Data health (RFC 0036 §2.3), for Administrators: the checks the installed modules declare over the
 * company's data, the duplicates they know how to look for, merging the ones a person chooses, and undoing a merge.
 *
 * - `GET  /api/v1/settings/data-health`               the last recorded result for the current company
 * - `POST /api/v1/settings/data-health/run`           the checks, run now and recorded
 *
 * Unless `KOSH_SCHEDULES=off`, every company is checked once a week by itself; Administrators are notified when a
 * check that held starts to find something.
 * - `GET  /api/v1/settings/duplicates`                groups of records that look like one another
 * - `POST /api/v1/settings/duplicates/merge`          `{ model, keep, merge: [ids] }`
 * - `GET  /api/v1/settings/merges`                    the latest merges, with whether each can still be undone
 * - `POST /api/v1/settings/merges/:id/undo`
 */
import type { DuplicateSpec, KoshModule } from '@kosh/modules-sdk';
import {
  findDuplicates,
  HttpProblem,
  lastDataHealth,
  listMerges,
  type ModuleContext,
  mergeRecords,
  publicApiModels,
  runDataHealth,
  undoMerge,
} from '@kosh/server';
import type { Env } from '@kosh/server/orm';

export function registerDataHealthRoutes(context: ModuleContext): void {
  const { app } = context;
  const models = publicApiModels(context.registry);
  const modules = context.registry.loaded.modules as readonly KoshModule[];
  const specs = modules.flatMap(
    (m) => (m as { duplicates?: readonly DuplicateSpec[] }).duplicates ?? [],
  );
  const administrator = (env: Env): void => {
    if (!env.administrator)
      throw new HttpProblem(
        403,
        'access',
        'Forbidden',
        'Data health is for Administrators.',
        'Ask an Administrator.',
      );
  };
  const positive = (value: unknown, what: string): number => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0)
      throw new HttpProblem(400, 'invalid-body', 'Invalid request', `${what} is a record id.`);
    return n;
  };

  app.get('/api/v1/settings/data-health', async (request) => {
    const company = await request.env(async (env) => {
      administrator(env);
      return env.companyId as number;
    });
    const last = (await lastDataHealth(context.driver)).find((h) => h.company === company);
    return { last: last ?? null };
  });

  app.post('/api/v1/settings/data-health/run', async (request) => {
    const company = await request.env(async (env) => {
      administrator(env);
      return env.companyId as number;
    });
    return runDataHealth(context.shutro, modules, { company });
  });

  // Once a week, each company by itself (looked at every six hours, so a restart does not skip a week).
  if (process.env['KOSH_SCHEDULES'] !== 'off') {
    const WEEK = 7 * 24 * 60 * 60 * 1000;
    const due = async (): Promise<void> => {
      try {
        const last = new Map(
          (await lastDataHealth(context.driver)).map((h) => [h.company, h.checkedAt]),
        );
        const companies = await context.driver.query<{ id: number }>({
          text: 'SELECT id FROM res_company ORDER BY id',
          params: [],
        });
        for (const c of companies) {
          const at = last.get(Number(c.id));
          if (at !== undefined && Date.now() - new Date(at).getTime() < WEEK) continue;
          await runDataHealth(context.shutro, modules, { company: Number(c.id), notify: true });
        }
      } catch (error) {
        app.log.warn({ err: error }, 'the weekly data check did not run');
      }
    };
    const timer = setInterval(() => void due(), 6 * 60 * 60 * 1000);
    timer.unref();
    const first = setTimeout(() => void due(), 5 * 60 * 1000);
    first.unref();
    app.addHook('onClose', async () => {
      clearInterval(timer);
      clearTimeout(first);
    });
  }

  app.get('/api/v1/settings/duplicates', async (request) =>
    request.env(async (env) => {
      administrator(env);
      const groups = [];
      for (const spec of specs)
        for (const g of await findDuplicates(env, models, spec))
          groups.push({ ...g, label: models.get(g.model)?.label ?? g.model });
      return { groups };
    }),
  );

  app.post('/api/v1/settings/duplicates/merge', async (request) => {
    const body = (request.body ?? {}) as { model?: unknown; keep?: unknown; merge?: unknown };
    const model = String(body.model ?? '');
    if (!specs.some((s) => s.model === model))
      throw new HttpProblem(
        400,
        'invalid-body',
        'Invalid request',
        `Records of ${model || 'that model'} are not merged.`,
        `Merged: ${specs.map((s) => s.model).join(', ') || 'none'}.`,
      );
    const keep = positive(body.keep, 'keep');
    const merge = Array.isArray(body.merge) ? body.merge.map((v) => positive(v, 'merge')) : [];
    return request.env(
      async (env) => {
        administrator(env);
        return env.asSuperuser({ reason: `merge ${model}` }, (su) =>
          mergeRecords(su, models, { model, keep, merge, user: env.userId as number }),
        );
      },
      { write: true },
    );
  });

  app.get('/api/v1/settings/merges', async (request) =>
    request.env(async (env) => {
      administrator(env);
      // As the Administrator themselves: reading needs no system scope (which a read-only request cannot open).
      return { merges: await listMerges(env) };
    }),
  );

  app.post('/api/v1/settings/merges/:id/undo', async (request) => {
    const id = positive((request.params as { id?: unknown }).id, 'id');
    return request.env(
      async (env) => {
        administrator(env);
        return env.asSuperuser({ reason: `merge ${id} undone` }, (su) =>
          undoMerge(su, id, env.userId as number),
        );
      },
      { write: true },
    );
  });
}
