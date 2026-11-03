/**
 * Payroll's routes (RFC 0024 §2.3):
 *
 * - `POST /api/v1/payroll/formula`                   `{ formula }`: whether it parses, and the variables it reads
 * - `POST /api/v1/payroll/runs/:id/correction`       managers: a correction run of an approved run (computed)
 * - `GET  /api/v1/payroll/payment-formats`           the payment file formats
 * - `GET  /api/v1/payroll/runs/:id/payment-file?format=`  officers: an approved run's file (bank, bkash, nagad…)
 */
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from './.kosh/bindings.js';
import { isoDate, PAYMENT_FORMATS, paymentRows } from './compute.js';
import { FormulaError, parse, variablesOf } from './formula.js';

const officer = (env: Env) => env.administrator || env.groups.has('payroll.officer');

export function registerPayrollRoutes({ app }: ModuleContext): void {
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
