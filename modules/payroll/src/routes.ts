/**
 * Payroll's routes (RFC 0024 §2.3):
 *
 * - `POST /api/v1/payroll/formula`                   `{ formula }`: whether it parses, and the variables it reads
 * - `GET  /api/v1/payroll/variables?structure=`      officers: every name a rule may read, with the codes that exist
 * - `POST /api/v1/payroll/runs/:id/correction`       managers: a correction run of an approved run (computed)
 * - `GET  /api/v1/payroll/runs/:id/check`            officers: the proof of a run — `{ ok, checks }`
 * - `GET  /api/v1/payroll/payment-formats`           the payment file formats
 * - `GET  /api/v1/payroll/runs/:id/payment-file?format=`  officers: an approved run's file (bank, bkash, nagad…)
 */
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from './.kosh/bindings.js';
import {
  COMPUTE_JOB,
  checkRun,
  computeStep,
  isoDate,
  PAYMENT_FORMATS,
  paymentRows,
} from './compute.js';
import { FormulaError, parse, variablesOf } from './formula.js';
import { variablesNow } from './variables.js';

const officer = (env: Env) => env.administrator || env.groups.has('payroll.officer');

/** What `shutro.work` gives back: a worker tests drain and the server starts. */
interface Worker {
  drain(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

/**
 * The worker of large runs (RFC 0039 §2): each job computes one batch of a run in its own transaction and
 * enqueues the next, so every batch commits — the run shows how far it is, a restart goes on where it stopped,
 * and other requests are served meanwhile. Tests `drain()` it; the server starts it.
 */
export function payrollWorker(context: Pick<ModuleContext, 'shutro'>): Worker {
  return context.shutro.work(
    {
      [COMPUTE_JOB]: async (payload, raw) => {
        const { run, round } = payload as { run: number; round?: number };
        const env = raw as unknown as Env;
        // Read as the system: wages are HR's, and the officer who pressed Compute may not read them all.
        const outcome = await env.asSuperuser({ reason: 'compute payroll' }, (su) =>
          computeStep(su as unknown as Env, run, round),
        );
        if (outcome !== 'more') return;
        const [now] = await env.sql<{ n: string | number }>`
          SELECT computed_count AS n FROM payroll_run WHERE id = ${run}`;
        await env.enqueue(
          COMPUTE_JOB,
          { run, round },
          { key: `${COMPUTE_JOB}:${run}:${round ?? 0}:${Number(now?.n ?? 0)}` },
        );
      },
    },
    { pollMs: 1000 },
  ) as unknown as Worker;
}

export function registerPayrollRoutes(context: ModuleContext): void {
  const { app } = context;
  // Background work is off in the CLI and in the tests that drive the worker themselves.
  if (process.env['KOSH_SCHEDULES'] !== 'off') {
    const running = payrollWorker(context);
    running.start();
    app.addHook('onClose', () => running.stop());
  }

  app.post('/api/v1/payroll/formula', async (request) => {
    const formula = (request.body as Record<string, unknown> | null)?.['formula'];
    if (typeof formula !== 'string')
      throw new HttpProblem(422, 'invalid-formula', 'Invalid formula', 'Send { formula }.');
    return request.env(async (raw) => {
      if (!officer(raw as unknown as Env))
        throw new HttpProblem(
          403,
          'access',
          'Payroll officers',
          'This needs the Payroll officer role.',
        );
      try {
        return { ok: true, variables: [...new Set(variablesOf(parse(formula)))].sort() };
      } catch (error) {
        if (error instanceof FormulaError) return { ok: false, error: error.message };
        throw error;
      }
    });
  });

  app.get('/api/v1/payroll/variables', async (request) => {
    const raw = (request.query as Record<string, string | undefined>)['structure'];
    const structure = raw === undefined || raw === '' ? null : Number(raw);
    if (structure !== null && !(Number.isSafeInteger(structure) && structure > 0))
      throw new HttpProblem(400, 'bad-request', 'Which structure', 'structure is a number.');
    return request.env(
      async (env) => {
        if (!officer(env as unknown as Env))
          throw new HttpProblem(
            403,
            'access',
            'Payroll officers',
            'This needs the Payroll officer role.',
          );
        // Codes only, read as the system: an officer reads the structures, and no figure of anybody is here.
        return (env as unknown as Env).asSuperuser({ reason: 'payroll variables' }, (su) =>
          variablesNow(su as unknown as Env, structure),
        );
      },
      // Acting as the system is recorded: the request writes.
      { write: true },
    );
  });

  app.post('/api/v1/payroll/runs/:id/correction', async (request, reply) => {
    const id = Number((request.params as { id?: string }).id);
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        if (!env.administrator && !env.access.has('payroll.approve'))
          throw new HttpProblem(
            403,
            'access',
            'Payroll managers',
            'Corrections are made by payroll managers.',
          );
        const made = await env.asSuperuser({ reason: 'payroll correction' }, async (su) => {
          const [run] = await su
            .model('payroll.run')
            .browse([id as never])
            .load({ company: true });
          if (run === undefined)
            throw new HttpProblem(404, 'missing-record', 'Not found', `There is no run ${id}.`);
          if (run.state !== 'approved' && run.state !== 'paid')
            throw new HttpProblem(
              409,
              'not-approved',
              'Not approved',
              'Only an approved run is corrected.',
            );
          const created = await su.model('payroll.run').create([
            {
              title: `Correction of ${run.name}`,
              kind: 'correction',
              correctionOf: run.id,
              company: run.company.id,
              dateFrom: isoDate(run.dateFrom),
              dateTo: isoDate(run.dateTo),
            } as never,
          ]);
          await su.flush();
          // Computed like any run (the compute step fills the payslips with the differences).
          await su.model('payroll.run').browse(created.ids).compute();
          await audit(env, {
            kind: 'payroll.correction',
            summary: `A correction of ${run.name}.`,
            targetModel: 'payroll.run',
            targetId: created.ids[0] as number,
            ip: request.ip,
          });
          await su.flush();
          return created.ids[0] as number;
        });
        return reply.code(201).send({ id: made });
      },
      { write: true },
    );
  });

  // `GET /api/v1/payroll/runs/:id/check`: the proof of a run — whether everybody it pays has one payslip,
  // every payslip is the sum of its lines, and the run's figures are its payslips'. Officers; the same proof
  // approval asks for.
  app.get('/api/v1/payroll/runs/:id/check', async (request) => {
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(400, 'invalid-input', 'Which run', 'A run by its id.');
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        if (!officer(env))
          throw new HttpProblem(
            403,
            'access',
            'Payroll officers',
            'This needs the Payroll officer role.',
          );
        return env.asSuperuser({ reason: 'payroll run proof' }, async (su) => {
          const [run] = await su
            .model('payroll.run')
            .search({ where: { id: id as never }, limit: 1 });
          if (run === undefined)
            throw new HttpProblem(404, 'missing-record', 'Not found', `There is no run ${id}.`);
          const checks = await checkRun(su, id);
          return { ok: checks.every((c) => c.ok), checks };
        });
      },
      { write: true },
    );
  });

  app.get('/api/v1/payroll/payment-formats', async () => ({
    formats: PAYMENT_FORMATS.map((f) => ({ key: f.key, label: f.label })),
  }));

  app.get('/api/v1/payroll/runs/:id/payment-file', async (request, reply) => {
    const id = Number((request.params as { id?: string }).id);
    const format = PAYMENT_FORMATS.find(
      (f) => f.key === (request.query as { format?: string }).format,
    );
    if (format === undefined)
      throw new HttpProblem(
        422,
        'invalid-format',
        'Invalid format',
        `Choose one of: ${PAYMENT_FORMATS.map((f) => f.key).join(', ')}.`,
      );
    const out = await request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        if (!officer(env))
          throw new HttpProblem(
            403,
            'access',
            'Payroll officers',
            'This needs the Payroll officer role.',
          );
        return env.asSuperuser({ reason: 'payroll payment file' }, async (su) => {
          const [run] = await su
            .model('payroll.run')
            .browse([id as never])
            .load(['name', 'state']);
          if (run === undefined)
            throw new HttpProblem(404, 'missing-record', 'Not found', `There is no run ${id}.`);
          if (run.state !== 'approved' && run.state !== 'paid')
            throw new HttpProblem(
              409,
              'not-approved',
              'Not approved',
              'Payment files come from approved runs.',
            );
          const rows = (await paymentRows(su, id)).filter(format.takes);
          await audit(env, {
            kind: 'payroll.payment_file',
            summary: `${format.label} of ${run.name}: ${rows.length} payments.`,
            targetModel: 'payroll.run',
            targetId: id,
            ip: request.ip,
          });
          return {
            name: `${run.name.replace(/[^\w-]+/g, '_')}-${format.key}.csv`,
            text: format.render(rows),
          };
        });
      },
      { write: true },
    );
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${out.name}"`)
      .send(out.text);
  });
}
