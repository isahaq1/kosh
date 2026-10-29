/**
 * The companies (RFC 0018, RFC 0019 §3.4). The current company's name, number grouping and brand colour (the
 * back-office's accent), and its details: every simple field the installed apps add to the company (address,
 * contacts, tax ids, fiscal year…). Administrators and holders of the Settings / Company access level change them;
 * administrators also add companies, whose defaults (journals, sequences, taxes…) the apps then install.
 *
 * - `GET   /api/v1/settings/company`
 * - `PATCH /api/v1/settings/company`     `{ name?, numberGrouping?, accentColor?, details? }` (`accentColor`:
 *                                         `#rrggbb` or null; `details`: `{ field: value }`)
 * - `GET   /api/v1/settings/companies`   every company with its currency and people, the currencies
 * - `POST  /api/v1/settings/companies`   `{ name, currency }`: a new company (administrators)
 */
import {
  type ApiField,
  audit,
  HttpProblem,
  installDefaults,
  type ModuleContext,
  publicApiModels,
} from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import type { FastifyRequest } from 'fastify';

type Row = Record<string, unknown>;
interface Rows {
  readonly length: number;
  readonly ids: readonly number[];
  load(keys: readonly string[]): Promise<Rows>;
  read(keys: readonly string[]): Row[];
  write(values: Row): Promise<void>;
}
interface Model {
  browse(ids: readonly number[]): Rows;
  search(query: unknown): Promise<Rows>;
  create(rows: readonly Row[]): Promise<Rows>;
}
const model = (env: Env, name: string) => env.model(name as never) as unknown as Model;
const find = async (env: Env, name: string, where: unknown, keys: readonly string[]) => {
  const set = await model(env, name).search({ where, order: ['id asc'] });
  return set.length === 0 ? [] : (await set.load(keys)).read(['id', ...keys]);
};

const KEYS = ['name', 'numberGrouping', 'accentColor', 'currency'] as const;
/** Fields with controls of their own, or not the person's to edit. */
const OWN = new Set<string>([...KEYS, 'id', 'displayName']);
const SIMPLE = new Set(['char', 'text', 'integer', 'boolean', 'selection']);
/** Shown, not changed here: an app's own flow sets them (the chart of accounts of a localization). */
const SHOWN_ONLY = new Set(['chartTemplate']);

/** One of the company's details: a field an installed app adds. */
export interface CompanyDetail {
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly readonly: boolean;
  readonly options: readonly { readonly value: string; readonly label: string }[] | null;
  readonly value: string | number | boolean | null;
}

export interface CompanySettings {
  readonly id: number;
  readonly name: string;
  readonly numberGrouping: 'international' | 'lakh';
  readonly accentColor: string | null;
  readonly currency: string;
  readonly details: readonly CompanyDetail[];
}

export function registerCompanyRoutes(context: ModuleContext): void {
  const { app, registry } = context;
  /** The company's details: its stored simple fields, as the generated API serves them. */
  const detailFields = (): ApiField[] =>
    (publicApiModels(registry).get('res.company')?.fields ?? []).filter(
      (f) => f.stored && SIMPLE.has(f.kind) && !OWN.has(f.key),
    );

  const read = async (env: Env, id: number): Promise<CompanySettings> => {
    const fields = detailFields();
    const keys = [...KEYS, ...fields.map((f) => f.key)];
    const [row] = (await model(env, 'res.company').browse([id]).load(keys)).read(['id', ...keys]);
    const currency = row?.['currency'];
    const [money] =
      typeof currency === 'number'
        ? await find(env, 'res.currency', { id: currency }, ['name'])
        : [];
    return {
      id,
      name: String(row?.['name'] ?? ''),
      numberGrouping: row?.['numberGrouping'] === 'lakh' ? 'lakh' : 'international',
      accentColor: typeof row?.['accentColor'] === 'string' ? row['accentColor'] : null,
      currency: String(money?.['name'] ?? ''),
      details: fields.map((f) => ({
        key: f.key,
        label: f.label,
        kind: f.kind,
        readonly: f.readonly || SHOWN_ONLY.has(f.key),
        options: f.options?.map((o) => ({ value: String(o[0]), label: String(o[1]) })) ?? null,
        value: (row?.[f.key] ?? null) as CompanyDetail['value'],
      })),
    };
  };

  const guarded = <T>(
    request: FastifyRequest,
    fn: (env: Env, company: number, user: Env) => Promise<T>,
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
          const out = await fn(su, env.companyId as number, env);
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
    const body = (request.body ?? {}) as Row;
    const values: Row = {};
    const invalid = (code: string, title: string, detail: string) =>
      new HttpProblem(422, code, title, detail);
    if (body['name'] !== undefined) {
      const name = String(body['name']).trim();
      if (name === '') throw invalid('invalid-name', 'Invalid name', 'The company needs a name.');
      values['name'] = name;
    }
    if (body['numberGrouping'] !== undefined) {
      if (body['numberGrouping'] !== 'international' && body['numberGrouping'] !== 'lakh')
        throw invalid(
          'invalid-grouping',
          'Invalid grouping',
          "Number grouping is 'international' or 'lakh'.",
        );
      values['numberGrouping'] = body['numberGrouping'];
    }
    if (body['accentColor'] !== undefined) {
      const color = body['accentColor'];
      if (color !== null && !(typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)))
        throw invalid(
          'invalid-color',
          'Invalid colour',
          'The brand colour is a hex colour such as #4f46e5, or empty for the default.',
        );
      values['accentColor'] = color === null ? null : color.toLowerCase();
    }
    // The details: only the fields offered, each with a value of its kind (Shutro checks sizes and constraints).
    const details = body['details'];
    if (details !== undefined) {
      if (typeof details !== 'object' || details === null || Array.isArray(details))
        throw invalid('invalid-details', 'Invalid details', 'details is { field: value }.');
      const offered = new Map(detailFields().map((f) => [f.key, f]));
      for (const [key, value] of Object.entries(details as Row)) {
        const f = offered.get(key);
        if (f === undefined || f.readonly || SHOWN_ONLY.has(key))
          throw invalid('invalid-details', 'Invalid details', `'${key}' is not changed here.`);
        const fits =
          value === null ||
          (f.kind === 'boolean'
            ? typeof value === 'boolean'
            : f.kind === 'integer'
              ? Number.isSafeInteger(value)
              : f.kind === 'selection'
                ? (f.options ?? []).some((o) => o[0] === value)
                : typeof value === 'string' && value.length <= 4000);
        if (!fits)
          throw invalid('invalid-details', 'Invalid details', `'${f.label}' has an invalid value.`);
        values[key] = typeof value === 'string' && value.trim() === '' ? null : value;
      }
    }
    return guarded(
      request,
      async (su, company) => {
        if (Object.keys(values).length > 0)
          await model(su, 'res.company').browse([company]).write(values);
        return read(su, company);
      },
      true,
    );
  });

  app.get('/api/v1/settings/companies', async (request) =>
    guarded(request, async (su, current, env) => {
      const all = await find(su, 'res.company', {}, ['name', 'currency']);
      const currencies = await find(su, 'res.currency', {}, ['name']);
      const currencyName = new Map(currencies.map((c) => [c['id'], String(c['name'])]));
      return {
        canCreate: env.administrator,
        companies: (
          await Promise.all(
            all.map(async (c) => ({
              id: c['id'] as number,
              name: String(c['name']),
              currency: currencyName.get(c['currency']) ?? '',
              people: (
                await model(su, 'res.users').search({
                  where: { isService: { ne: true }, companies: { any: { id: c['id'] } } },
                })
              ).length,
              current: c['id'] === current,
              // The person can switch to it: it is one of their companies.
              member:
                (
                  await model(su, 'res.users').search({
                    where: { id: env.uid, companies: { any: { id: c['id'] } } },
                  })
                ).length > 0,
            })),
          )
        ).sort((a, b) => a.name.localeCompare(b.name)),
        currencies: currencies
          .map((c) => ({ id: c['id'] as number, name: String(c['name']) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    }),
  );

  app.post('/api/v1/settings/companies', async (request, reply) => {
    const body = (request.body ?? {}) as Row;
    const name = String(body['name'] ?? '').trim();
    const currency = Number(body['currency']);
    if (name === '' || name.length > 200)
      throw new HttpProblem(422, 'invalid-name', 'Invalid name', 'The company needs a name.');
    if (!Number.isSafeInteger(currency) || currency <= 0)
      throw new HttpProblem(422, 'invalid-currency', 'Invalid currency', 'Choose its currency.');
    const made = await request.env(
      async (env) => {
        if (!env.administrator)
          throw new HttpProblem(
            403,
            'access',
            'Administrators only',
            'Only an administrator adds companies.',
          );
        return env.asSuperuser({ reason: 'new company' }, async (su) => {
          if ((await find(su, 'res.currency', { id: currency }, ['name'])).length === 0)
            throw new HttpProblem(
              422,
              'invalid-currency',
              'Invalid currency',
              'Choose its currency.',
            );
          const company = (await model(su, 'res.company').create([{ name, currency }]))
            .ids[0] as number;
          // The administrators and the person who made it can switch to it at once.
          const admins = [...su.access.administratorGroups()];
          const holders =
            admins.length === 0
              ? []
              : await find(su, 'auth.user_group', { group: { in: admins } }, ['user']);
          const users = [...new Set([env.uid, ...holders.map((h) => h['user'] as number)])];
          await model(su, 'res.users')
            .browse(users)
            .write({ companies: { link: [company] } });
          await audit(env, {
            kind: 'settings.company_created',
            summary: `Company ${name} created.`,
            targetModel: 'res.company',
            targetId: company,
            ip: request.ip,
          });
          await su.flush();
          return { company, users };
        });
      },
      { write: true },
    );
    for (const user of made.users) context.auth?.forget(user);
    // The apps' defaults for it, once it exists (after the commit), as for a company made at install.
    const defaults = await installDefaults(context.shutro, registry.loaded.modules, {
      company: made.company,
      reason: `defaults of company ${name}`,
    });
    return reply.code(201).send({ id: made.company, name, defaults });
  });
}
