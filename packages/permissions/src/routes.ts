/**
 * Approval routes (RFC 0003 §5.3):
 *
 * - `GET  /api/v1/approvals/inbox`                       requests the user may decide now
 * - `GET  /api/v1/approvals/:model/:id`                  the requests of a record the user can read
 * - `POST /api/v1/approvals/requests/:id/approve`        `{ comment? }`
 * - `POST /api/v1/approvals/requests/:id/reject`         `{ comment? }`
 */
import { HttpProblem, type ModuleContext } from '@kosh/server';
import type { FastifyRequest } from 'fastify';
import { decide, inbox, requestsOf } from './approvals.js';

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
    return request.env(async (env) => ({ requests: await requestsOf(env, model, recordId) }), {
      write: true, // reads through audited system scopes
    });
  });
  for (const decision of ['approve', 'reject'] as const)
    app.post(`/api/v1/approvals/requests/:id/${decision}`, async (request) => {
      const id = positive((request.params as { id?: unknown }).id, 'id');
      const text = comment(request);
      return request.env(async (env) => decide(env, id, decision, text));
    });
}
