/**
 * E-invoicing, e-way bills and the company's GST settings over HTTP (RFC 0016 step 5, part 4), and the subscriber
 * that registers documents when they are posted:
 *
 * - `GET /api/v1/l10n_in/einvoice/:id` — a document's e-invoice and e-way bill;
 * - `POST /api/v1/l10n_in/einvoice/:id` — register it with the IRP; `POST …/cancel { reason, remark }`;
 * - `POST /api/v1/l10n_in/ewaybill/:id { mode, distanceKm, vehicleNo, transporterId? }`; `POST …/cancel`;
 * - `GET` / `PUT /api/v1/l10n_in/settings` — the company's GSTIN, PAN, address and e-invoicing switch (managers).
 */
import { HttpProblem, type ModuleContext } from '@kosh/server';
import type { Worker } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import {
  cancelEInvoice,
  cancelEwayBill,
  einvoiceState,
  type GstProvider,
  generateEwayBill,
  registerEInvoice,
  registerPosted,
} from './einvoice.js';
import { gstinProblem } from './module.js';

const idOf = (params: unknown) => {
  const id = Number((params as { id?: string }).id);
  if (!Number.isInteger(id) || id <= 0)
    throw new HttpProblem(
      400,
      'invalid-id',
      'Invalid id',
      'The document id is a positive integer.',
    );
  return id;
};
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** The company's GST settings. */
async function readSettings(env: Env) {
  const [c] = await env.model('res.company').search({ where: { id: env.companyRef }, limit: 1 });
  return {
    gstin: c?.gstin ?? null,
    pan: c?.pan ?? null,
    street: c?.street ?? null,
    city: c?.city ?? null,
    zip: c?.zip ?? null,
    state: c?.state ?? null,
    einvoiceEnabled: c?.einvoiceEnabled ?? false,
  };
}

export function registerEInvoiceRoutes(
  context: ModuleContext,
  provider: GstProvider | undefined,
): void {
  const { app } = context;
  app.get('/api/v1/l10n_in/einvoice/:id', async (request) => {
    const id = idOf(request.params);
    return request.env(async (raw) => {
      const env = raw as unknown as Env;
      const [company] = await env
        .model('res.company')
        .search({ where: { id: env.companyRef }, limit: 1 });
      return {
        // E-invoicing is Indian: other companies of an installation with l10n_in do not see it.
        applicable: company?.country === 'IN',
        provider: provider?.name ?? null,
        ...(await einvoiceState(env, id)),
      };
    });
  });
  app.post('/api/v1/l10n_in/einvoice/:id', async (request) => {
    const id = idOf(request.params);
    return request.env((env) => registerEInvoice(env as unknown as Env, provider, id), {
      write: true,
    });
  });
  app.post('/api/v1/l10n_in/einvoice/:id/cancel', async (request) => {
    const id = idOf(request.params);
    const body = (request.body ?? {}) as { reason?: unknown; remark?: unknown };
    return request.env(
      (env) =>
        cancelEInvoice(
          env as unknown as Env,
          provider,
          id,
          String(body.reason ?? ''),
          text(body.remark),
        ),
      { write: true },
    );
  });
  app.post('/api/v1/l10n_in/ewaybill/:id', async (request) => {
    const id = idOf(request.params);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const mode = body['mode'] ?? 'road';
    if (mode !== 'road' && mode !== 'rail' && mode !== 'air' && mode !== 'ship')
      throw new HttpProblem(
        400,
        'invalid-body',
        'Invalid request',
        'mode is road, rail, air or ship.',
      );
    const transporterId = text(body['transporterId']);
    return request.env(
      (env) =>
        generateEwayBill(env as unknown as Env, provider, id, {
          mode,
          distanceKm: Number(body['distanceKm']),
          vehicleNo: text(body['vehicleNo']).toUpperCase().replace(/[\s-]/g, ''),
          ...(transporterId === '' ? {} : { transporterId }),
        }),
      { write: true },
    );
  });
  app.post('/api/v1/l10n_in/ewaybill/:id/cancel', async (request) => {
    const id = idOf(request.params);
    const body = (request.body ?? {}) as { reason?: unknown; remark?: unknown };
    return request.env(
      (env) =>
        cancelEwayBill(
          env as unknown as Env,
          provider,
          id,
          String(body.reason ?? '4'),
          text(body.remark),
        ),
      { write: true },
    );
  });

  app.get('/api/v1/l10n_in/settings', async (request) =>
    request.env(async (env) => ({
      provider: provider?.name ?? null,
      ...(await readSettings(env as unknown as Env)),
    })),
  );
  app.put('/api/v1/l10n_in/settings', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const values: Record<string, unknown> = {};
    for (const key of ['gstin', 'pan', 'street', 'city', 'zip'] as const)
      if (body[key] !== undefined) {
        const v = text(body[key]);
        values[key] = v === '' ? null : key === 'gstin' || key === 'pan' ? v.toUpperCase() : v;
      }
    if (body['einvoiceEnabled'] !== undefined)
      values['einvoiceEnabled'] = body['einvoiceEnabled'] === true;
    if (typeof values['zip'] === 'string' && !/^\d{6}$/.test(values['zip']))
      throw new HttpProblem(400, 'invalid-body', 'Invalid request', 'A PIN code has 6 digits.');
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        if (!env.access.has('account.settings'))
          throw new HttpProblem(
            403,
            'access',
            'Forbidden',
            'Changing the GST settings needs the account.settings permission.',
            'Ask for the Accounting manager access level.',
          );
        const current = await readSettings(env);
        if (typeof values['gstin'] === 'string') {
          const problem = gstinProblem(values['gstin'], current.state);
          if (problem !== null)
            throw new HttpProblem(422, 'invalid-gstin', 'Invalid GSTIN', problem);
        }
        await env.asSuperuser({ reason: 'GST settings' }, async (su) => {
          await su
            .model('res.company')
            .browse([env.companyRef])
            .write(values as never);
          await su.flush();
        });
        return { provider: provider?.name ?? null, ...(await readSettings(env)) };
      },
      { write: true },
    );
  });
}

/** The subscriber registering documents with the IRP when they are posted; tests `drain()` it, the server starts it. */
export function einvoiceWorker(
  context: Pick<ModuleContext, 'shutro'>,
  provider: GstProvider,
): Worker {
  return context.shutro.subscribe(
    'l10n_in.einvoice',
    'account.move.posted',
    async (event, env) => {
      const id = Number((event.payload as { id?: unknown } | null)?.id);
      if (Number.isInteger(id) && id > 0) await registerPosted(env as unknown as Env, provider, id);
    },
    { pollMs: 5000 },
  );
}
