/**
 * Approval routes (RFC 0003 §5.3):
 *
 * - `GET  /api/v1/approvals/inbox`                       requests the user may decide now
 * - `GET  /api/v1/approvals/:model/:id`                  the requests of a record the user can read
 * - `POST /api/v1/approvals/requests/:id/approve`        `{ comment? }`
 * - `POST /api/v1/approvals/requests/:id/reject`         `{ comment }` (why; unless the policy says otherwise)
 * - `POST /api/v1/approvals/requests/:id/send-back`      `{ comment }`: back for changes (RFC 0025)
 * - `POST /api/v1/approvals/:model/:id/withdraw`         the requester withdraws the pending approvals
 * - `GET  /api/v1/approvals/cards?list=inbox|mine|history` the Approvals app's cards (RFC 0025)
 * - `GET  /api/v1/approvals/stats`                       waiting, overdue, decided this month, the median time
 * - `POST /api/v1/approvals/bulk`                        `{ requests, comment? }`: approves each it may
 * - `POST /api/v1/approvals/requests/:id/reassign`       `{ users, mode: 'replace' | 'add', reason }` (RFC 0027)
 * - `POST /api/v1/approvals/requests/:id/notify-backups` tells the level's backups it waits (RFC 0027)
 */
import { HttpProblem, type ModuleContext } from '@kosh/server';
import type { FastifyRequest } from 'fastify';
import {
  approvalCards,
  approvalStats,
  approveMany,
  decide,
  eventsOf,
  inbox,
  notifyBackups,
  reassign,
  requestsOf,
  withdraw,
} from './approvals.js';

function positive(value: unknown, what: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new HttpProblem(400, 'invalid-id', 'Invalid id', `${what} must be a positive integer.`);
  return id;
}

function comment(request: FastifyRequest): string | undefined {
  const value = (request.body as { comment?: unknown } | null | undefined)?.comment;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 2000)
    throw new HttpProblem(
      400,
      'invalid-body',
      'Invalid body',
      'comment is a string (at most 2000 characters).',
    );
  return value;
}

/** Registers the approval routes. */
export function registerApprovalRoutes({ app }: ModuleContext): void {
  app.get('/api/v1/approvals/inbox', async (request) =>
    request.env(async (env) => ({ requests: await inbox(env) }), { write: true }),
  );
  app.get('/api/v1/approvals/:model/:id', async (request) => {
    const { model, id } = request.params as { model: string; id: string };
    const recordId = positive(id, 'id');
    return request.env(
      async (env) => ({
        requests: await requestsOf(env, model, recordId),
        events: await eventsOf(env, model, recordId),
        // Approvals managers reassign waiting requests (RFC 0027 §2.6).
        manage: env.administrator || env.groups.has('approvals.manager'),
      }),
      {
        write: true, // reads through audited system scopes
      },
    );
  });
  for (const [path, decision] of [
    ['approve', 'approve'],
    ['reject', 'reject'],
    ['send-back', 'send_back'],
  ] as const)
    app.post(`/api/v1/approvals/requests/:id/${path}`, async (request) => {
      const id = positive((request.params as { id?: unknown }).id, 'id');
      const text = comment(request);
      return request.env(async (env) => decide(env, id, decision, text));
    });
  // RFC 0027: reassigning a waiting request; telling its backups.
  app.post('/api/v1/approvals/requests/:id/reassign', async (request) => {
    const id = positive((request.params as { id?: unknown }).id, 'id');
    const body = (request.body ?? {}) as { users?: unknown; mode?: unknown; reason?: unknown };
    const users = Array.isArray(body.users) ? body.users.map((u) => positive(u, 'users')) : [];
    if (body.mode !== undefined && body.mode !== 'replace' && body.mode !== 'add')
      throw new HttpProblem(400, 'invalid-body', 'Invalid body', "mode is 'replace' or 'add'.");
    if (typeof body.reason !== 'string' || body.reason.length > 2000)
      throw new HttpProblem(
        400,
        'invalid-body',
        'Invalid body',
        'reason is a string (at most 2000).',
      );
    const mode = body.mode === 'add' ? 'add' : 'replace';
    const reason = body.reason;
    return request.env(async (env) => reassign(env, id, users, mode, reason));
  });
  app.post('/api/v1/approvals/requests/:id/notify-backups', async (request) => {
    const id = positive((request.params as { id?: unknown }).id, 'id');
    return request.env(async (env) => ({ notified: await notifyBackups(env, id) }));
  });
  // The Approvals app (RFC 0025): its lists, its header, approving many at once.
  app.get('/api/v1/approvals/cards', async (request) => {
    const list = String((request.query as { list?: unknown } | null)?.list ?? 'inbox');
    if (list !== 'inbox' && list !== 'mine' && list !== 'history')
      throw new HttpProblem(400, 'invalid-list', 'Invalid list', 'inbox, mine or history.');
    return request.env(async (env) => ({ cards: await approvalCards(env, list) }), { write: true });
  });
  app.get('/api/v1/approvals/stats', async (request) =>
    request.env(async (env) => approvalStats(env), { write: true }),
  );
  app.post('/api/v1/approvals/bulk', async (request) => {
    const body = (request.body ?? {}) as { requests?: unknown };
    const ids = Array.isArray(body.requests)
      ? body.requests.filter((v): v is number => Number.isSafeInteger(v) && Number(v) > 0)
      : [];
    if (ids.length === 0)
      throw new HttpProblem(400, 'invalid-body', 'Nothing chosen', 'requests: the request ids.');
    const text = comment(request);
    return request.env(async (env) => approveMany(env, ids, text));
  });
  // The requester withdraws their record's pending approvals (RFC 0025).
  app.post('/api/v1/approvals/:model/:id/withdraw', async (request) => {
    const { model, id } = request.params as { model: string; id: string };
    const recordId = positive(id, 'id');
    return request.env(async (env) => ({ withdrawn: await withdraw(env, model, recordId) }));
  });
}
