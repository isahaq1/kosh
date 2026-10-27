/**
 * Background imports (RFC 0014 §5.3): a file of more than `INLINE_ROWS` rows runs as a Shutro job, as the user who
 * started it, in the job's one transaction (all-or-nothing stays all-or-nothing). Progress is written in short
 * transactions of its own so the screen sees it; the end emits `import.finished`, which the notification inbox
 * turns into a notification for the user. A fault is retried by Shutro; on the last attempt, or for a refusal (the
 * user lost a permission), the session goes back to draft with the reason.
 */
import { problemOf } from '@kosh/server';
import type { Worker } from '@kosh/server/orm';
import {
  createImportService,
  FINISHED_TOPIC,
  type ImportContext,
  type ImportService,
  RUN_JOB,
  ref,
  type Session,
} from './service.js';

export function importWorker(
  context: ImportContext,
  service: ImportService = createImportService(context),
): Worker {
  return context.shutro.work(
    {
      [RUN_JOB]: async (payload, env, job) => {
        const { session: id, dryRun } = payload as { session: number; dryRun: boolean };
        let session: Session;
        try {
          session = await service.sessionOf(env, id);
        } catch (error) {
          if (problemOf(error).status === 404) return; // deleted since
          throw error;
        }
        if (session.state !== 'running') return;
        try {
          const result = await service.execute(env, session, dryRun, (done, total) =>
            service.reportProgress(env.companyId, id, done, total),
          );
          await service.record(env, session, result, dryRun);
          await env.emit(FINISHED_TOPIC, {
            model: 'import.session',
            id,
            dry: dryRun,
            file: session.fileName,
            created: dryRun ? result.wouldCreate : result.created.length,
            updated: dryRun ? result.wouldUpdate : result.updated.length,
            errors: result.errors.length,
          });
        } catch (error) {
          const problem = problemOf(error);
          if (problem.status >= 500 && job.attempt < job.maxAttempts) throw error; // retried
          const failure = (
            problem.status >= 500
              ? 'The import failed; try again.'
              : (problem.detail ?? problem.title)
          ).slice(0, 500);
          await context.shutro.bootstrap(
            { reason: 'import failed', company: env.companyId },
            async (su) => {
              const found = await ref(su, 'import.session').search({ where: { id }, limit: 1 });
              await found.write({ state: 'draft', failure });
            },
          );
        }
      },
    },
    { pollMs: 5000 },
  );
}
