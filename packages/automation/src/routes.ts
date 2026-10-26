/**
 * The automation routes (RFC 0011): what the generated API of `automation.rule` and `automation.run` does not
 * cover.
 *
 * - `GET  /api/v1/automation/actions`            the actions modules declare (key, label, model, params)
 * - `GET  /api/v1/automation/models/:model`      what a rule may use on a model: the tracked fields, the
 *                                                transitions, the fields with their kinds
 * - `POST /api/v1/automation/rules/:id/test`     `{ record }`: a dry run (the condition, the rendered actions)
 * - `POST /api/v1/automation/runs/:id/retry`     runs a failed run's actions again (a new run)
 * - `POST /api/v1/automation/poll`               reads the pending changes and events now (managers)
 */
import { HttpProblem, type ModuleContext, publicApiModels } from '@kosh/server';
import type { FastifyRequest } from 'fastify';
import {
  type AutomationContext,
  pollAudit,
  pollOutbox,
  retryRun,
  testRule,
  trackedFields,
} from './engine.js';

const positive = (value: unknown, what: string): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new HttpProblem(400, 'invalid-id', 'Invalid id', `${what} is a positive integer.`);
  return n;
};
const idOf = (request: FastifyRequest): number =>
  positive((request.params as { id?: unknown }).id, 'id');

export function registerAutomationRoutes(context: ModuleContext, engine: AutomationContext): void {
  const { app } = context;

  app.get('/api/v1/automation/actions', async (request) =>
    request.env(async () => ({
      actions: [...engine.actions.values()].map((a) => ({
        key: a.key,
        label: a.label,
        model: a.model ?? null,
        params: a.params ?? [],
      })),
    })),
  );

  app.get('/api/v1/automation/models/:model', async (request) => {
    const name = String((request.params as { model: string }).model);
    const model = publicApiModels(context.registry).get(name);
    if (model === undefined)
      throw new HttpProblem(404, 'unknown-model', 'Unknown model', `No model '${name}'.`);
    return request.env(async (env) => {
      if (!env.access.can(name as never, 'read'))
        throw new HttpProblem(403, 'forbidden', 'Forbidden', 'No read access to the model.');
      return {
        model: name,
        tracked: trackedFields(engine, name),
        transitions: model.transitions,
        fields: model.fields.map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.kind,
          target: f.target ?? null,
        })),
      };
    });
  });

  app.post('/api/v1/automation/rules/:id/test', async (request) => {
    const id = idOf(request);
    const record = positive((request.body as { record?: unknown } | null)?.record, 'record');
    return request.env((env) => testRule(engine, env, id, record));
  });

  app.post('/api/v1/automation/poll', async (request) => {
    await request.env(async (env) => {
      if (!env.access.can('automation.rule' as never, 'write'))
        throw new HttpProblem(403, 'forbidden', 'Forbidden', 'Automation managers run the engine.');
    });
    const audit = await pollAudit(engine);
    const outbox = await pollOutbox(engine);
    return {
      changes: audit?.changes ?? 0,
      events: outbox?.events ?? 0,
      runs: (audit?.runs ?? 0) + (outbox?.runs ?? 0),
    };
  });

  app.post('/api/v1/automation/runs/:id/retry', async (request) => {
    const id = idOf(request);
    return request.env(async (env) => ({ outcomes: await retryRun(engine, env, id) }), {
      write: true,
    });
  });
}
