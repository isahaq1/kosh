/**
 * Inbound email routes (RFC 0006 §7.1).
 *
 * - `POST /api/v1/mail/inbound`            the provider's webhook: a raw message (`message/rfc822`, `text/plain`)
 *                                           or JSON (Postmark, or `{ RawEmail }`), authenticated by
 *                                           `MAIL_INBOUND_WEBHOOK_SECRET` (`X-Kosh-Inbound-Secret`, or `?secret=`)
 * - `GET  /api/v1/mail/inbound?state=`      the log (`mail.manager`)
 * - `POST /api/v1/mail/inbound/:id/attach`  `{ model, id }`: posts a quarantined message on a record
 * - `POST /api/v1/mail/inbound/:id/discard`
 * - `POST /api/v1/mail/inbound/:id/retry`   resolves a quarantined message again
 */
import { timingSafeEqual } from 'node:crypto';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { positive } from '@kosh/storage';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  attachInbound,
  discardInbound,
  type InboundContext,
  listInbound,
  receiveMail,
  retryInbound,
} from './handle.js';
import { parseInbound } from './parse.js';

const MAX_BODY = 25 * 1024 * 1024;

function secretMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Registers the routes. `webhookSecret` undefined: the webhook answers 404 (replies by email are off). */
export function registerInboundRoutes(
  context: ModuleContext,
  inbound: InboundContext,
  options: { readonly webhookSecret?: string | undefined },
): void {
  const { app } = context;

  // The webhook: no session, a shared secret; the body is the message, whatever its type.
  app.register(async (hook: FastifyInstance) => {
    hook.removeAllContentTypeParsers();
    hook.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_BODY }, (_req, body, done) =>
      done(null, body),
    );
    hook.post('/api/v1/mail/inbound', { config: { public: true } }, async (request, reply) => {
      const secret = options.webhookSecret;
      if (secret === undefined || secret === '')
        throw new HttpProblem(404, 'not-found', 'Not found', 'Inbound email is not configured.');
      const given =
        request.headers['x-kosh-inbound-secret'] ??
        (request.query as { secret?: unknown } | undefined)?.secret;
      if (!secretMatches(given, secret))
        throw new HttpProblem(
          401,
          'unauthenticated',
          'Unauthorized',
          'The inbound secret is wrong.',
        );
      const body = request.body;
      if (!(body instanceof Uint8Array) || body.byteLength === 0)
        throw new HttpProblem(
          400,
          'invalid-body',
          'Empty message',
          'The request body is the message.',
        );
      const contentType = String(request.headers['content-type'] ?? 'message/rfc822');
      let mail: Awaited<ReturnType<typeof parseInbound>>;
      try {
        mail = await parseInbound(body, contentType);
      } catch (error) {
        throw new HttpProblem(
          400,
          'invalid-message',
          'Unreadable message',
          error instanceof Error ? error.message : String(error),
        );
      }
      // The source is kept for a retry: a raw message or JSON as sent; a form post as the message it carried.
      const raw = /form-data|x-www-form-urlencoded/i.test(contentType)
        ? null
        : new TextDecoder().decode(body);
      const outcome = await receiveMail(inbound, mail, raw);
      return reply.code(outcome.duplicate ? 200 : 202).send(outcome);
    });
  });

  const idOf = (request: FastifyRequest): number =>
    positive((request.params as { id?: unknown }).id, 'id');
  const bodyOf = (request: FastifyRequest): Record<string, unknown> => {
    const body = request.body;
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  };

  app.get('/api/v1/mail/inbound', async (request) => {
    const query = request.query as { state?: unknown; limit?: unknown };
    const state = typeof query.state === 'string' && query.state !== '' ? query.state : undefined;
    const limit = query.limit === undefined ? 50 : Math.min(200, positive(query.limit, 'limit'));
    return request.env(async (env) => ({ items: await listInbound(env, state, limit) }));
  });

  app.post('/api/v1/mail/inbound/:id/attach', async (request) => {
    const id = idOf(request);
    const body = bodyOf(request);
    if (typeof body['model'] !== 'string' || body['model'] === '')
      throw new HttpProblem(400, 'invalid-body', 'Invalid request', 'model is a model name.');
    const target = { model: body['model'], id: positive(body['id'], 'id') };
    return request.env((env) => attachInbound(inbound, env, id, target), { write: true });
  });

  app.post('/api/v1/mail/inbound/:id/discard', async (request) => {
    const id = idOf(request);
    return request.env((env) => discardInbound(env, id), { write: true });
  });

  app.post('/api/v1/mail/inbound/:id/retry', async (request) => {
    const id = idOf(request);
    return request.env((env) => retryInbound(inbound, env, id), { write: true });
  });
}
