/**
 * A read-only client of Odoo's external API (JSON-RPC at `/jsonrpc`), versions 16 to 18: sign in with a login and a
 * password or an API key, read a model's field definitions, and read its records in pages ordered by id —
 * archived ones included. Nothing is ever written to Odoo, and no module needs to be installed in it.
 */

export interface OdooConnection {
  /** The Odoo address, e.g. `https://erp.example.com`. */
  readonly url: string;
  readonly db: string;
  readonly login: string;
  /** A password or, better, an API key of a user who can read what is imported. */
  readonly password: string;
  /** The HTTP client (tests, recordings). */
  readonly fetch?: typeof fetch;
}

/** An Odoo field definition, as `fields_get` gives it. */
export interface OdooField {
  readonly type: string;
  readonly string: string;
  readonly relation?: string;
  readonly selection?: readonly (readonly [string, string])[];
  readonly store?: boolean;
}

export type OdooValue = string | number | boolean | null | readonly unknown[];
export type OdooRecord = Readonly<Record<string, OdooValue>> & { readonly id: number };

/** An Odoo answer that is an error (access, a missing model, a bad domain). */
export class OdooError extends Error {
  constructor(
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'OdooError';
  }
}

export interface OdooClient {
  /** Odoo's version (`18.0`), and its major number. */
  readonly version: string;
  readonly major: number;
  readonly uid: number;
  /** The model's fields (`fields_get`), or null when the model is not installed in Odoo. */
  fields(model: string): Promise<Readonly<Record<string, OdooField>> | null>;
  /** Every record of `model` matching `domain`, `fields` only, in pages of `page` ordered by id. */
  readAll(
    model: string,
    fields: readonly string[],
    options?: { readonly domain?: readonly unknown[]; readonly page?: number },
  ): Promise<OdooRecord[]>;
  /** The external ids (`module.name`) Odoo gives records of `model`, by id. */
  externalIds(model: string): Promise<ReadonlyMap<number, string>>;
}

/** Signs in to Odoo and returns a client; refuses wrong credentials or an unknown database. */
export async function connectOdoo(connection: OdooConnection): Promise<OdooClient> {
  const http = connection.fetch ?? fetch;
  const endpoint = `${connection.url.replace(/\/$/, '')}/jsonrpc`;
  let next = 1;
  const call = async (
    service: string,
    method: string,
    args: readonly unknown[],
  ): Promise<unknown> => {
    const res = await http(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: { service, method, args },
        id: next++,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new OdooError(`Odoo answered HTTP ${res.status} at ${endpoint}.`);
    const answer = (await res.json()) as {
      result?: unknown;
      error?: { message?: string; data?: { message?: string } };
    };
    if (answer.error !== undefined)
      throw new OdooError(
        answer.error.data?.message || answer.error.message || 'Odoo refused the call.',
        answer.error,
      );
    return answer.result;
  };

  const info = (await call('common', 'version', [])) as { server_version?: string };
  const version = info.server_version ?? '';
  const major = Number.parseInt(version, 10);
  const uid = await call('common', 'authenticate', [
    connection.db,
    connection.login,
    connection.password,
    {},
  ]);
  if (typeof uid !== 'number' || uid <= 0)
    throw new OdooError(
      `Odoo refused the sign-in of ${connection.login} to the database ${connection.db}.`,
    );
  const execute = (
    model: string,
    method: string,
    args: readonly unknown[],
    kwargs: Record<string, unknown> = {},
  ) =>
    call('object', 'execute_kw', [
      connection.db,
      uid,
      connection.password,
      model,
      method,
      args,
      kwargs,
    ]);
  const context = { active_test: false, lang: 'en_US' };

  return {
    version,
    major,
    uid,
    async fields(model) {
      try {
        return (await execute(model, 'fields_get', [], {
          attributes: ['type', 'string', 'relation', 'selection', 'store'],
          context,
        })) as Record<string, OdooField>;
      } catch (error) {
        if (
          error instanceof OdooError &&
          /doesn't exist|does not exist|not found/i.test(error.message)
        )
          return null;
        throw error;
      }
    },
    async readAll(model, fields, options = {}) {
      const page = options.page ?? 500;
      const out: OdooRecord[] = [];
      let last = 0;
      for (;;) {
        const rows = (await execute(
          model,
          'search_read',
          [[...(options.domain ?? []), ['id', '>', last]]],
          {
            fields: [...fields],
            order: 'id asc',
            limit: page,
            context,
          },
        )) as OdooRecord[];
        out.push(...rows);
        if (rows.length < page) return out;
        last = (rows.at(-1) as OdooRecord).id;
      }
    },
    async externalIds(model) {
      const rows = (await execute('ir.model.data', 'search_read', [[['model', '=', model]]], {
        fields: ['module', 'name', 'res_id'],
        context,
      })) as { module: string; name: string; res_id: number }[];
      return new Map(rows.map((r) => [r.res_id, `${r.module}.${r.name}`]));
    },
  };
}

/** The id of a many2one value (`[7, "Name"]` or `false`). */
export const idOf = (value: OdooValue | undefined): number | null =>
  Array.isArray(value) && typeof value[0] === 'number' ? value[0] : null;
/** The ids of an x2many value. */
export const idsOf = (value: OdooValue | undefined): number[] =>
  Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
/** A char value: Odoo says `false` for empty. */
export const textOf = (value: OdooValue | undefined): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
