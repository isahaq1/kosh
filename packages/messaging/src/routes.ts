/**
 * Chatter routes (RFC 0006 §5.1). Every route checks the record as the caller first (404 when they cannot see it).
 *
 * - `GET    /api/v1/chatter/:model/:id`              timeline page (`?beforeMessage=&beforeChange=&limit=`),
 *                                                    followers, open activities
 * - `POST   /api/v1/chatter/:model/:id/messages`     `{ kind: 'comment' | 'note', text, attachments? }`
 * - `PATCH  /api/v1/chatter/messages/:id`            `{ text }` (its author)
 * - `DELETE /api/v1/chatter/messages/:id`            (its author; with its attachments)
 * - `POST   /api/v1/chatter/:model/:id/followers`    `{ follow, user? }` (others: write access to the record)
 * - `POST   /api/v1/chatter/:model/:id/activities`   `{ type, deadline, assignee?, summary?, note? }`
 * - `PATCH  /api/v1/activities/:id`                  `{ summary?, note?, deadline?, assignee? }`
 * - `POST   /api/v1/activities/:id/done`             `{ feedback? }`
 * - `DELETE /api/v1/activities/:id`
 * - `GET    /api/v1/activities/types`, `GET /api/v1/activities/mine`
 */
import { type ModuleContext, publicApiModels } from '@kosh/server';
import { deleteObjects, positive } from '@kosh/storage';
import type { FastifyRequest } from 'fastify';
import {
  activityTypes,
  type ChatterContext,
  cancelActivity,
  chatterOf,
  completeActivity,
  deleteMessage,
  editMessage,
  type FieldMeta,
  myActivities,
  pageSize,
  postMessage,
  scheduleActivity,
  setFollower,
  updateActivity,
} from './chatter.js';

type Body = Record<string, unknown>;
const bodyOf = (request: FastifyRequest): Body => {
  const body = request.body;
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Body) : {};
};
const target = (request: FastifyRequest): { model: string; id: number } => {
  const { model, id } = request.params as { model: string; id: string };
  return { model, id: positive(id, 'id') };
};
const idOf = (request: FastifyRequest): number =>
  positive((request.params as { id?: unknown }).id, 'id');

/** The served models with the field metadata the change log shows. */
export function chatterContext(context: ModuleContext): ChatterContext {
  const models = new Map<string, ReadonlyMap<string, FieldMeta>>();
  for (const [name, model] of publicApiModels(context.registry))
    models.set(
      name,
      new Map(
        model.fields.map((f) => [
          f.key,
          { label: f.label, kind: f.kind, target: f.target, options: f.options },
        ]),
      ),
    );
  return { models };
}

/** Registers the chatter and activity routes. */
export function registerChatterRoutes(context: ModuleContext): void {
  const { app } = context;
  const chatter = chatterContext(context);

  app.get('/api/v1/chatter/:model/:id', async (request) => {
    const { model, id } = target(request);
    const query = request.query as Record<string, unknown>;
    const cursor = {
      ...(query['beforeMessage'] === undefined
        ? {}
        : { beforeMessage: positive(query['beforeMessage'], 'beforeMessage') }),
      ...(query['beforeChange'] === undefined
        ? {}
        : { beforeChange: positive(query['beforeChange'], 'beforeChange') }),
    };
    return request.env((env) =>
      chatterOf(env, chatter, model, id, cursor, pageSize(query['limit'])),
    );
  });

  app.post('/api/v1/chatter/:model/:id/messages', async (request, reply) => {
    const { model, id } = target(request);
    const message = await request.env((env) =>
      postMessage(env, chatter, model, id, bodyOf(request)),
    );
    return reply.code(201).send(message);
  });

  app.patch('/api/v1/chatter/messages/:id', async (request) => {
    const id = idOf(request);
    return request.env((env) => editMessage(env, chatter, id, bodyOf(request)));
  });

  app.delete('/api/v1/chatter/messages/:id', async (request, reply) => {
    const id = idOf(request);
    const keys = await request.env((env) => deleteMessage(env, chatter, id));
    await deleteObjects(app, keys, request);
    return reply.code(204).send();
  });

  app.post('/api/v1/chatter/:model/:id/followers', async (request) => {
    const { model, id } = target(request);
    return request.env(async (env) => ({
      followers: await setFollower(env, chatter, model, id, bodyOf(request)),
    }));
  });

  app.post('/api/v1/chatter/:model/:id/activities', async (request, reply) => {
    const { model, id } = target(request);
    const activity = await request.env((env) =>
      scheduleActivity(env, chatter, model, id, bodyOf(request)),
    );
    return reply.code(201).send(activity);
  });

  app.get('/api/v1/activities/types', async (request) =>
    request.env(async (env) => ({ types: await activityTypes(env) })),
  );

  app.get('/api/v1/activities/mine', async (request) =>
    request.env(async (env) => ({ activities: await myActivities(env, chatter) })),
  );

  app.patch('/api/v1/activities/:id', async (request, reply) => {
    const id = idOf(request);
    await request.env((env) => updateActivity(env, chatter, id, bodyOf(request)));
    return reply.code(204).send();
  });

  app.post('/api/v1/activities/:id/done', async (request) => {
    const id = idOf(request);
    return request.env((env) => completeActivity(env, chatter, id, bodyOf(request)));
  });

  app.delete('/api/v1/activities/:id', async (request, reply) => {
    const id = idOf(request);
    await request.env((env) => cancelActivity(env, chatter, id));
    return reply.code(204).send();
  });
}
