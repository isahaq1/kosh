/**
 * Helpdesk's routes (RFC 0024 §2.4):
 *
 * - `POST /api/v1/helpdesk/refresh`                   managers: the SLA, assignment and resumption, now
 * - `POST /api/v1/helpdesk/tickets/:id/merge`         `{ into }`: the ticket's conversation moved into another, it
 *                                                     marked merged (agents of both tickets' teams)
 * - `GET  /api/v1/helpdesk/tickets/:id/canned/:reply` a canned reply filled in for the ticket
 * - `GET  /api/v1/public/helpdesk/rate?token=&score=` the customer's rating from the emailed link, once (no sign-in,
 *                                                     rate limited)
 */
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from './.kosh/bindings.js';
import { rate, refreshSla } from './sla.js';

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

export function registerHelpdeskRoutes(context: ModuleContext): void {
  const { app } = context;

  app.post('/api/v1/helpdesk/refresh', async (request) =>
    request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        if (!env.administrator && !env.groups.has('helpdesk.manager'))
          throw new HttpProblem(
            403,
            'access',
            'Helpdesk managers',
            'This needs the Helpdesk manager role.',
          );
        return env.asSuperuser({ reason: 'helpdesk refresh' }, async (su) => ({
          tickets: await refreshSla(su),
        }));
      },
      { write: true },
    ),
  );

  app.post('/api/v1/helpdesk/tickets/:id/merge', async (request) => {
    const id = Number((request.params as { id?: string }).id);
    const into = Number((request.body as Record<string, unknown> | null)?.['into']);
    if (!Number.isSafeInteger(into) || into === id)
      throw new HttpProblem(
        422,
        'invalid-merge',
        'Merge into which ticket?',
        'Give another ticket as `into`.',
      );
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        // Both tickets as the agent sees them: their rules decide.
        const both = await env
          .model('helpdesk.ticket')
          .search({ where: { id: { in: [id, into] } as never } });
        if (both.length !== 2)
          throw new HttpProblem(
            404,
            'missing-record',
            'Not found',
            'Both tickets must be yours to see.',
          );
        return env.asSuperuser({ reason: 'helpdesk merge' }, async (su) => {
          const [source] = await su
            .model('helpdesk.ticket')
            .browse([id as never])
            .load(['name', 'state']);
          const [target] = await su
            .model('helpdesk.ticket')
            .browse([into as never])
            .load(['name', 'state']);
          if (
            source === undefined ||
            target === undefined ||
            !['open', 'waiting'].includes(source.state)
          )
            throw new HttpProblem(409, 'not-open', 'Not open', 'Only an open ticket is merged.');
          if (target.state === 'merged')
            throw new HttpProblem(
              409,
              'merged',
              'Already merged',
              'Merge into a ticket that is not merged itself.',
            );
          const messages = await su
            .model('mail.message')
            .search({ where: { resModel: 'helpdesk.ticket', resId: id } });
          if (messages.length > 0) await messages.write({ resId: into } as never);
          await su
            .model('helpdesk.ticket')
            .browse([id as never])
            .write({ mergedInto: into } as never);
          await su.flush();
          await su
            .model('helpdesk.ticket')
            .browse([id as never])
            .merge();
          await audit(env, {
            kind: 'helpdesk.merged',
            summary: `${source.name} merged into ${target.name}.`,
            targetModel: 'helpdesk.ticket',
            targetId: into,
            ip: request.ip,
          });
          await su.flush();
          return { id, into, moved: messages.length };
        });
      },
      { write: true },
    );
  });

  app.get('/api/v1/helpdesk/tickets/:id/canned/:reply', async (request) => {
    const { id, reply } = request.params as { id?: string; reply?: string };
    return request.env(async (raw) => {
      const env = raw as unknown as Env;
      const [ticket] = await (
        await env.model('helpdesk.ticket').search({ where: { id: Number(id) as never }, limit: 1 })
      ).load({ partner: true, assignee: true });
      const [canned] = await (
        await env
          .model('helpdesk.canned')
          .search({ where: { id: Number(reply) as never }, limit: 1 })
      ).load(['body']);
      if (ticket === undefined || canned === undefined)
        throw new HttpProblem(
          404,
          'missing-record',
          'Not found',
          'No such ticket or canned reply.',
        );
      const fill: Record<string, string> = {
        customer: ticket.partner?.name ?? ticket.email ?? '',
        ticket: ticket.name,
        agent: ticket.assignee?.name ?? '',
      };
      return {
        text: canned.body.replace(
          /\{\{\s*(customer|ticket|agent)\s*\}\}/g,
          (_, k: string) => fill[k] ?? '',
        ),
      };
    });
  });

  app.get('/api/v1/public/helpdesk/rate', { config: { auth: false } }, async (request, reply) => {
    const q = request.query as { token?: string; score?: string; comment?: string };
    const token = typeof q.token === 'string' ? q.token : '';
    const score = Number(q.score);
    const comment =
      typeof q.comment === 'string' && q.comment.trim() !== '' ? q.comment.slice(0, 2000) : null;
    const name =
      token.length < 20
        ? null
        : await context.shutro.bootstrap({ reason: 'helpdesk rating' }, (env) =>
            // The token names the ticket, whatever its company.
            (env as unknown as Env).asSuperuser({ reason: 'helpdesk rating' }, (su) =>
              rate(su.withFlags({ checkCompany: false }) as Env, token, score, comment),
            ),
          );
    const text =
      name === null
        ? 'This link was used already, or is not valid.'
        : `Thank you — your rating of ${'★'.repeat(score)} for ${name} is recorded.`;
    return reply
      .code(name === null ? 404 : 200)
      .header('content-type', 'text/html; charset=utf-8')
      .send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Rating</title><p style="font:16px system-ui;margin:3em auto;max-width:30em;text-align:center">${escapeHtml(text)}</p>`,
      );
  });

  // The clock, every five minutes, company by company (off in the CLI and in tests).
  if (process.env['KOSH_SCHEDULES'] === 'off') return;
  const run = async () => {
    try {
      const companies = await context.shutro.bootstrap(
        { reason: 'helpdesk clock' },
        async (env) => (await (env as unknown as Env).model('res.company').search({})).ids,
      );
      for (const company of companies)
        await context.shutro.bootstrap({ reason: 'helpdesk clock', company }, (env) =>
          (env as unknown as Env).asSuperuser({ reason: 'helpdesk clock' }, (su) => refreshSla(su)),
        );
    } catch (error) {
      app.log.error({ err: error }, 'helpdesk clock');
    }
  };
  const timer = setInterval(() => void run(), 5 * 60_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
