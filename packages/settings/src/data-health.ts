/**
 * Settings › Data health (RFC 0036 §2.3), for Administrators: the checks the installed modules declare over the
 * company's data, the duplicates they know how to look for, merging the ones a person chooses, and undoing a merge.
 *
 * - `GET  /api/v1/settings/data-health`               the checks, run now for the current company
 * - `GET  /api/v1/settings/duplicates`                groups of records that look like one another
 * - `POST /api/v1/settings/duplicates/merge`          `{ model, keep, merge: [ids] }`
 * - `GET  /api/v1/settings/merges`                    the latest merges, with whether each can still be undone
 * - `POST /api/v1/settings/merges/:id/undo`
 */
import type { DuplicateSpec, KoshModule } from '@kosh/modules-sdk';
import {
  checkData,
  findDuplicates,
  HttpProblem,
  listMerges,
  type ModuleContext,
  mergeRecords,
  publicApiModels,
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
    return checkData(context.shutro, modules, { company });
  });

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
