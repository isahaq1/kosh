/**
 * The current company's settings (RFC 0018): its name, number grouping and brand colour (the back-office's accent).
 * Administrators and holders of the Settings / Company access level change them.
 *
 * - `GET   /api/v1/settings/company`
 * - `PATCH /api/v1/settings/company`   `{ name?, numberGrouping?, accentColor? }` (`accentColor`: `#rrggbb` or null)
 */
import { HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import type { FastifyRequest } from 'fastify';

interface Rows {
  readonly length: number;
  load(keys: readonly string[]): Promise<Rows>;
  read(keys: readonly string[]): Record<string, unknown>[];
  write(values: Record<string, unknown>): Promise<void>;
}
const companies = (env: Env) =>
  env.model('res.company' as never) as unknown as { browse(ids: readonly number[]): Rows };

const KEYS = ['name', 'numberGrouping', 'accentColor', 'currency'] as const;

export interface CompanySettings {
  readonly id: number;
  readonly name: string;
  readonly numberGrouping: 'international' | 'lakh';
  readonly accentColor: string | null;
}

async function read(env: Env, id: number): Promise<CompanySettings> {
  const [row] = (
    await companies(env)
      .browse([id])
      .load([...KEYS])
  ).read(['id', ...KEYS]);
  return {
    id,
    name: String(row?.['name'] ?? ''),
    numberGrouping: row?.['numberGrouping'] === 'lakh' ? 'lakh' : 'international',
    accentColor: typeof row?.['accentColor'] === 'string' ? row['accentColor'] : null,
  };
}

export function registerCompanyRoutes(context: ModuleContext): void {
  const { app } = context;
  const guarded = <T>(
    request: FastifyRequest,
    fn: (env: Env, company: number) => Promise<T>,
    write = false,
  ) =>
    request.env(
      async (env) => {
        if (!env.administrator && !env.groups.has('settings.company'))
          throw new HttpProblem(
            403,
            'access',
            'Company settings',
            'Changing the company needs the Administrator role or the Settings / Company access.',
          );
        if (env.companyId === null || env.companyId === undefined)
          throw new HttpProblem(409, 'no-company', 'No company', 'Choose a company first.');
        return env.asSuperuser({ reason: 'company settings' }, async (su) => {
          const out = await fn(su, env.companyId as number);
          if (write) await su.flush();
          return out;
        });
      },
      // The superuser scope is audited: even a read writes its audit record.
      { write: true },
    );

  app.get('/api/v1/settings/company', async (request) =>
    guarded(request, (su, company) => read(su, company)),
  );

  app.patch('/api/v1/settings/company', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const values: Record<string, unknown> = {};
    if (body['name'] !== undefined) {
      const name = String(body['name']).trim();
      if (name === '')
        throw new HttpProblem(422, 'invalid-name', 'Invalid name', 'The company needs a name.');
      values['name'] = name;
    }
    if (body['numberGrouping'] !== undefined) {
      if (body['numberGrouping'] !== 'international' && body['numberGrouping'] !== 'lakh')
        throw new HttpProblem(
          422,
          'invalid-grouping',
          'Invalid grouping',
          "Number grouping is 'international' or 'lakh'.",
        );
      values['numberGrouping'] = body['numberGrouping'];
    }
    if (body['accentColor'] !== undefined) {
      const color = body['accentColor'];
      if (color !== null && !(typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)))
        throw new HttpProblem(
          422,
          'invalid-color',
          'Invalid colour',
          'The brand colour is a hex colour such as #4f46e5, or empty for the default.',
        );
      values['accentColor'] = color === null ? null : color.toLowerCase();
    }
    return guarded(
      request,
      async (su, company) => {
        if (Object.keys(values).length > 0) await companies(su).browse([company]).write(values);
        return read(su, company);
      },
      true,
    );
  });
}
